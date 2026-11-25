// Raw ticket payload -> one row of the mirror. Pure functions only: every rule that
// decides a number on the dashboard (who is the customer, when was the first reply,
// was it reopened by the customer) is decided here, at ingest, and unit-tested.
import { toInstant } from "../helpdesk/client.js";
import type { ActionPayload, ClientRef, StatusHistoryPayload, SurveyResponsePayload, TicketPayload } from "../helpdesk/types.js";

const SMALL_WORDS = new Set(["of", "the", "and", "de", "do", "da"]);
const PREFIX_RE = /^\s*(city\s+hall\s+of|city\s+council\s+of|municipality\s+of|town\s+of|city\s+of)\s+/i;

/** "CITY HALL OF CEDAR LANTERN" -> "Cedar Lantern". */
export function normalizeCity(rawOrgName: string | null | undefined): string | null {
  if (!rawOrgName) return null;
  const raw = String(rawOrgName).trim();
  const s = raw.replace(PREFIX_RE, "").trim();
  if (!s) return raw;
  return s
    .toLocaleLowerCase("en-US")
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toLocaleUpperCase("en-US") + w.slice(1)))
    .join(" ");
}

const isVendor = (name: string | null | undefined) => /mapcidade/i.test(name ?? "");
const looksMunicipal = (name: string | null | undefined) => /city hall|municipality|council|town of|city of/i.test(name ?? "");

/**
 * The customer organization (= the city served). Vendor staff copied on a ticket are
 * ignored; among several candidates, the one that looks like a municipality wins.
 */
export function extractCity(clients: ClientRef[] | null | undefined): { organizationName: string | null; city: string | null } {
  const candidates: string[] = [];
  for (const c of clients ?? []) {
    const org = c.organization?.businessName;
    if (org && !isVendor(org)) candidates.push(org);
    if (!c.organization && c.businessName && !isVendor(c.businessName) && looksMunicipal(c.businessName)) candidates.push(c.businessName);
  }
  if (candidates.length === 0) return { organizationName: null, city: null };
  const chosen = candidates.find(looksMunicipal) ?? candidates[0];
  return { organizationName: chosen, city: normalizeCity(chosen) };
}

/** profileType 1/3 = agent, 2 = customer, missing = system. */
const AGENT_PROFILES = new Set([1, 3]);
/**
 * Action origins posted by automation using the agent's own account (API, trigger,
 * system e-mail, scheduler). Public and "by an agent", but nobody answered anything.
 */
export const AUTOMATED_ORIGINS = new Set([4, 7, 9, 10]);

/**
 * First response = first PUBLIC, non-deleted action by an AGENT, by a human (not an
 * automated origin), at or after creation. The helpdesk's own `slaRealResponseDate`
 * also counts internal notes and auto-acknowledgements, so the two disagree on a large
 * share of tickets — both are stored, ours drives the SLA card.
 */
export function extractFirstResponse(actions: ActionPayload[] | null | undefined, createdDate: string | null | undefined): Date | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const createdMs = toInstant(createdDate)?.getTime() ?? -Infinity;
  let best: number | null = null;
  for (const a of actions) {
    if (a.type !== 2 || a.isDeleted) continue;
    if (!AGENT_PROFILES.has(a.createdBy?.profileType ?? -1)) continue;
    if (AUTOMATED_ORIGINS.has(a.origin)) continue;
    const ms = toInstant(a.createdDate)?.getTime();
    if (ms == null || ms < createdMs) continue;
    if (best == null || ms < best) best = ms;
  }
  return best == null ? null : new Date(best);
}

/** Latest numeric 0-10 survey answer. Its date is naive UTC like every other date. */
export function extractRating(responses: SurveyResponsePayload[] | null | undefined): { score: number; at: Date | null } | null {
  let best: { score: number; at: Date | null } | null = null;
  for (const r of responses ?? []) {
    const score = r?.satisfactionSurveyNetPromoterScoreResponse;
    if (typeof score !== "number") continue;
    const at = toInstant(r.responseDate);
    if (!best || (at && (!best.at || at > best.at))) best = { score, at };
  }
  return best;
}

export interface OwnerStep {
  at: string | null;
  team: string | null;
  owner_id: string | null;
  owner: string | null;
  by: string | null;
}

