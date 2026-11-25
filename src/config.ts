// Runtime configuration. Everything has a working default so `npm run dev` needs no
// .env at all: the API boots, mounts the fake ticketing API on itself and syncs from it.
import { randomBytes } from "node:crypto";

// Team names exactly as the ticketing API spells them (`ownerTeam`). The dashboard
// never hardcodes them anywhere else: every module imports from here.
export const TEAMS = {
  N1: "Service Desk - N1",
  TRIAGE: "Service Desk - Triage",
  N2: "Service Desk - N2",
  N3: "Engineering - N3",
} as const;

export type TeamName = (typeof TEAMS)[keyof typeof TEAMS];

/** Teams whose tickets are mirrored. Tickets of any other team are never inserted. */
export const SYNCED_TEAMS: string[] = [TEAMS.N1, TEAMS.TRIAGE, TEAMS.N2, TEAMS.N3];

/**
 * Teams that make up "the support total" when no team is selected. N3 is synced
 * (escalations land there and the funnel needs it) but it is managed by another
 * area, so it is only counted when someone selects it explicitly.
 */
export const METRICS_TEAMS: string[] = SYNCED_TEAMS.filter((t) => t !== TEAMS.N3);

/** Teams that can be an analyst's "home" team. Triage is a pass-through, not a home. */
export const PRINCIPAL_TEAMS: string[] = [TEAMS.N1, TEAMS.N2, TEAMS.N3];

/** Funnel levels, in escalation order. */
export const FUNNEL_LEVELS = [
  { team: TEAMS.N1, label: "N1" },
  { team: TEAMS.N2, label: "N2" },
  { team: TEAMS.N3, label: "N3" },
] as const;

/** Teams outside support that tickets get handed over to. */
export const OUTSIDE_TEAMS = ["Customer Success", "Product", "Onboarding"];

/** Short label for UI and logs ("Service Desk - N1" -> "N1"). */
export function teamLabel(team: string | null | undefined): string {
  if (!team) return "-";
  return team.split(" - ").at(-1) ?? team;
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) ? n : def;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  helpdesk: { baseUrl: string; token: string; fake: boolean; seed: number };
  sync: {
    windowDays: number;
    ratingWindowDays: number;
    intervalMin: number;
    overlapMin: number;
    reconcileAtBrt: string;
    reconcileMaxDelete: number;
  };
  auth: { jwtSecret: string; cookieName: string; cookieSecure: boolean; ephemeralSecret: boolean };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = num(env.PORT, 4201);
  const ephemeralSecret = !env.JWT_SECRET;
  return {
    port,
    dbPath: env.DB_PATH || "data/support.db",
    helpdesk: {
      baseUrl: env.HELPDESK_URL || `http://localhost:${port}/helpdesk/v1`,
      token: env.HELPDESK_TOKEN || "demo-token",
      fake: env.FAKE_HELPDESK !== "false",
      seed: num(env.FAKE_SEED, 20261125),
    },
    sync: {
      windowDays: num(env.SYNC_WINDOW_DAYS, 365),
      ratingWindowDays: num(env.RATING_WINDOW_DAYS, 90),
      intervalMin: num(env.SYNC_INTERVAL_MIN, 20),
      overlapMin: num(env.SYNC_OVERLAP_MIN, 15),
      reconcileAtBrt: env.RECONCILE_AT || "03:30",
      reconcileMaxDelete: num(env.RECONCILE_MAX_DELETE, 25),
    },
    auth: {
      // No secret configured -> random per boot (sessions die on restart). Fine for a
      // demo, logged as a warning by the server.
      jwtSecret: env.JWT_SECRET || randomBytes(32).toString("hex"),
      cookieName: "sa_token",
      cookieSecure: env.AUTH_COOKIE_SECURE === "true",
      ephemeralSecret,
    },
  };
}
