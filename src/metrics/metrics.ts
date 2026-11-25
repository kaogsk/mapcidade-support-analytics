// Aggregated metrics for the three screens (analyst, team overview, city) and the
// drill-down list behind every card. SQL builders are pure functions (unit-tested
// against an in-memory mirror); the Metrics class only wires params and shapes output.
import { FUNNEL_LEVELS, PRINCIPAL_TEAMS } from "../config.js";
import { all, get, type Db, type Params } from "../db/db.js";
import { addDaysISO, brDay, type Period } from "../time/brt.js";
import { evaluateAlerts, rulesFromEnv, type AlertRules } from "./alerts.js";
import {
  AGE_DAYS, bucketPredicate, brDayOf, categoryExpr, cityTeams, CONCLUDED_AT, CONCLUDED_IN, CREATED_IN,
  effectiveTeams, hoursBetween, inTeams, minutesBetween, NO_RESPONSE, OPEN, passedTeamCond, pctOf,
  RESP_ANSWERED, RESP_BREACHED, RESP_IN, RESP_WITH, SLA_BREACHED, SLA_IN, SLA_WITH,
} from "./sql.js";

type Row = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const nOrNull = (v: unknown) => (v == null ? null : Number(v));

/** Tickets of the "Ideas" category (product suggestion box) stay out of city screens. */
export const NOT_IDEAS = "(category IS NULL OR trim(category) <> 'Ideas')";

// ── KPIs ────────────────────────────────────────────────────────────────────
/** One SELECT for every screen; runs twice per screen (ENTRY where, EXIT where). */
export function kpiSql(where: string): string {
  return `
    SELECT
      count(*) AS total,
      count(DISTINCT owner_id) AS analysts,
      count(DISTINCT city) AS cities,
      count(*) FILTER (WHERE ${OPEN}) AS open,
      count(*) FILTER (WHERE base_status = 'Resolved') AS resolved,
      count(*) FILTER (WHERE base_status = 'Closed') AS closed,
      count(*) FILTER (WHERE base_status = 'Canceled') AS canceled,
      round(avg(${hoursBetween("resolved_in", "created_date")}) FILTER (WHERE resolved_in IS NOT NULL), 2) AS avg_resolution_hours,
      round(avg(life_time_working_time) FILTER (WHERE life_time_working_time > 0), 0) AS avg_working_minutes,
      count(*) FILTER (WHERE ${SLA_IN}) AS sla_in,
      count(*) FILTER (WHERE ${SLA_WITH}) AS sla_with,
      count(*) FILTER (WHERE ${SLA_BREACHED}) AS sla_breached,
      count(*) FILTER (WHERE resolved_in_first_call = 1) AS first_call,
      count(*) FILTER (WHERE reopened_by_client = 1) AS reopened,
      round(avg(${minutesBetween("first_response_date", "created_date")}) FILTER (WHERE ${RESP_ANSWERED}), 0) AS avg_first_response_min,
      count(*) FILTER (WHERE ${RESP_ANSWERED}) AS answered,
      count(*) FILTER (WHERE ${RESP_IN}) AS resp_in,
      count(*) FILTER (WHERE ${RESP_WITH}) AS resp_with,
      count(*) FILTER (WHERE ${NO_RESPONSE}) AS no_response,
      round(avg(${minutesBetween("sla_real_response_date", "created_date")}) FILTER (WHERE sla_real_response_date IS NOT NULL AND base_status <> 'Canceled'), 0) AS avg_first_response_helpdesk_min,
      count(*) FILTER (WHERE sla_real_response_date IS NOT NULL AND base_status <> 'Canceled' AND sla_response_date IS NOT NULL AND sla_real_response_date <= sla_response_date) AS resp_in_helpdesk,
      count(*) FILTER (WHERE sla_real_response_date IS NOT NULL AND base_status <> 'Canceled' AND sla_response_date IS NOT NULL) AS resp_with_helpdesk
    FROM tickets WHERE ${where}`;
}