/** Ownership trail (team + analyst + who moved it), chronological. null = not expanded. */
export function mapOwnerHistory(histories: TicketPayload["ownerHistories"]): OwnerStep[] | null {
  if (!Array.isArray(histories)) return null;
  return histories
    .map((h) => ({
      at: toInstant(h.changedDate)?.toISOString() ?? null,
      team: h.ownerTeam ?? null,
      owner_id: h.owner?.id ?? null,
      owner: h.owner?.businessName ?? null,
      by: h.changedBy?.businessName ?? null,
    }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const CLOSED_TEXT = /^(resolved|closed)/i;
const TERMINAL_TEXT = /^(resolved|closed|canceled|cancelled)/i;

/**
 * Was the ticket reopened BY THE CUSTOMER? `reopenedIn` is stamped on every reopen —
 * including the analyst reopening it only to log hours or fix a typo (about 1 in 6
 * reopens in the real data). A reopen counts when some status change from
 * Resolved/Closed back to an open status was made by one of the ticket's contacts or
 * by anyone with the customer profile. System changes (no author) never count.
 *
 * Without author information at all (old rows), fall back to `reopenedIn` so the
 * number does not silently drop to zero.
 */
export function reopenedByClient(t: Pick<TicketPayload, "reopenedIn" | "statusHistories" | "clients">): boolean {
  if (!t.reopenedIn) return false;
  const hist: StatusHistoryPayload[] = Array.isArray(t.statusHistories) ? t.statusHistories : [];
  if (!hist.some((h) => h && "changedBy" in h)) return true;
  const clientIds = new Set((t.clients ?? []).map((c) => String(c.id)));
  const sorted = [...hist].sort((a, b) => String(a.changedDate).localeCompare(String(b.changedDate)));
  for (let i = 1; i < sorted.length; i++) {
    const prev = String(sorted[i - 1].status ?? "").trim();
    const cur = String(sorted[i].status ?? "").trim();
    if (!CLOSED_TEXT.test(prev) || TERMINAL_TEXT.test(cur)) continue;
    const by = sorted[i].changedBy;
    if (!by) continue;
    if (by.profileType === 2 || clientIds.has(String(by.id))) return true;
  }
  return false;
}

export interface TicketRow {
  id: number;
  subject: string | null;
  status: string | null;
  base_status: string | null;
  category: string | null;
  urgency: string | null;
  origin: number | null;
  service: string | null;
  owner_id: string | null;
  owner_name: string | null;
  team: string | null;
  current_team: string | null;
  city: string | null;
  organization_name: string | null;
  created_date: string | null;
  first_response_date: string | null;
  sla_real_response_date: string | null;
  resolved_in: string | null;
  closed_in: string | null;
  canceled_in: string | null;
  reopened_in: string | null;
  reopened_by_client: number;
  sla_response_date: string | null;
  sla_solution_date: string | null;
  last_update: string | null;
  resolved_in_first_call: number | null;
  life_time_working_time: number | null;
  owner_history: string | null;
  raw_payload: string;
}

const iso = (s: string | null | undefined) => toInstant(s)?.toISOString() ?? null;
const trimOrNull = (v: unknown) => (v == null ? null : String(v).trim() || null);

export function mapTicket(t: TicketPayload): TicketRow {
  const { organizationName, city } = extractCity(t.clients);
  const history = mapOwnerHistory(t.ownerHistories);
  return {
    id: Number(t.id),
    subject: trimOrNull(t.subject),
    status: t.status ?? null,
    base_status: t.baseStatus ?? null,
    category: trimOrNull(t.category), // arrives with stray spaces
    urgency: t.urgency ?? null,
    origin: Number.isFinite(t.origin) ? (t.origin as number) : null,
    service: canonicalService(t.serviceFirstLevel), // raw value stays in raw_payload
    owner_id: t.owner?.id ?? null,
    owner_name: t.owner?.businessName ?? null,
    // Proposed credited team: the upsert decides whether to accept it (see repo.ts).
    team: t.ownerTeam ?? null,
    current_team: t.ownerTeam ?? null,
    city,
    organization_name: organizationName,
    created_date: iso(t.createdDate),
    first_response_date: extractFirstResponse(t.actions, t.createdDate)?.toISOString() ?? null,
    sla_real_response_date: iso(t.slaRealResponseDate),
    resolved_in: iso(t.resolvedIn),
    closed_in: iso(t.closedIn),
    canceled_in: iso(t.canceledIn),
    reopened_in: iso(t.reopenedIn),
    reopened_by_client: reopenedByClient(t) ? 1 : 0,
    sla_response_date: iso(t.slaResponseDate),
    sla_solution_date: iso(t.slaSolutionDate),
    last_update: iso(t.lastUpdate),
    resolved_in_first_call: typeof t.resolvedInFirstCall === "boolean" ? Number(t.resolvedInFirstCall) : null,
    life_time_working_time: Number.isFinite(t.lifeTimeWorkingTime) ? (t.lifeTimeWorkingTime as number) : null,
    owner_history: history ? JSON.stringify(history) : null,
    raw_payload: JSON.stringify(t),
  };
}

/** Service aliases: "GISWeb" (onboarding projects) is the same product as "GIS Viewer". */
const SERVICE_ALIASES: Record<string, string> = { GISWeb: "GIS Viewer" };
export function canonicalService(raw: string | null | undefined): string | null {
  const s = raw == null ? "" : String(raw).trim();
  return s ? (SERVICE_ALIASES[s] ?? s) : null;
}
