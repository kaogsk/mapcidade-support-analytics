// Sync jobs: full (initial window), incremental (delta by lastUpdate) and the survey
// rating enrichment that runs after both.
import { getSyncState, setSyncState, type Db } from "../db/db.js";
import { buildTeamFilter, odataDate, toInstant, type Endpoint, type HelpdeskClient } from "../helpdesk/client.js";
import { RECENT_WINDOW_DAYS } from "../helpdesk/fakeHelpdesk.js";
import { brDay, brMidnight } from "../time/brt.js";
import { extractRating, mapTicket } from "./mapTicket.js";
import { pendingRatings, setRating, splitByTeam, updateExistingTickets, upsertAnalysts, upsertTickets } from "./repo.js";

export interface SyncContext {
  db: Db;
  client: HelpdeskClient;
  syncedTeams: string[];
  /** The current instant (the simulated clock when running against the fake API). */
  now: () => Date;
  windowDays: number;
  ratingWindowDays: number;
  overlapMin: number;
  log?: (msg: string) => void;
}

/** Latest of a set of instants, compared numerically (never by string or `.sort()`). */
export function latestInstant(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d.getTime() > best.getTime())) best = d;
  return best;
}

export interface RatingStats {
  total: number;
  done: number;
  withRating: number;
  low: number;
  errors: number;
}

/**
 * Survey scores, one GET per ticket (listings never carry them). Bounded concurrency
 * on top of the client's 429/5xx backoff. A failure leaves `rating_synced_at` NULL on
 * purpose: the ticket is retried on the next run.
 */
export async function enrichRatings(ctx: SyncContext, concurrency = 4): Promise<RatingStats> {
  const ids = pendingRatings(ctx.db, ctx.ratingWindowDays, ctx.now());
  const stats: RatingStats = { total: ids.length, done: 0, withRating: 0, low: 0, errors: 0 };
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const rating = extractRating(await ctx.client.fetchSurvey(id));
        setRating(ctx.db, id, rating, ctx.now());
        if (rating) {
          stats.withRating++;
          if (rating.score < 8) stats.low++;
        }
      } catch {
        stats.errors++;
      }
      stats.done++;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return stats;
}

export interface FullSyncResult {
  windowDays: number;
  since: string;
  past: number;
  recent: number;
  analysts: number;
  lastSyncAt: string | null;
  ratings: RatingStats;
}

/**
 * Initial load of the synced teams' tickets created inside the window. The API splits
 * tickets in TWO routes — `/tickets` (updated in the last 90 days) and `/tickets/past`
 * (the rest). `/tickets` alone hides all the history: it is how a "3 months show only
 * 95 tickets" bug happened. Both routes are read; the upsert dedups by id.
 */
export async function fullSync(ctx: SyncContext): Promise<FullSyncResult> {
  const now = ctx.now();
  const since = brMidnight(brDay(now, -ctx.windowDays));
  const filter = buildTeamFilter(ctx.syncedTeams, since, "createdDate");
  ctx.log?.(`full sync: ${ctx.syncedTeams.length} teams, createdDate ge ${since.toISOString()}`);

  const counts: Record<Endpoint, number> = { "tickets/past": 0, tickets: 0 };
  const analysts = new Set<string>();
  let maxLastUpdate: Date | null = null;
  for (const endpoint of ["tickets/past", "tickets"] as const) {
    for await (const page of ctx.client.iterateTickets({ endpoint, filter })) {
      const rows = page.map(mapTicket);
      upsertTickets(ctx.db, rows, ctx.syncedTeams, ctx.now());
      upsertAnalysts(ctx.db, rows, ctx.now());
      for (const r of rows) {
        if (r.owner_id) analysts.add(r.owner_id);
        maxLastUpdate = latestInstant(maxLastUpdate, toInstant(r.last_update));
      }
      counts[endpoint] += rows.length;
    }
    ctx.log?.(`  /${endpoint}: ${counts[endpoint]} tickets`);
  }

  // The incremental boundary is the newest lastUpdate SEEN, stored as an ISO instant —
  // not "now" (clock skew would open a gap) and not a Date's local toString().
  if (maxLastUpdate) setSyncState(ctx.db, "last_sync_at", maxLastUpdate.toISOString(), ctx.now());
  setSyncState(ctx.db, "full_sync_done", "true", ctx.now());
  setSyncState(ctx.db, "full_sync_window_days", String(ctx.windowDays), ctx.now());

  const ratings = await enrichRatings(ctx);
  return {
    windowDays: ctx.windowDays,
    since: since.toISOString(),
    past: counts["tickets/past"],
    recent: counts.tickets,
    analysts: analysts.size,
    lastSyncAt: maxLastUpdate?.toISOString() ?? null,
    ratings,
  };
}