export interface Kpis {
  total: number;
  analysts: number;
  cities: number;
  open: number;
  resolved: number;
  closed: number;
  canceled: number;
  concluded: number;
  avg_resolution_hours: number | null;
  avg_working_minutes: number | null;
  sla_in: number;
  sla_with: number;
  sla_breached: number;
  pct_sla: number | null;
  first_call: number;
  pct_first_call: number | null;
  reopened: number;
  pct_reopen: number | null;
  avg_first_response_min: number | null;
  answered: number;
  resp_in: number;
  resp_with: number;
  no_response: number;
  pct_resp_sla: number | null;
  avg_first_response_helpdesk_min: number | null;
  pct_resp_sla_helpdesk: number | null;
}

export function shapeKpis(k: Row = {}): Kpis {
  const concluded = n(k.resolved) + n(k.closed);
  return {
    total: n(k.total),
    analysts: n(k.analysts),
    cities: n(k.cities),
    open: n(k.open),
    resolved: n(k.resolved),
    closed: n(k.closed),
    canceled: n(k.canceled),
    concluded,
    avg_resolution_hours: nOrNull(k.avg_resolution_hours),
    avg_working_minutes: nOrNull(k.avg_working_minutes),
    sla_in: n(k.sla_in),
    sla_with: n(k.sla_with),
    sla_breached: n(k.sla_breached),
    pct_sla: pctOf(n(k.sla_in), n(k.sla_with)),
    first_call: n(k.first_call),
    pct_first_call: pctOf(n(k.first_call), concluded),
    reopened: n(k.reopened),
    pct_reopen: pctOf(n(k.reopened), concluded),
    avg_first_response_min: nOrNull(k.avg_first_response_min),
    answered: n(k.answered),
    resp_in: n(k.resp_in),
    resp_with: n(k.resp_with),
    no_response: n(k.no_response),
    pct_resp_sla: pctOf(n(k.resp_in), n(k.resp_with)),
    avg_first_response_helpdesk_min: nOrNull(k.avg_first_response_helpdesk_min),
    pct_resp_sla_helpdesk: pctOf(n(k.resp_in_helpdesk), n(k.resp_with_helpdesk)),
  };
}

// ── Backlog (NOW) ───────────────────────────────────────────────────────────
/** Open queue at `$now`, by age. Ignores the period on purpose. */
export function backlogSql(extra?: string): string {
  return `
    SELECT count(*) AS total,
      count(*) FILTER (WHERE ${AGE_DAYS} < 2) AS d0_2,
      count(*) FILTER (WHERE ${AGE_DAYS} >= 2 AND ${AGE_DAYS} < 7) AS d2_7,
      count(*) FILTER (WHERE ${AGE_DAYS} >= 7 AND ${AGE_DAYS} < 15) AS d7_15,
      count(*) FILTER (WHERE ${AGE_DAYS} >= 15) AS d15p,
      round(avg(${AGE_DAYS} * 24.0), 1) AS avg_age_hours
    FROM tickets WHERE ${OPEN} AND ${inTeams()}${extra ? ` AND ${extra}` : ""}`;
}

export function shapeBacklog(b: Row = {}) {
  return {
    total: n(b.total),
    avg_age_hours: nOrNull(b.avg_age_hours),
    buckets: [
      { key: "d0_2", label: "< 2 days", ageMaxDays: 2, total: n(b.d0_2) },
      { key: "d2_7", label: "2–7 days", ageMinDays: 2, ageMaxDays: 7, total: n(b.d2_7) },
      { key: "d7_15", label: "7–15 days", ageMinDays: 7, ageMaxDays: 15, total: n(b.d7_15) },
      { key: "d15p", label: "> 15 days", ageMinDays: 15, total: n(b.d15p) },
    ],
  };
}

// ── Survey ratings (always about what was CLOSED in the period) ─────────────
export function ratingsSql(whereExit: string): string {
  return `
    SELECT count(*) FILTER (WHERE rating IS NOT NULL) AS rated,
      count(*) FILTER (WHERE rating IS NOT NULL AND rating < 8) AS low,
      round(avg(rating) FILTER (WHERE rating IS NOT NULL), 1) AS average
    FROM tickets WHERE ${whereExit} AND base_status = 'Closed'`;
}

