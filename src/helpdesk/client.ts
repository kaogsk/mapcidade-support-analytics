// Ticketing API client: paged OData reads with retry/backoff. Works against the real
// SaaS API or the fake one — the only thing it needs is a base URL, a token and `fetch`.
import type { SurveyResponsePayload, TicketPayload } from "./types.js";

/**
 * Parse an API date as an instant.
 *
 * TIMEZONE: the API returns dates NAIVE ("2026-08-03T20:00:08") and they are UTC,
 * not Brasília. Settled by probing the real API with `$orderby=lastUpdate asc&$top=1`:
 * `lastUpdate ge ...T20:00:00z` returned 20:00:08, while `ge ...T20:00:00-03:00`
 * returned nothing yet. Reading them as local time shifted every date by 3 hours.
 */
export function toInstant(s: string | null | undefined): Date | null {
  if (!s) return null;
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(s);
  const d = new Date(hasTz ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** DateTimeOffset literal for $filter. Lower-case 'z' is accepted; no zone is a 400. */
export function odataDate(d: Date | string): string {
  const instant = d instanceof Date ? d : new Date(d);
  return instant.toISOString().replace("Z", "z");
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** `(ownerTeam eq 'A' or ownerTeam eq 'B') and <field> ge <since>` */
export function buildTeamFilter(teams: string[], since: Date, field = "createdDate"): string {
  const teamClause = teams.map((t) => `ownerTeam eq ${q(t)}`).join(" or ");
  return `(${teamClause}) and ${field} ge ${odataDate(since)}`;
}

export const TICKET_SELECT = [
  "id", "subject", "status", "baseStatus", "category", "urgency", "origin", "serviceFirstLevel",
  "ownerTeam", "createdDate", "resolvedIn", "closedIn", "canceledIn", "reopenedIn",
  "slaResponseDate", "slaSolutionDate", "slaRealResponseDate", "lastUpdate",
  "resolvedInFirstCall", "lifeTimeWorkingTime",
].join(",");

export const TICKET_EXPAND = [
  "owner($select=id,businessName)",
  "clients($select=id,businessName,profileType;$expand=organization($select=id,businessName))",
  "actions($select=id,type,origin,createdDate,isDeleted;$expand=createdBy($select=id,profileType))",
  "statusHistories($select=status,justification,changedDate;$expand=changedBy($select=id,profileType))",
  "ownerHistories($expand=owner($select=id,businessName),changedBy($select=id,businessName))",
].join(",");

export class HelpdeskHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HelpdeskClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Pause between pages, to stay under the rate limit. */
  pageDelayMs?: number;
}

export type Endpoint = "tickets" | "tickets/past";
export const ENDPOINTS: Endpoint[] = ["tickets/past", "tickets"];

export class HelpdeskClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly pageDelayMs: number;
  /** Retries performed (429/5xx), for logs and tests. */
  retries = 0;
  requests = 0;

  constructor(opts: HelpdeskClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 5;
    this.pageDelayMs = opts.pageDelayMs ?? 0;
  }

  private url(endpoint: string, params: Record<string, string>): string {
    // The token travels as a query parameter (that is how the API authenticates).
    const qs = new URLSearchParams({ token: this.token, ...params });
    return `${this.baseUrl}/${endpoint}?${qs.toString()}`;
  }

  /**
   * GET with retry on 429 and 5xx. Honors Retry-After; otherwise exponential backoff
   * (1 s, 2 s, 4 s...). 404 resolves to null — "this ticket does not exist".
   */
  async getJson(endpoint: string, params: Record<string, string>): Promise<unknown> {
    const url = this.url(endpoint, params);
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const res = await this.fetchImpl(url);
      if (res.status === 429 || res.status >= 500) {
        const body = await res.text();
        if (attempt >= this.maxRetries) {
          throw new HelpdeskHttpError(res.status, `helpdesk ${res.status} after ${attempt} retries: ${body.slice(0, 200)}`);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
        this.retries++;
        await this.sleep(wait);
        continue;
      }
      if (res.status === 404) return null;
      const text = await res.text();
      if (!res.ok) throw new HelpdeskHttpError(res.status, `helpdesk ${res.status}: ${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new HelpdeskHttpError(res.status, `non-JSON response from helpdesk: ${text.slice(0, 120)}`);
      }
    }
  }

  /** Every page of tickets matching `filter` on one endpoint. */
  async *iterateTickets(opts: {
    endpoint?: Endpoint;
    filter: string;
    orderby?: string;
    pageSize?: number;
    select?: string;
    expand?: string;
  }): AsyncGenerator<TicketPayload[]> {
    const { endpoint = "tickets", filter, orderby = "createdDate desc", pageSize = 200 } = opts;
    const params: Record<string, string> = { $filter: filter, $orderby: orderby, $top: String(pageSize) };
    params.$select = opts.select ?? TICKET_SELECT;
    if (opts.expand !== "") params.$expand = opts.expand ?? TICKET_EXPAND;
    for (let skip = 0; ; ) {
      const page = await this.getJson(endpoint, { ...params, $skip: String(skip) });
      if (!Array.isArray(page) || page.length === 0) return;
      yield page as TicketPayload[];
      skip += page.length;
      if (page.length < pageSize) return;
      if (this.pageDelayMs) await this.sleep(this.pageDelayMs);
    }
  }

  /** One ticket by id, on either endpoint, regardless of team. null = does not exist. */
  async fetchTicket(id: number | string, select = "id,ownerTeam,baseStatus,lastUpdate"): Promise<TicketPayload | null> {
    for (const endpoint of ["tickets", "tickets/past"] as const) {
      const t = (await this.getJson(endpoint, { id: String(id), $select: select })) as TicketPayload | null;
      if (t && t.id != null) return t;
    }
    return null;
  }

  /**
   * Survey answers of one ticket. Listings always return the collection EMPTY; only
   * GET-by-id fills it — hence a separate, per-ticket enrichment step.
   */
  async fetchSurvey(id: number | string): Promise<SurveyResponsePayload[]> {
    for (const endpoint of ["tickets", "tickets/past"] as const) {
      const t = (await this.getJson(endpoint, { id: String(id), $select: "id", $expand: "satisfactionSurveyResponses" })) as TicketPayload | null;
      if (t) return Array.isArray(t.satisfactionSurveyResponses) ? t.satisfactionSurveyResponses : [];
    }
    return [];
  }
}