export interface IncrementalResult {
  since: string;
  fetched: number;
  upserted: number;
  leftTeamUpdated: number;
  ignoredOutside: number;
  lastSyncAt: string | null;
  ratings: RatingStats;
}

/**
 * Delta sync: everything whose `lastUpdate` moved since the last boundary, minus an
 * overlap margin (tickets right on the boundary are re-read; the upsert is idempotent).
 *
 * The filter is ONLY `lastUpdate ge X` — no team clause. With a team clause, a ticket
 * handed over to a team outside support stopped matching and its row FROZE: open
 * forever in the backlog of its former owner (12 such rows found in production, one 39
 * days old). Without it, a few extra tickets per cycle come back and each row's fate is
 * decided by its team: synced team -> upsert; other team -> update only if the row
 * already exists (never insert).
 */
export async function incrementalSync(ctx: SyncContext): Promise<IncrementalResult> {
  const now = ctx.now();
  const last = toInstant(getSyncState(ctx.db, "last_sync_at"));
  const since = last
    ? new Date(last.getTime() - ctx.overlapMin * 60_000)
    : new Date(now.getTime() - ctx.windowDays * 86_400_000);
  const filter = `lastUpdate ge ${odataDate(since)}`;
  // A boundary older than the 90-day split means part of the delta lives in /tickets/past.
  const endpoints: Endpoint[] =
    since.getTime() < now.getTime() - RECENT_WINDOW_DAYS * 86_400_000 ? ["tickets/past", "tickets"] : ["tickets"];
  ctx.log?.(`incremental sync: lastUpdate ge ${since.toISOString()} (${endpoints.join(" + ")})`);

  let fetched = 0;
  let upserted = 0;
  let leftTeamUpdated = 0;
  let ignoredOutside = 0;
  let maxInstant = last;
  for (const endpoint of endpoints) {
    // Ascending: a ticket updated while we page moves to the END and is read again,
    // instead of shifting the pages and being skipped.
    for await (const page of ctx.client.iterateTickets({ endpoint, filter, orderby: "lastUpdate asc" })) {
      const rows = page.map(mapTicket);
      fetched += rows.length;
      const { inside, outside } = splitByTeam(rows, ctx.syncedTeams);
      upserted += upsertTickets(ctx.db, inside, ctx.syncedTeams, ctx.now());
      upsertAnalysts(ctx.db, inside, ctx.now());
      const touched = updateExistingTickets(ctx.db, outside, ctx.now());
      leftTeamUpdated += touched;
      ignoredOutside += outside.length - touched;
      for (const r of rows) maxInstant = latestInstant(maxInstant, toInstant(r.last_update));
    }
  }
  if (maxInstant) setSyncState(ctx.db, "last_sync_at", maxInstant.toISOString(), ctx.now());
  const ratings = await enrichRatings(ctx);
  return {
    since: since.toISOString(),
    fetched,
    upserted,
    leftTeamUpdated,
    ignoredOutside,
    lastSyncAt: maxInstant?.toISOString() ?? null,
    ratings,
  };
}