export function lowRatingsSql(whereExit: string): string {
  return `
    SELECT id, subject, owner_name, city, current_team AS team, rating, rating_responded_at, closed_in
      FROM tickets
     WHERE ${whereExit} AND base_status = 'Closed' AND rating IS NOT NULL AND rating < 8
     ORDER BY rating ASC, closed_in DESC LIMIT 50`;
}

export function shapeRatings(r: Row = {}, items: Row[] = []) {
  return { rated: n(r.rated), low: n(r.low), average: nOrNull(r.average), pct_low: pctOf(n(r.low), n(r.rated)), items };
}

// ── Timeline: created x concluded per Brasília day ──────────────────────────
/**
 * Both curves carry the same filters; only the date deciding the day changes. The
 * concluded curve MUST be cut by the conclusion date — with the creation cut, an old
 * ticket closed today would never show up today.
 */
export function timelineSql(whereEntry: string, whereExit: string): string {
  return `
    WITH c AS (SELECT ${brDayOf("created_date")} AS day, count(*) AS n FROM tickets WHERE ${whereEntry} GROUP BY 1),
         f AS (SELECT ${brDayOf(CONCLUDED_AT)} AS day, count(*) AS n FROM tickets WHERE ${whereExit} GROUP BY 1),
         days AS (SELECT day FROM c UNION SELECT day FROM f)
    SELECT days.day AS day, coalesce(c.n, 0) AS created, coalesce(f.n, 0) AS concluded
      FROM days LEFT JOIN c ON c.day = days.day LEFT JOIN f ON f.day = days.day
     ORDER BY 1`;
}

/** Continuous axis: every Brasília day of [from, to), zero-filled. */
export function fillTimeline(rows: { day: string; created: number; concluded: number }[], period: Period) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: { day: string; created: number; concluded: number }[] = [];
  const last = brDay(new Date(new Date(period.to).getTime() - 1));
  for (let d = brDay(new Date(period.from)), guard = 0; d <= last && guard < 400; d = addDaysISO(d, 1), guard++) {
    const r = byDay.get(d);
    out.push({ day: d, created: n(r?.created), concluded: n(r?.concluded) });
  }
  return out;
}

// ── Escalation funnel N1 -> N2 -> N3 ────────────────────────────────────────
/**
 * Tickets OPENED in the period that PASSED through each level (today or in the
 * ownership trail). Before reading the trail, a ticket escalated N1 -> N2 LEFT the N1
 * count, so the funnel measured where tickets ended, not escalation.
 */
export function funnelSql(): string {
  const lvl = (i: number) => `
      count(*) FILTER (WHERE ${passedTeamCond(`$lvl${i}`)}) AS t${i},
      count(*) FILTER (WHERE ${passedTeamCond(`$lvl${i}`)} AND ${OPEN}) AS o${i},
      count(*) FILTER (WHERE ${passedTeamCond(`$lvl${i}`)} AND base_status IN ('Resolved','Closed')) AS c${i}`;
  return `SELECT ${FUNNEL_LEVELS.map((_, i) => lvl(i)).join(",")} FROM tickets WHERE ${CREATED_IN}`;
}

export function shapeFunnel(row: Row = {}) {
  const levels = FUNNEL_LEVELS.map((l, i) => ({ team: l.team, label: l.label, total: n(row[`t${i}`]), open: n(row[`o${i}`]), concluded: n(row[`c${i}`]) }));
  const base = levels[0].total;
  return {
    // Organic = volume never grows when going up a level.
    organic: levels.every((l, i) => i === 0 || l.total <= levels[i - 1].total),
    levels: levels.map((l) => ({ ...l, pct_of_n1: pctOf(l.total, base) })),
  };
}

