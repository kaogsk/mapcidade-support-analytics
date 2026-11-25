// Performance alerts for an analyst: solution SLA, customer reopen rate, survey score.
//
// The rule lives ONLY here; every panel reads the computed state, so two screens can
// never light up differently for the same number.
//
// Minimum samples: below them a single event crosses the threshold (11/12 = 91.7% SLA,
// 1/12 = 8.3% reopen, one zero among 4 ratings drags a 9.9 average to 7.4). Below the
// minimum the state is "sample": the number is shown, nothing lights up.
import { TEAMS } from "../config.js";

export type AlertState = "alert" | "ok" | "sample" | "no-data" | "no-rule";

export interface AlertRules {
  slaMaxPct: number;
  reopenMinPct: Record<string, number>;
  ratingMax: number;
  minSla: number;
  minConcluded: number;
  minRated: number;
}

const num = (v: unknown, def: number) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return v != null && String(v).trim() !== "" && Number.isFinite(n) ? n : def;
};

/** "Team A:8;Team B:13" -> { "Team A": 8, "Team B": 13 }. Split on the LAST colon. */
export function parseTeamPct(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of String(raw ?? "").split(";")) {
    const i = part.lastIndexOf(":");
    if (i <= 0) continue;
    const team = part.slice(0, i).trim();
    const pct = num(part.slice(i + 1), NaN);
    if (team && Number.isFinite(pct)) out[team] = pct;
  }
  return out;
}

export const DEFAULT_REOPEN_PCT = `${TEAMS.N1}:8;${TEAMS.N2}:13`;

export function rulesFromEnv(env: NodeJS.ProcessEnv = process.env): AlertRules {
  return {
    slaMaxPct: num(env.ALERT_SLA_MAX_PCT, 92),
    reopenMinPct: parseTeamPct(env.ALERT_REOPEN_PCT ?? DEFAULT_REOPEN_PCT),
    ratingMax: num(env.ALERT_RATING_MAX, 7.5),
    minSla: num(env.ALERT_MIN_SLA, 13),
    minConcluded: num(env.ALERT_MIN_CONCLUDED, 13),
    minRated: num(env.ALERT_MIN_RATED, 5),
  };
}

export interface AlertInput {
  team: string | null;
  sla: { within: number; with: number };
  reopen: { reopened: number; concluded: number };
  rating: { average: number | null; rated: number };
}

/**
 * Compares COUNTS, not the rounded percentage on screen: "92.0%" is shown both for
 * 91.96% (alert) and 92.04% (no alert). Only teams with a reopen threshold (the support
 * levels) have rules; everyone else is "no-rule".
 */
export function evaluateAlerts(input: AlertInput, rules: AlertRules = rulesFromEnv()) {
  const reopenPct = rules.reopenMinPct[String(input.team ?? "").trim()];
  const limits = {
    sla: rules.slaMaxPct,
    reopen: reopenPct ?? null,
    rating: rules.ratingMax,
    sample: { sla: rules.minSla, reopen: rules.minConcluded, rating: rules.minRated },
  };
  if (reopenPct == null) return { sla: "no-rule" as AlertState, reopen: "no-rule" as AlertState, rating: "no-rule" as AlertState, limits };
  const state = (n: number, min: number, breached: () => boolean): AlertState =>
    !n ? "no-data" : n < min ? "sample" : breached() ? "alert" : "ok";
  const { within, with: withSla } = input.sla;
  const { reopened, concluded } = input.reopen;
  const { average, rated } = input.rating;
  return {
    sla: state(withSla, rules.minSla, () => within * 100 <= rules.slaMaxPct * withSla),
    reopen: state(concluded, rules.minConcluded, () => reopened * 100 >= reopenPct * concluded),
    rating: state(average == null ? 0 : rated, rules.minRated, () => (average ?? 10) <= rules.ratingMax),
    limits,
  };
}
