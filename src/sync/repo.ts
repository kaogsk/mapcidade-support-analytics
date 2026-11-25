// Persistence for the sync: ticket upserts with the team-change rules, analysts,
// survey-rating queue.
import { all, get, run, tx, type Db } from "../db/db.js";
import type { TicketRow } from "./mapTicket.js";

/** Columns written by the bulk upsert. Rating columns are deliberately NOT here. */
export const TICKET_COLUMNS = [
  "id", "subject", "status", "base_status", "category", "urgency", "origin", "service",
  "owner_id", "owner_name", "team", "current_team", "city", "organization_name",
  "created_date", "first_response_date", "sla_real_response_date", "resolved_in", "closed_in",
  "canceled_in", "reopened_in", "reopened_by_client", "sla_response_date", "sla_solution_date",
  "last_update", "resolved_in_first_call", "life_time_working_time", "owner_history", "raw_payload",
] as const;

// ── Team changes ────────────────────────────────────────────────────────────
// `team` / `owner_*` are the CREDITED team and analyst: they only move while the ticket
// sits in a synced team. Once it is handed over to Customer Success / Product / ...,
// they keep the last support values — so nobody's history changes — while status and
// dates keep updating. That second half is what stops a handed-over ticket from staying
// open forever in the backlog of whoever owned it before.
const INSIDE = "excluded.current_team IN (SELECT value FROM json_each($syncedTeams))";
const CREDITED = new Set(["team", "owner_id", "owner_name"]);

export function upsertSql(): string {
  const cols = TICKET_COLUMNS.join(", ");
  const values = TICKET_COLUMNS.map((c) => `$${c}`).join(", ");
  const sets = TICKET_COLUMNS.filter((c) => c !== "id")
    .map((c) => (CREDITED.has(c) ? `${c} = CASE WHEN ${INSIDE} THEN excluded.${c} ELSE tickets.${c} END` : `${c} = excluded.${c}`))
    .concat([
      // Back inside -> NULL. Still outside -> keep the FIRST time we saw it leave.
      `left_team_at = CASE WHEN ${INSIDE} THEN NULL ELSE coalesce(tickets.left_team_at, $now) END`,
      "synced_at = $now",
    ]);
  return `INSERT INTO tickets (${cols}, synced_at) VALUES (${values}, $now)
          ON CONFLICT (id) DO UPDATE SET ${sets.join(", ")}`;
}

/**
 * Tickets that may be INSERTED (synced team) vs. tickets that may only UPDATE an
 * existing row (any other team). The dashboard is about support: a Product ticket
 * never enters the mirror on its own.
 */
export function splitByTeam(rows: TicketRow[], syncedTeams: string[]) {
  const inside: TicketRow[] = [];
  const outside: TicketRow[] = [];
  for (const r of rows) (r.current_team && syncedTeams.includes(r.current_team) ? inside : outside).push(r);
  return { inside, outside };
}

export function upsertTickets(db: Db, rows: TicketRow[], syncedTeams: string[], now: Date): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(upsertSql());
  const shared = { syncedTeams: JSON.stringify(syncedTeams), now: now.toISOString() };
  tx(db, () => {
    for (const r of rows) stmt.run({ ...r, ...shared });
  });
  return rows.length;
}

/**
 * UPDATE-only path for tickets that left the synced teams. Never inserts, and never
 * touches `team` / `owner_*`: credit belongs to the analyst+team pair that worked it
 * here. Returns the number of rows actually touched.
 */
export function updateExistingSql(): string {
  const skip = new Set(["id", ...CREDITED]);
  const sets = TICKET_COLUMNS.filter((c) => !skip.has(c)).map((c) => `${c} = $${c}`);
  return `UPDATE tickets SET ${sets.join(", ")}, left_team_at = coalesce(left_team_at, $now), synced_at = $now WHERE id = $id`;
}

export function updateExistingTickets(db: Db, rows: TicketRow[], now: Date): number {
  if (rows.length === 0) return 0;
  const sql = updateExistingSql();
  const stmt = db.prepare(sql);
  const columns = TICKET_COLUMNS.filter((c) => !CREDITED.has(c));
  const syncedAt = now.toISOString();
  let touched = 0;
  tx(db, () => {
    for (const r of rows) {
      const params = Object.fromEntries(columns.map((column) => [column, r[column]]));
      touched += Number(stmt.run({ ...params, now: syncedAt }).changes);
    }
  });
  return touched;
}

/** Analyst dimension, derived from the tickets just mapped. */
export function upsertAnalysts(db: Db, rows: TicketRow[], now: Date): number {
  const byId = new Map<string, { id: string; name: string; team: string | null }>();
  for (const r of rows) if (r.owner_id && r.owner_name) byId.set(r.owner_id, { id: r.owner_id, name: r.owner_name, team: r.team });
  const stmt = db.prepare(
    `INSERT INTO analysts (id, name, team, updated_at) VALUES ($id, $name, $team, $now)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, team = excluded.team, updated_at = excluded.updated_at`,
  );
  tx(db, () => {
    for (const a of byId.values()) stmt.run({ ...a, now: now.toISOString() });
  });
  return byId.size;
}

// ── Survey ratings ──────────────────────────────────────────────────────────
/**
 * Closed tickets whose rating must be fetched: inside the window and never fetched,
 * or changed after the last fetch (a survey answered late bumps `last_update`).
 */
export function pendingRatings(db: Db, windowDays: number, now: Date, limit = 50_000): number[] {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  return all<{ id: number }>(
    db,
    `SELECT id FROM tickets
      WHERE base_status = 'Closed'
        AND coalesce(closed_in, last_update, created_date) >= $since
        AND (rating_synced_at IS NULL OR (last_update IS NOT NULL AND last_update > rating_synced_at))
      ORDER BY coalesce(closed_in, last_update, created_date) DESC
      LIMIT $limit`,
    { since, limit },
  ).map((r) => r.id);
}

/** Store the rating — or mark it fetched without one, so it is not fetched again. */
export function setRating(db: Db, id: number, rating: { score: number; at: Date | null } | null, now: Date): void {
  run(
    db,
    `UPDATE tickets SET rating = $score, rating_responded_at = $at, rating_synced_at = $now WHERE id = $id`,
    { id, score: rating?.score ?? null, at: rating?.at?.toISOString() ?? null, now: now.toISOString() },
  );
}

export function ticketCount(db: Db): number {
  return get<{ n: number }>(db, "SELECT count(*) AS n FROM tickets")?.n ?? 0;
}