// ── Ranking ─────────────────────────────────────────────────────────────────
export function rankingSql(where: string): string {
  return `
    SELECT owner_id, owner_name AS analyst, current_team AS team,
      count(*) AS total,
      count(*) FILTER (WHERE ${OPEN}) AS open,
      count(*) FILTER (WHERE base_status IN ('Resolved','Closed')) AS concluded,
      count(*) FILTER (WHERE reopened_by_client = 1) AS reopened,
      count(*) FILTER (WHERE ${SLA_IN}) AS sla_in,
      count(*) FILTER (WHERE ${SLA_WITH}) AS sla_with,
      count(*) FILTER (WHERE ${RESP_IN}) AS resp_in,
      count(*) FILTER (WHERE ${RESP_WITH}) AS resp_with,
      round(avg(${hoursBetween("resolved_in", "created_date")}) FILTER (WHERE resolved_in IS NOT NULL), 2) AS avg_resolution_hours,
      count(*) FILTER (WHERE base_status = 'Closed' AND rating IS NOT NULL) AS rated,
      round(avg(rating) FILTER (WHERE base_status = 'Closed' AND rating IS NOT NULL), 1) AS avg_rating
    FROM tickets WHERE ${where} AND owner_name IS NOT NULL
    GROUP BY owner_id, owner_name, current_team`;
}

/** Worst low rating (< 8) per ranking row + the ticket behind it (deep link). */
export function worstRatingSql(where: string): string {
  return `
    SELECT owner_id, analyst, team, rating AS low_rating, id AS low_rating_ticket FROM (
      SELECT owner_id, owner_name AS analyst, current_team AS team, rating, id,
             row_number() OVER (PARTITION BY owner_id, owner_name, current_team ORDER BY rating ASC, closed_in DESC) AS rk
        FROM tickets
       WHERE ${where} AND owner_name IS NOT NULL AND base_status = 'Closed' AND rating IS NOT NULL AND rating < 8
    ) WHERE rk = 1`;
}

/**
 * Join key: id AND name AND team. The ranking groups by all three, so two rows with the
 * same owner_id exist for real (an analyst who changed teams), and a NULL owner_id must
 * not collapse every ownerless row into one.
 */
const rankingKey = (r: Row) => `${r.owner_id ?? ""}::${r.analyst ?? ""}::${r.team ?? ""}`;

const EXIT_COLS = ["concluded", "reopened", "sla_in", "sla_with", "resp_in", "resp_with", "avg_resolution_hours", "rated", "avg_rating"] as const;

/**
 * Flow ranking: `total`/`open` describe what came IN; everything else what went OUT.
 * The list is the UNION of both sides: an analyst who only concluded old tickets in the
 * period (common in N3, where tickets live for weeks) must not vanish from the ranking
 * in exactly the period they delivered.
 */
export function mergeFlowRanking(entry: Row[], exit: Row[], worst: Row[] = []): Row[] {
  const zeroExit = Object.fromEntries(EXIT_COLS.map((c) => [c, c.startsWith("avg") ? null : 0]));
  const byKey = new Map<string, Row>();
  for (const r of entry) byKey.set(rankingKey(r), { ...r, ...zeroExit, low_rating: null, low_rating_ticket: null });
  for (const r of exit) {
    const exitCols = Object.fromEntries(EXIT_COLS.map((c) => [c, r[c] ?? zeroExit[c]]));
    const cur = byKey.get(rankingKey(r));
    if (cur) Object.assign(cur, exitCols);
    else byKey.set(rankingKey(r), { ...r, total: 0, open: 0, ...exitCols, low_rating: null, low_rating_ticket: null });
  }
  for (const w of worst) {
    const cur = byKey.get(rankingKey(w));
    if (cur) Object.assign(cur, { low_rating: w.low_rating, low_rating_ticket: w.low_rating_ticket });
  }
  return [...byKey.values()].sort((a, b) => n(b.concluded) - n(a.concluded) || n(b.total) - n(a.total));
}

export function shapeRankingRow(r: Row, rules: AlertRules) {
  const avg_rating = nOrNull(r.avg_rating);
  return {
    ...r,
    pct_sla: pctOf(n(r.sla_in), n(r.sla_with)),
    pct_resp_sla: pctOf(n(r.resp_in), n(r.resp_with)),
    pct_reopen: pctOf(n(r.reopened), n(r.concluded)),
    avg_rating,
    alerts: evaluateAlerts(
      {
        team: r.team as string | null,
        sla: { within: n(r.sla_in), with: n(r.sla_with) },
        reopen: { reopened: n(r.reopened), concluded: n(r.concluded) },
        rating: { average: avg_rating, rated: n(r.rated) },
      },
      rules,
    ),
  };
}

