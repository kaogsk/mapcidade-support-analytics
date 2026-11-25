// Fake ticketing API: same URL shape, query options, paging and failure modes as the
// SaaS helpdesk the real dashboard reads, backed by the synthetic world in world.ts.
//
// Same interface, different implementation: the sync service talks to it over plain
// HTTP (`fetch`) and cannot tell the difference. In tests, `fake.fetch` is handed to
// the client directly, so no socket is opened.
import type { RequestHandler } from "express";
import { evaluate, ODataError, parseFilter, parseOrderBy, topLevelNames } from "./odata.js";
import type { TicketPayload } from "./types.js";
import { materialize, type World } from "./world.js";

export const RECENT_WINDOW_DAYS = 90;
/** Where the API server mounts the fake (and the path prefix `fetch` strips). */
export const HELPDESK_MOUNT = "/helpdesk/v1";

const SCALAR_FIELDS = new Set([
  "id", "subject", "status", "baseStatus", "category", "urgency", "origin", "serviceFirstLevel",
  "ownerTeam", "createdDate", "resolvedIn", "closedIn", "canceledIn", "reopenedIn",
  "slaResponseDate", "slaSolutionDate", "slaRealResponseDate", "lastUpdate",
  "resolvedInFirstCall", "lifeTimeWorkingTime",
]);
const NAV_FIELDS = new Set(["owner", "clients", "actions", "statusHistories", "ownerHistories", "satisfactionSurveyResponses"]);

export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeHelpdeskOptions {
  world: World;
  token: string;
  /** Base clock (ms). The simulated clock is this plus whatever `advance` added. */
  clock?: () => number;
  /** Token bucket; null disables rate limiting. */
  rateLimit?: { perSecond: number; burst: number } | null;
  /** Probability of answering 503 to a request (fault injection). */
  failureRate?: number;
  random?: () => number;
  maxTop?: number;
}

export class FakeHelpdesk {
  readonly world: World;
  private readonly token: string;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly maxTop: number;
  private offsetMs = 0;
  private bucket: { tokens: number; at: number } | null;
  rateLimit: { perSecond: number; burst: number } | null;
  failureRate: number;
  /** Requests served, by status — handy to assert on retries in tests. */
  readonly stats = { requests: 0, byStatus: {} as Record<number, number> };
  private cache: { key: number; tickets: TicketPayload[] } | null = null;

  constructor(opts: FakeHelpdeskOptions) {
    this.world = opts.world;
    this.token = opts.token;
    this.clock = opts.clock ?? Date.now;
    this.rateLimit = opts.rateLimit ?? null;
    this.failureRate = opts.failureRate ?? 0;
    this.random = opts.random ?? Math.random;
    this.maxTop = opts.maxTop ?? 1000;
    this.bucket = this.rateLimit ? { tokens: this.rateLimit.burst, at: this.clock() } : null;
  }

  now(): number {
    return this.clock() + this.offsetMs;
  }

  /** Move the simulated clock forward. */
  advance(minutes: number): void {
    this.offsetMs += Math.max(0, minutes) * 60_000;
    this.cache = null;
  }

  /** Every ticket that exists right now (deleted ones excluded), full payload. */
  snapshot(): TicketPayload[] {
    const now = this.now();
    const key = Math.floor(now / 1000);
    if (this.cache?.key !== key) {
      const tickets: TicketPayload[] = [];
      for (const t of this.world.tickets) {
        const p = materialize(t, now);
        if (p) tickets.push(p);
      }
      this.cache = { key, tickets };
    }
    return this.cache.tickets;
  }

  private take(): boolean {
    if (!this.rateLimit || !this.bucket) return true;
    const t = this.clock();
    const refill = ((t - this.bucket.at) / 1000) * this.rateLimit.perSecond;
    this.bucket = { tokens: Math.min(this.rateLimit.burst, this.bucket.tokens + refill), at: t };
    if (this.bucket.tokens < 1) return false;
    this.bucket.tokens -= 1;
    return true;
  }

  handle(method: string, pathAndQuery: string): FakeResponse {
    const res = this.route(method, pathAndQuery);
    this.stats.requests++;
    this.stats.byStatus[res.status] = (this.stats.byStatus[res.status] ?? 0) + 1;
    return res;
  }

