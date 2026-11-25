// SQLite mirror (node:sqlite) — stands in for the Postgres schema of the real system.
//
// Conventions that keep the SQL portable and the metrics correct:
//  - every instant is stored as an ISO-8601 UTC string from `toISOString()`
//    (fixed width, so string comparison == chronological comparison);
//  - lists of teams travel as ONE JSON parameter and are expanded with json_each()
//    (SQLite has no array type) — never interpolated into the SQL text;
//  - nothing calls SQLite's 'now': the current instant is always a parameter ($now),
//    so every query is deterministic under test.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue | undefined>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id                      INTEGER PRIMARY KEY,   -- ticket id in the helpdesk
  subject                 TEXT,
  status                  TEXT,                  -- display text (varies per account)
  base_status             TEXT,                  -- New | InAttendance | Stopped | Resolved | Closed | Canceled
  category                TEXT,
  urgency                 TEXT,
  origin                  INTEGER,
  service                 TEXT,

  owner_id                TEXT,                  -- CREDITED analyst (see repo.ts)
  owner_name              TEXT,
  team                    TEXT,                  -- CREDITED team: last synced team that owned it
  current_team            TEXT,                  -- team the ticket is in TODAY, even outside support
  left_team_at            TEXT,                  -- when we saw it leave the synced teams (NULL = inside)

  city                    TEXT,                  -- normalized ("CITY HALL OF OAKWOOD" -> "Oakwood")
  organization_name       TEXT,

  created_date            TEXT,
  first_response_date     TEXT,                  -- ours: 1st public human reply (from actions)
  sla_real_response_date  TEXT,                  -- the helpdesk's own figure, kept side by side
  resolved_in             TEXT,
  closed_in               TEXT,
  canceled_in             TEXT,
  reopened_in             TEXT,
  reopened_by_client      INTEGER,               -- 1 only when the CUSTOMER reopened
  sla_response_date       TEXT,                  -- response deadline (from the helpdesk)
  sla_solution_date       TEXT,                  -- solution deadline (from the helpdesk)
  last_update             TEXT,

  resolved_in_first_call  INTEGER,
  life_time_working_time  INTEGER,               -- business minutes, computed by the helpdesk
  owner_history           TEXT,                  -- JSON [{at, team, owner_id, owner, by}]

  -- Survey score (0-10). Only GET-by-id returns it, so it is filled by a separate
  -- enrichment step and is NOT part of the bulk upsert (or every sync would wipe it).
  rating                  INTEGER,
  rating_responded_at     TEXT,
  rating_synced_at        TEXT,                  -- NULL = still to fetch

  raw_payload             TEXT,                  -- full ticket JSON (audit / future fields)
  synced_at               TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_created      ON tickets(created_date);
CREATE INDEX IF NOT EXISTS idx_tickets_current_team ON tickets(current_team);
CREATE INDEX IF NOT EXISTS idx_tickets_owner_name   ON tickets(owner_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tickets_city         ON tickets(city COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tickets_concluded    ON tickets(coalesce(resolved_in, closed_in));
CREATE INDEX IF NOT EXISTS idx_tickets_open         ON tickets(base_status) WHERE base_status IN ('New','InAttendance','Stopped');
CREATE INDEX IF NOT EXISTS idx_tickets_rating_queue ON tickets(base_status, rating_synced_at) WHERE base_status = 'Closed';

CREATE TABLE IF NOT EXISTS analysts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  team        TEXT,                              -- team of the LAST synced ticket (do not trust, see analystTeam.ts)
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,                  -- 'last_sync_at', 'full_sync_done', ...
  value       TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                     -- full | incremental | reconcile
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  summary     TEXT                               -- JSON stats or error message
);

CREATE TABLE IF NOT EXISTS users (
  username              TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  admin                 INTEGER NOT NULL DEFAULT 0,
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  perms                 TEXT NOT NULL DEFAULT '{}',  -- {"cities":true,"lowRatings":true}
  apps                  TEXT NOT NULL DEFAULT '{}',  -- other panels this login unlocks
  created_at            TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Keep only the parameters the statement actually references. node:sqlite throws on
 * an unknown named parameter, and query builders share one params bag across many
 * statements — this lets them.
 */
export function bind(sql: string, params: Params = {}): Record<string, SQLInputValue> {
  const used = new Set([...sql.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const out: Record<string, SQLInputValue> = {};
  for (const k of used) out[k] = params[k] ?? null;
  return out;
}

export function all<T = Record<string, unknown>>(db: Db, sql: string, params: Params = {}): T[] {
  return db.prepare(sql).all(bind(sql, params)) as T[];
}

export function get<T = Record<string, unknown>>(db: Db, sql: string, params: Params = {}): T | undefined {
  return db.prepare(sql).get(bind(sql, params)) as T | undefined;
}

export function run(db: Db, sql: string, params: Params = {}) {
  return db.prepare(sql).run(bind(sql, params));
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getSyncState(db: Db, key: string): string | null {
  return get<{ value: string }>(db, "SELECT value FROM sync_state WHERE key = $key", { key })?.value ?? null;
}

export function setSyncState(db: Db, key: string, value: string, now: Date): void {
  run(
    db,
    `INSERT INTO sync_state (key, value, updated_at) VALUES ($key, $value, $now)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, now: now.toISOString() },
  );
}