// ── Analyst home team ───────────────────────────────────────────────────────
/**
 * NEVER trust `analysts.team`: the sync overwrites it with the team of the analyst's
 * LAST synced ticket, so one escalated ticket "moves" a person to N2 (it happened, and
 * took ~180 h of October out of the N1 total along with the person's reopen threshold).
 *
 * Rule: the level (N1/N2/N3) of the clear MAJORITY of tickets the person RECEIVED in
 * the last 30 days. Tie or no tickets -> the stored team. 30 days of received tickets
 * (not 90 of updated ones) so a promotion shows within ~2 weeks; Triage never counts
 * (it is a pass-through).
 */
export function homeTeamSql(): string {
  return `
    WITH counts AS (
      SELECT owner_id, current_team AS team, count(*) AS n
        FROM tickets
       WHERE owner_id IS NOT NULL AND created_date >= $since30
         AND current_team IN (SELECT value FROM json_each($principal))
       GROUP BY owner_id, current_team
    ), ranked AS (
      SELECT owner_id, team, n,
             row_number() OVER (PARTITION BY owner_id ORDER BY n DESC, team) AS rk,
             lead(n) OVER (PARTITION BY owner_id ORDER BY n DESC, team) AS n2
        FROM counts
    )
    SELECT a.id, a.name, coalesce(p.team, a.team) AS team, a.team AS stored_team
      FROM analysts a
      LEFT JOIN (SELECT owner_id, team FROM ranked WHERE rk = 1 AND (n2 IS NULL OR n > n2)) p ON p.owner_id = a.id`;
}

// ── Drill-down ──────────────────────────────────────────────────────────────
export const TICKET_LIST_COLUMNS = `
  id, subject, status, base_status, owner_name, current_team AS team, team AS credited_team, city, category,
  service, urgency, origin, created_date, first_response_date, sla_real_response_date, resolved_in, closed_in,
  ${CONCLUDED_AT} AS concluded_at, sla_response_date, sla_solution_date, reopened_in, reopened_by_client,
  life_time_working_time, rating, owner_history,
  (${SLA_BREACHED}) AS sla_breached, (${RESP_BREACHED}) AS resp_breached`;

export interface TicketFilters {
  name?: string;
  team?: unknown;
  from?: string;
  to?: string;
  /** "concluded" = the EXIT card; anything else = ENTRY. */
  countBy?: string;
  openNow?: boolean;
  passedTeam?: string;
  city?: string;
  /** Set by the city screen: excludes a category and widens the team default. */
  excludeCategory?: string;
  category?: string;
  categoryGroup?: string;
  status?: string;
  urgency?: string;
  bucket?: string;
  reopened?: boolean;
  slaBreached?: boolean;
  respBreached?: boolean;
  noResponse?: boolean;
  ratingLow?: boolean;
  ageMinDays?: number;
  ageMaxDays?: number;
}

/**
 * The WHERE of the list behind a card. Must match the card EXACTLY — so it is built
 * from the same fragments, and every user value goes in as a bound parameter.
 */