  private route(method: string, pathAndQuery: string): FakeResponse {
    const url = new URL(pathAndQuery, "http://helpdesk.invalid");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse => ({ status, headers, body });

    if (q.get("token") !== this.token) return json(401, { message: "Invalid or missing token" });
    if (!this.take()) return json(429, { message: "Too many requests" }, { "Retry-After": "1" });
    if (this.failureRate > 0 && this.random() < this.failureRate) return json(503, { message: "Service unavailable" });

    if (path === "/_sim/clock" && method === "GET") {
      return json(200, { now: new Date(this.now()).toISOString(), offsetMinutes: Math.round(this.offsetMs / 60_000) });
    }
    if (path === "/_sim/advance" && method === "POST") {
      const minutes = Number(q.get("minutes"));
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60 * 24 * 30) return json(400, { message: "minutes must be in (0, 43200]" });
      this.advance(minutes);
      return json(200, { now: new Date(this.now()).toISOString(), offsetMinutes: Math.round(this.offsetMs / 60_000) });
    }
    if ((path === "/tickets" || path === "/tickets/past") && method === "GET") {
      try {
        return this.tickets(path === "/tickets/past", q);
      } catch (err) {
        if (err instanceof ODataError) return json(err.status, { message: err.message });
        throw err;
      }
    }
    return json(404, { message: `No route for ${method} ${path}` });
  }

  private tickets(past: boolean, q: URLSearchParams): FakeResponse {
    const cutoff = this.now() - RECENT_WINDOW_DAYS * 86_400_000;
    const inRoute = (t: TicketPayload) => {
      const lu = new Date(`${t.lastUpdate}Z`).getTime();
      return past ? lu < cutoff : lu >= cutoff;
    };
    const select = topLevelNames(q.get("$select"));
    const expand = topLevelNames(q.get("$expand"));
    for (const s of select) if (!SCALAR_FIELDS.has(s)) throw new ODataError(`Could not find a property named '${s}'`);
    for (const e of expand) if (!NAV_FIELDS.has(e)) throw new ODataError(`Could not find a navigation property named '${e}'`);

    const id = q.get("id");
    if (id != null) {
      const t = this.snapshot().find((x) => String(x.id) === id && inRoute(x));
      if (!t) return { status: 404, headers: {}, body: { message: "Ticket not found" } };
      return { status: 200, headers: {}, body: project(t, select, expand, true) };
    }

    const filter = q.get("$filter");
    const ast = filter ? parseFilter(filter) : null;
    const order = parseOrderBy(q.get("$orderby"));
    const top = q.has("$top") ? Number(q.get("$top")) : 100;
    const skip = q.has("$skip") ? Number(q.get("$skip")) : 0;
    if (!Number.isInteger(top) || top < 1 || top > this.maxTop) throw new ODataError(`$top must be an integer in [1, ${this.maxTop}]`);
    if (!Number.isInteger(skip) || skip < 0) throw new ODataError("$skip must be a non-negative integer");

    let rows = this.snapshot().filter(inRoute);
    if (ast) rows = rows.filter((t) => evaluate(ast, t as unknown as Record<string, unknown>));
    if (order) {
      if (!SCALAR_FIELDS.has(order.field)) throw new ODataError(`Could not find a property named '${order.field}'`);
      const key = (t: TicketPayload) => (t as unknown as Record<string, unknown>)[order.field] as string | number | null;
      rows = [...rows].sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        const c = ka == null ? (kb == null ? 0 : -1) : kb == null ? 1 : ka < kb ? -1 : ka > kb ? 1 : 0;
        return (order.desc ? -c : c) || a.id - b.id;
      });
    } else {
      rows = [...rows].sort((a, b) => a.id - b.id);
    }
    const page = rows.slice(skip, skip + top).map((t) => project(t, select, expand, false));
    return { status: 200, headers: {}, body: page };
  }

  /** `fetch`-compatible entry point (no network). */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    const i = u.pathname.indexOf(HELPDESK_MOUNT);
    const path = i >= 0 ? u.pathname.slice(i + HELPDESK_MOUNT.length) : u.pathname;
    const r = this.handle(init?.method ?? "GET", `${path}${u.search}`);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  };
}

/** Apply $select / $expand. Listings never carry survey answers (API limitation). */
function project(t: TicketPayload, select: string[], expand: string[], byId: boolean): Record<string, unknown> {
  const src = t as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { id: t.id };
  const scalars = select.length ? select : [...SCALAR_FIELDS];
  for (const s of scalars) out[s] = src[s] ?? null;
  for (const e of expand) {
    out[e] = e === "satisfactionSurveyResponses" && !byId ? [] : structuredClone(src[e] ?? null);
  }
  return out;
}

/** Express adapter: mount with `app.use(HELPDESK_MOUNT, helpdeskMiddleware(fake))`. */
export function helpdeskMiddleware(fake: FakeHelpdesk): RequestHandler {
  return (req, res) => {
    const r = fake.handle(req.method, req.url);
    res.status(r.status).set(r.headers).json(r.body);
  };
}
