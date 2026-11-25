// Reconcile: find mirror rows the ticketing API no longer returns.
//
// WHY: the sync only upserts, never deletes. When an agent deletes or merges a ticket
// at the source, its row is orphaned — and if it was OPEN it stays in the backlog
// forever, aging into the "> 15 days" bucket and dragging its former owner's queue age
// up. An audit found 7 such ghosts (all open) in ~18.8k tickets.
//
// Safety rails, because this runs on a timer with nobody watching:
//  1. REPORT mode by default. Deleting needs `execute` AND `confirm === "EXECUTE"`.
//  2. Only the DELETED class is ever removed. A ticket that still exists but moved to a
//     team outside support (RETEAMED) is never touched.
//  3. Every id is re-checked against the API right before its DELETE — never delete
//     from a stale list.
//  4. A cap per run: a long list is usually the symptom of a bad API answer (a 200 with
//     an empty list), not of dozens of real deletions. Above the cap, nothing is removed.
//  5. A reversible dump (JSON + restore SQL) is written before anything is removed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, get, run, type Db } from "../db/db.js";
import { buildTeamFilter, toInstant } from "../helpdesk/client.js";
import type { SyncContext } from "./jobs.js";

export const DELETED = "DELETED";
export const RETEAMED = "RETEAMED";
export const PRESENT = "PRESENT";
export type Verdict = typeof DELETED | typeof RETEAMED | typeof PRESENT;

export const DEFAULT_MAX_DELETE = 25;

/** Pure verdict from what the API answered for one id (null = does not exist). */
export function classify(apiTicket: { ownerTeam?: string | null } | null, syncedTeams: string[]): Verdict {
  if (!apiTicket) return DELETED;
  return apiTicket.ownerTeam && syncedTeams.includes(apiTicket.ownerTeam) ? PRESENT : RETEAMED;
}

export interface ReconcileArgs {
  execute: boolean;
  confirm: string | null;
  ids: number[] | null;
  maxDelete: number;
}

export function parseArgs(argv: string[]): ReconcileArgs {
  const has = (f: string) => argv.includes(f);
  const val = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const idsRaw = val("ids");
  const cap = Number(val("max-delete"));
  return {
    execute: has("--execute") && !has("--report-only"),
    confirm: val("confirm"),
    ids: idsRaw ? idsRaw.split(",").map((s) => Number(s.trim())).filter(Number.isFinite) : null,
    maxDelete: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_DELETE,
  };
}

export function assertExecuteAllowed(args: Pick<ReconcileArgs, "execute" | "confirm">): void {
  if (args.execute && args.confirm !== "EXECUTE") {
    throw new Error("refusing to delete: execute requires confirm=EXECUTE (exactly, upper case)");
  }
}

export const exceedsCap = (n: number, cap = DEFAULT_MAX_DELETE) => n > cap;

export interface CandidateRow {
  id: number;
  owner_name: string | null;
  team: string | null;
  city: string | null;
  base_status: string | null;
  created_date: string | null;
  subject: string | null;
  teamNow?: string | null;
}

/** Ids the API returns for the mirror's coverage (team filter), on both routes. */
async function idsInApi(ctx: SyncContext, since: Date): Promise<Set<number>> {
  const filter = buildTeamFilter(ctx.syncedTeams, since, "createdDate");
  const ids = new Set<number>();
  for (const endpoint of ["tickets", "tickets/past"] as const) {
    for await (const page of ctx.client.iterateTickets({ endpoint, filter, select: "id", expand: "", pageSize: 1000 })) {
      for (const t of page) ids.add(Number(t.id));
    }
  }
  return ids;
}

export interface Audit {
  coverage: { since: string | null; total: number };
  checked: number;
  groups: Record<Verdict, CandidateRow[]>;
}

export async function audit(ctx: SyncContext, opts: { ids?: number[] | null } = {}): Promise<Audit> {
  const cov = get<{ since: string | null; total: number }>(ctx.db, "SELECT min(created_date) AS since, count(*) AS total FROM tickets") ?? { since: null, total: 0 };
  const cols = "id, owner_name, team, city, base_status, created_date, subject";
  let candidates: CandidateRow[];
  if (opts.ids?.length) {
    candidates = all<CandidateRow>(ctx.db, `SELECT ${cols} FROM tickets WHERE id IN (SELECT value FROM json_each($ids)) ORDER BY id`, {
      ids: JSON.stringify(opts.ids),
    });
  } else if (cov.since) {
    const inApi = await idsInApi(ctx, toInstant(cov.since)!);
    candidates = all<CandidateRow>(ctx.db, `SELECT ${cols} FROM tickets ORDER BY id`).filter((r) => !inApi.has(Number(r.id)));
  } else {
    candidates = [];
  }
  const groups: Record<Verdict, CandidateRow[]> = { DELETED: [], RETEAMED: [], PRESENT: [] };
  for (const c of candidates) {
    const api = await ctx.client.fetchTicket(c.id);
    groups[classify(api, ctx.syncedTeams)].push({ ...c, teamNow: api?.ownerTeam ?? null });
  }
  return { coverage: cov, checked: candidates.length, groups };
}

export interface BacklogImpact {
  backlog: number;
  ghosts: number;
  over15d: number;
  ghostsOver15d: number;
}