export function buildTicketsWhere(f: TicketFilters, now: Date) {
  const conds: string[] = [];
  const params: Params = { now: now.toISOString() };
  if (f.name) {
    conds.push("lower(owner_name) = lower($name)");
    params.name = f.name;
  }
  if (f.openNow) {
    conds.push(OPEN); // the backlog ignores the period
  } else if (f.from && f.to) {
    params.from = f.from;
    params.to = f.to;
    conds.push(f.countBy === "concluded" ? CONCLUDED_IN : CREATED_IN);
  }
  if (f.passedTeam) {
    conds.push(passedTeamCond("$passedTeam")); // the funnel ignores the team selector
    params.passedTeam = f.passedTeam;
  } else {
    conds.push(inTeams());
    params.teams = JSON.stringify(f.excludeCategory ? cityTeams(f.team) : effectiveTeams(f.team));
  }
  const eq = (col: string, key: keyof TicketFilters) => {
    if (f[key] != null && f[key] !== "") {
      conds.push(`${col} = $${key}`);
      params[key] = f[key] as string;
    }
  };
  if (f.city) {
    conds.push("lower(city) = lower($city)");
    params.city = f.city;
  }
  eq("category", "category");
  eq("status", "status");
  eq("urgency", "urgency");
  if (f.categoryGroup) {
    conds.push("category LIKE $categoryGroup");
    params.categoryGroup = `${f.categoryGroup}%`;
  }
  const bucket = bucketPredicate(f.bucket);
  if (bucket) conds.push(bucket);
  if (f.excludeCategory) {
    conds.push("(category IS NULL OR trim(category) <> $excludeCategory)");
    params.excludeCategory = f.excludeCategory;
  }
  if (f.reopened) conds.push("reopened_by_client = 1");
  if (f.slaBreached) conds.push(SLA_BREACHED);
  if (f.respBreached) conds.push(RESP_BREACHED);
  if (f.noResponse) conds.push(NO_RESPONSE);
  if (f.ratingLow) conds.push("base_status = 'Closed' AND rating IS NOT NULL AND rating < 8");
  if (Number.isFinite(f.ageMinDays)) {
    conds.push(`${AGE_DAYS} >= $ageMinDays`);
    params.ageMinDays = f.ageMinDays;
  }
  if (Number.isFinite(f.ageMaxDays)) {
    conds.push(`${AGE_DAYS} < $ageMaxDays`);
    params.ageMaxDays = f.ageMaxDays;
  }
  return {
    where: conds.length ? conds.join(" AND ") : "1 = 1",
    params,
    orderCol: !f.openNow && f.countBy === "concluded" ? CONCLUDED_AT : "created_date",
  };
}

