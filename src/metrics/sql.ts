// SQL fragments shared by every metric. Each concept lives in exactly one place so that
// a card and the drill-down list behind it can never disagree about what they count.
//
// The flow model (every screen, every team): ENTRY = opened in the period (by
// created_date), EXIT = concluded in the period (by conclusion date, including tickets
// opened before the period), NOW = the open queue at this instant.
import { METRICS_TEAMS, SYNCED_TEAMS } from "../config.js";

export const OPEN = "base_status IN ('New','InAttendance','Stopped')";

/**
 * When the ticket was concluded: the resolution, or the close for tickets that went
 * straight to Closed without passing through Resolved.
 */
export const CONCLUDED_AT = "coalesce(resolved_in, closed_in)";

/**
 * "Is concluded today". Goes together with CONCLUDED_AT so that a ticket resolved and
 * then REOPENED (resolved_in filled, status open again) is not counted as an exit.
 */
export const IS_CONCLUDED = "base_status IN ('Resolved','Closed')";

/** Period by creation date. Bounds are `$from` (inclusive) and `$to` (exclusive). */
export const CREATED_IN = "created_date >= $from AND created_date < $to";
/** Period by conclusion date. */
export const CONCLUDED_IN = `${CONCLUDED_AT} >= $from AND ${CONCLUDED_AT} < $to AND ${IS_CONCLUDED}`;

/** `current_team` in a JSON list parameter (SQLite has no arrays). */
export const inTeams = (param = "$teams") => `current_team IN (SELECT value FROM json_each(${param}))`;

/** Hours / minutes between two ISO timestamp columns. */
export const hoursBetween = (a: string, b: string) => `((julianday(${a}) - julianday(${b})) * 24.0)`;
export const minutesBetween = (a: string, b: string) => `((julianday(${a}) - julianday(${b})) * 1440.0)`;

/** Brasília calendar day of an instant column — NOT the UTC day (see time/brt.ts). */
export const brDayOf = (col: string) => `date(${col}, '-3 hours')`;

/** Age in days of an open ticket at `$now`. */
export const AGE_DAYS = "(julianday($now) - julianday(created_date))";

/** SLA predicates. Solution SLA is judged on resolved tickets only (the helpdesk rule). */
export const SLA_WITH = "resolved_in IS NOT NULL AND sla_solution_date IS NOT NULL";
export const SLA_IN = `${SLA_WITH} AND resolved_in <= sla_solution_date`;
export const SLA_BREACHED = `${SLA_WITH} AND resolved_in > sla_solution_date`;

/**
 * Response SLA. A ticket still unanswered whose deadline has ALREADY passed is a breach
 * too — counting only answered tickets made a team that ignores its queue look perfect.
 */
export const RESP_ANSWERED = "first_response_date IS NOT NULL AND base_status <> 'Canceled'";
export const RESP_WITH = `base_status <> 'Canceled' AND sla_response_date IS NOT NULL AND (first_response_date IS NOT NULL OR sla_response_date < $now)`;
export const RESP_IN = `${RESP_ANSWERED} AND sla_response_date IS NOT NULL AND first_response_date <= sla_response_date`;
export const RESP_BREACHED = `${RESP_WITH} AND NOT (${RESP_IN})`;
export const NO_RESPONSE = "first_response_date IS NULL AND base_status <> 'Canceled'";

// ── Status buckets (city screen) ────────────────────────────────────────────
export const BUCKETS: Record<string, string[]> = {
  new: ["New"],
  ongoing: ["InAttendance", "Stopped"],
  concluded: ["Resolved", "Closed"],
  canceled: ["Canceled"],
};
const KNOWN = Object.values(BUCKETS).flat();
const list = (xs: string[]) => `(${xs.map((s) => `'${s}'`).join(",")})`;

/**
 * SQL predicate for a bucket name, or null for an unknown name. Literals come from
 * the whitelist above, never from user input. "other" is the complement of the known
 * statuses (NULL or unexpected values) — so they are shown, never silently summed into
 * a known bucket. Object.hasOwn: "constructor" / "__proto__" must be unknown too.
 */
export function bucketPredicate(name: unknown): string | null {
  const key = name == null ? "" : String(name).trim();
  if (key === "other") return `(base_status IS NULL OR base_status NOT IN ${list(KNOWN)})`;
  return Object.hasOwn(BUCKETS, key) ? `base_status IN ${list(BUCKETS[key])}` : null;
}

// ── Teams ───────────────────────────────────────────────────────────────────
/** `team` as a single value, a CSV string or an array. */
export function parseTeams(team: unknown): string[] {
  if (team == null) return [];
  const arr = Array.isArray(team) ? team : String(team).split(",");
  return arr.map((t) => String(t).trim()).filter(Boolean);
}

/** Selected teams, or the support total (N3 excluded) when nothing is selected. */
export function effectiveTeams(team: unknown): string[] {
  const sel = parseTeams(team);
  return sel.length ? sel : METRICS_TEAMS;
}

/**
 * City screen: "what happens in this city" — with no selection it includes every
 * synced team, N3 included.
 */
export function cityTeams(team: unknown): string[] {
  const sel = parseTeams(team);
  return sel.length ? sel : SYNCED_TEAMS;
}

/**
 * Category column. With one team selected, categories stay split by level/severity;
 * with "all" or several teams, every "Corrective Maintenance - *" collapses into one
 * bar (same for Adaptive). Done in the GROUP BY so the bars still add up to the total.
 */
export function categoryExpr(team: unknown): string {
  if (parseTeams(team).length === 1) return "coalesce(category, '(no category)')";
  return `CASE
      WHEN category LIKE 'Corrective Maintenance%' THEN 'Corrective Maintenance'
      WHEN category LIKE 'Adaptive Maintenance%' THEN 'Adaptive Maintenance'
      ELSE coalesce(category, '(no category)')
    END`;
}

/** "Passed through team X": in it today OR anywhere in the ownership trail. */
export function passedTeamCond(param: string): string {
  return `(current_team = ${param} OR EXISTS (SELECT 1 FROM json_each(coalesce(owner_history, '[]')) h WHERE json_extract(h.value, '$.team') = ${param}))`;
}

/** Percentage with one decimal; null without denominator ("no data" is not "0%"). */
export const pctOf = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