/** How many of the orphans are counted as open backlog right now. */
export function backlogImpact(db: Db, deletedIds: number[], teams: string[], now: Date): BacklogImpact {
  const open = "base_status IN ('New','InAttendance','Stopped')";
  const old = "julianday($now) - julianday(created_date) >= 15";
  const ghost = "id IN (SELECT value FROM json_each($ids))";
  return get<BacklogImpact>(
    db,
    `SELECT count(*) FILTER (WHERE ${open}) AS backlog,
            count(*) FILTER (WHERE ${open} AND ${ghost}) AS ghosts,
            count(*) FILTER (WHERE ${open} AND ${old}) AS over15d,
            count(*) FILTER (WHERE ${open} AND ${ghost} AND ${old}) AS ghostsOver15d
       FROM tickets WHERE current_team IN (SELECT value FROM json_each($teams))`,
    { ids: JSON.stringify(deletedIds), teams: JSON.stringify(teams), now: now.toISOString() },
  ) ?? { backlog: 0, ghosts: 0, over15d: 0, ghostsOver15d: 0 };
}

/** Write the full rows + a restore script before deleting. Returns the base path. */
export function dumpBeforeDelete(db: Db, ids: number[], dir: string, now: Date): string | null {
  const rows = all(db, "SELECT * FROM tickets WHERE id IN (SELECT value FROM json_each($ids)) ORDER BY id", { ids: JSON.stringify(ids) });
  if (rows.length === 0) return null;
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = join(dir, `orphans-${stamp}`);
  const cols = Object.keys(rows[0]);
  const lit = (v: unknown) => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  writeFileSync(`${base}.json`, JSON.stringify(rows, null, 2), "utf8");
  writeFileSync(
    `${base}.sql`,
    `-- Restore of ${rows.length} orphan(s) removed by reconcile at ${now.toISOString()}.\n` +
      rows.map((r) => `INSERT OR IGNORE INTO tickets (${cols.join(", ")}) VALUES (${cols.map((c) => lit(r[c])).join(", ")});`).join("\n") +
      "\n",
    "utf8",
  );
  return base;
}

export interface ReconcileResult {
  mode: "report" | "execute";
  audit: Audit;
  impact: BacklogImpact;
  refusedOverCap: boolean;
  dump: string | null;
  removed: number[];
  spared: { id: number; teamNow: string | null }[];
}

export async function reconcile(
  ctx: SyncContext,
  args: ReconcileArgs & { dumpDir: string; metricsTeams: string[] },
): Promise<ReconcileResult> {
  assertExecuteAllowed(args);
  const result = await audit(ctx, { ids: args.ids });
  const deleted = result.groups.DELETED;
  const ids = deleted.map((d) => d.id);
  const impact = backlogImpact(ctx.db, ids, args.metricsTeams, ctx.now());
  const base: ReconcileResult = {
    mode: args.execute ? "execute" : "report",
    audit: result,
    impact,
    refusedOverCap: false,
    dump: null,
    removed: [],
    spared: [],
  };
  if (!args.execute || ids.length === 0) return base;
  if (exceedsCap(ids.length, args.maxDelete)) return { ...base, refusedOverCap: true };

  const dump = dumpBeforeDelete(ctx.db, ids, args.dumpDir, ctx.now());
  const removed: number[] = [];
  const spared: { id: number; teamNow: string | null }[] = [];
  for (const d of deleted) {
    const again = await ctx.client.fetchTicket(d.id);
    if (again) {
      spared.push({ id: d.id, teamNow: again.ownerTeam ?? null });
      continue;
    }
    run(ctx.db, "DELETE FROM tickets WHERE id = $id", { id: d.id });
    removed.push(d.id);
  }
  return { ...base, dump, removed, spared };
}

/** Human-readable report for the CLI and the job log. */
export function formatReport(r: ReconcileResult): string {
  const line = (x: CandidateRow) =>
    `  #${x.id}  ${(x.created_date ?? "").slice(0, 16)}  ${(x.base_status ?? "-").padEnd(12)} ${(x.city ?? "(no city)").padEnd(14)} ${x.owner_name ?? "(no owner)"}${x.teamNow ? `  [now: ${x.teamNow}]` : ""}`;
  const g = r.audit.groups;
  const out = [
    `reconcile (${r.mode.toUpperCase()}) — mirror: ${r.audit.coverage.total} tickets since ${r.audit.coverage.since?.slice(0, 10) ?? "-"}, ${r.audit.checked} candidate(s) re-checked by id`,
    `DELETED at the source (${g.DELETED.length}):`,
    ...g.DELETED.map(line),
    `RETEAMED — still exist, now outside support (${g.RETEAMED.length}), never removed:`,
    ...g.RETEAMED.map(line),
  ];
  if (g.PRESENT.length) out.push(`PRESENT — false candidates (${g.PRESENT.length}):`, ...g.PRESENT.map(line));
  out.push(
    `backlog impact: ${r.impact.backlog} open now, ${r.impact.ghosts} ghost(s); "> 15 days": ${r.impact.over15d} (ghosts ${r.impact.ghostsOver15d})`,
  );
  if (r.mode === "report") out.push("nothing was changed (report mode).");
  else if (r.refusedOverCap) out.push(`REFUSED: ${g.DELETED.length} orphans exceed the per-run cap — nothing was changed.`);
  else out.push(`removed: ${r.removed.length}${r.removed.length ? ` (${r.removed.join(", ")})` : ""}; dump: ${r.dump ?? "-"}`, ...(r.spared.length ? [`spared (reappeared): ${r.spared.map((s) => s.id).join(", ")}`] : []));
  return out.join("\n");
}