// ── The service ─────────────────────────────────────────────────────────────
export class Metrics {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly rules: AlertRules = rulesFromEnv(),
  ) {}

  private breakdowns(where: string, params: Params, team: unknown) {
    const q = (sql: string) => all(this.db, sql, params);
    return {
      byCity: q(`SELECT city, count(*) AS total FROM tickets WHERE ${where} AND city IS NOT NULL GROUP BY city ORDER BY total DESC, city LIMIT 15`),
      byCategory: q(`SELECT ${categoryExpr(team)} AS category, count(*) AS total FROM tickets WHERE ${where} GROUP BY 1 ORDER BY total DESC LIMIT 12`),
      byStatus: q(`SELECT coalesce(status, '(no status)') AS status, count(*) AS total FROM tickets WHERE ${where} GROUP BY 1 ORDER BY total DESC`),
      byUrgency: q(`SELECT coalesce(urgency, '(none)') AS urgency, count(*) AS total FROM tickets WHERE ${where} GROUP BY 1 ORDER BY total DESC`),
      byService: q(`SELECT coalesce(service, '(none)') AS service, count(*) AS total FROM tickets WHERE ${where} GROUP BY 1 ORDER BY total DESC LIMIT 10`),
      topSubjects: q(`SELECT subject, count(*) AS total FROM tickets WHERE ${where} AND subject IS NOT NULL GROUP BY subject ORDER BY total DESC LIMIT 8`),
    };
  }

  private flow(whereEntry: string, whereExit: string, params: Params, period: Period) {
    return {
      kpis: shapeKpis(get(this.db, kpiSql(whereEntry), params)),
      kpisExit: shapeKpis(get(this.db, kpiSql(whereExit), params)),
      ratings: shapeRatings(get(this.db, ratingsSql(whereExit), params), all(this.db, lowRatingsSql(whereExit), params)),
      timeline: fillTimeline(all(this.db, timelineSql(whereEntry, whereExit), params) as never, period),
    };
  }

  homeTeams(): Map<string, { name: string; team: string | null; stored_team: string | null }> {
    const since30 = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    const rows = all<{ id: string; name: string; team: string | null; stored_team: string | null }>(this.db, homeTeamSql(), {
      since30,
      principal: JSON.stringify(PRINCIPAL_TEAMS),
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Analysts whose home team is in the selection, with their volume in the last 30 days. */
  analysts(opts: { team?: unknown; q?: string }) {
    const teams = new Set(effectiveTeams(opts.team));
    const since30 = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    const volume = new Map(
      all<{ owner_id: string; n: number }>(this.db, "SELECT owner_id, count(*) AS n FROM tickets WHERE created_date >= $since30 GROUP BY owner_id", { since30 }).map((r) => [r.owner_id, r.n]),
    );
    const q = opts.q?.trim().toLowerCase();
    return [...this.homeTeams().entries()]
      .map(([id, a]) => ({ id, name: a.name, team: a.team, stored_team: a.stored_team, tickets_30d: volume.get(id) ?? 0 }))
      .filter((a) => a.team && teams.has(a.team) && (!q || a.name.toLowerCase().includes(q)))
      .sort((a, b) => b.tickets_30d - a.tickets_30d || a.name.localeCompare(b.name));
  }

  analyst(name: string, period: Period, team?: unknown) {
    const params: Params = { name, from: period.from, to: period.to, teams: JSON.stringify(effectiveTeams(team)), now: this.now().toISOString() };
    const who = "lower(owner_name) = lower($name)";
    const whereEntry = `${who} AND ${CREATED_IN} AND ${inTeams()}`;
    const whereExit = `${who} AND ${CONCLUDED_IN} AND ${inTeams()}`;
    const home = [...this.homeTeams().values()].find((a) => a.name.toLowerCase() === name.toLowerCase());
    const ruleTeam = home?.team ?? null;
    const flow = this.flow(whereEntry, whereExit, params, period);
    return {
      analyst: home?.name ?? name,
      homeTeam: ruleTeam,
      period,
      ...flow,
      alerts: evaluateAlerts(
        {
          team: ruleTeam,
          sla: { within: flow.kpisExit.sla_in, with: flow.kpisExit.sla_with },
          reopen: { reopened: flow.kpisExit.reopened, concluded: flow.kpisExit.concluded },
          rating: { average: flow.ratings.average, rated: flow.ratings.rated },
        },
        this.rules,
      ),
      backlog: shapeBacklog(get(this.db, backlogSql(who), params)),
      ...this.breakdowns(whereEntry, params, team),
    };
  }

  overview(period: Period, team?: unknown) {
    const params: Params = { from: period.from, to: period.to, teams: JSON.stringify(effectiveTeams(team)), now: this.now().toISOString() };
    const whereEntry = `${CREATED_IN} AND ${inTeams()}`;
    const whereExit = `${CONCLUDED_IN} AND ${inTeams()}`;
    const funnelParams: Params = { from: period.from, to: period.to };
    FUNNEL_LEVELS.forEach((l, i) => (funnelParams[`lvl${i}`] = l.team));
    const ranking = mergeFlowRanking(
      all(this.db, rankingSql(whereEntry), params),
      all(this.db, rankingSql(whereExit), params),
      all(this.db, worstRatingSql(whereExit), params),
    ).map((r) => shapeRankingRow(r, this.rules));
    return {
      period,
      ...this.flow(whereEntry, whereExit, params, period),
      backlog: shapeBacklog(get(this.db, backlogSql(), params)),
      byTeam: all(this.db, `SELECT current_team AS team, count(*) AS total, count(*) FILTER (WHERE base_status IN ('Resolved','Closed')) AS concluded FROM tickets WHERE ${whereEntry} GROUP BY 1 ORDER BY total DESC`, params),
      funnel: shapeFunnel(get(this.db, funnelSql(), funnelParams)),
      ranking,
      ...this.breakdowns(whereEntry, params, team),
    };
  }

  tickets(f: TicketFilters, page = 1, pageSize = 25) {
    const { where, params, orderCol } = buildTicketsWhere(f, this.now());
    const size = Math.min(Math.max(Math.trunc(pageSize) || 25, 1), 200);
    const pg = Math.max(Math.trunc(page) || 1, 1);
    const rows = all(this.db, `SELECT ${TICKET_LIST_COLUMNS} FROM tickets WHERE ${where} ORDER BY ${orderCol} DESC, id DESC LIMIT ${size} OFFSET ${(pg - 1) * size}`, params);
    const total = get<{ total: number }>(this.db, `SELECT count(*) AS total FROM tickets WHERE ${where}`, params)?.total ?? 0;
    return {
      total,
      page: pg,
      pageSize: size,
      countBy: f.countBy === "concluded" ? "concluded" : "created",
      rows: rows.map((r) => ({ ...r, owner_history: r.owner_history ? JSON.parse(String(r.owner_history)) : null, sla_breached: Boolean(r.sla_breached), resp_breached: Boolean(r.resp_breached) })),
    };
  }

  /**
   * City ranking. Without `q`: only cities with movement in the period (entered OR
   * exited). With `q` (autocomplete): the period does NOT filter rows — the search is
   * about the NAME, a quiet city must still be found — counts stay per period.
   */
  cities(period: Period, opts: { team?: unknown; q?: string } = {}) {
    const params: Params = { from: period.from, to: period.to, teams: JSON.stringify(cityTeams(opts.team)), now: this.now().toISOString() };
    const conds = [inTeams(), "city IS NOT NULL", NOT_IDEAS];
    if (opts.q) {
      conds.push("lower(city) LIKE lower($q)");
      params.q = `%${opts.q}%`;
    } else {
      conds.unshift(`((${CREATED_IN}) OR (${CONCLUDED_IN}))`);
    }
    const rows = all(
      this.db,
      `SELECT city,
         count(*) FILTER (WHERE ${CREATED_IN}) AS total,
         count(*) FILTER (WHERE ${CREATED_IN} AND ${bucketPredicate("new")}) AS new,
         count(*) FILTER (WHERE ${CREATED_IN} AND ${bucketPredicate("ongoing")}) AS ongoing,
         count(*) FILTER (WHERE ${CREATED_IN} AND ${bucketPredicate("canceled")}) AS canceled,
         count(*) FILTER (WHERE ${CONCLUDED_IN}) AS concluded,
         count(*) FILTER (WHERE ${CONCLUDED_IN} AND ${SLA_IN}) AS sla_in,
         count(*) FILTER (WHERE ${CONCLUDED_IN} AND ${SLA_WITH}) AS sla_with,
         count(*) FILTER (WHERE ${CREATED_IN} AND ${RESP_IN}) AS resp_in,
         count(*) FILTER (WHERE ${CREATED_IN} AND ${RESP_WITH}) AS resp_with,
         count(DISTINCT owner_id) FILTER (WHERE (${CREATED_IN}) OR (${CONCLUDED_IN})) AS analysts
       FROM tickets WHERE ${conds.join(" AND ")}
       GROUP BY city ORDER BY total DESC, city`,
      params,
    );
    // Open NOW ignores both the period and the search.
    const open = new Map(
      all<{ city: string; n: number }>(this.db, `SELECT city, count(*) AS n FROM tickets WHERE city IS NOT NULL AND ${OPEN} AND ${inTeams()} AND ${NOT_IDEAS} GROUP BY city`, params).map((r) => [r.city, r.n]),
    );
    return rows.map((r) => ({
      ...r,
      open_now: open.get(String(r.city)) ?? 0,
      pct_sla: pctOf(n(r.sla_in), n(r.sla_with)),
      pct_resp_sla: pctOf(n(r.resp_in), n(r.resp_with)),
    }));
  }

  city(city: string, period: Period, team?: unknown) {
    const params: Params = { city, from: period.from, to: period.to, teams: JSON.stringify(cityTeams(team)), now: this.now().toISOString() };
    const where = `lower(city) = lower($city) AND ${inTeams()} AND ${NOT_IDEAS}`;
    const whereEntry = `${where} AND ${CREATED_IN}`;
    const whereExit = `${where} AND ${CONCLUDED_IN}`;
    const canonical = get<{ city: string }>(this.db, "SELECT city FROM tickets WHERE lower(city) = lower($city) LIMIT 1", params)?.city ?? null;
    return {
      city: canonical ?? city,
      found: canonical != null,
      period,
      ...this.flow(whereEntry, whereExit, params, period),
      backlog: shapeBacklog(get(this.db, backlogSql(`lower(city) = lower($city) AND ${NOT_IDEAS}`), params)),
      byAnalyst: all(this.db, `SELECT owner_name AS analyst, count(*) AS total FROM tickets WHERE ${whereEntry} AND owner_name IS NOT NULL GROUP BY 1 ORDER BY total DESC LIMIT 10`, params),
      ...this.breakdowns(whereEntry, params, team),
    };
  }
}
