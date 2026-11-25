// Runs sync jobs one at a time (the API's POST /api/sync, the interval timer and the
// daily reconcile all go through here) and records every run in `sync_runs`.
import { all, run, type Db } from "../db/db.js";
import { nextBrtTime } from "../time/brt.js";
import { fullSync, incrementalSync, type SyncContext } from "./jobs.js";
import { formatReport, reconcile, type ReconcileArgs } from "./reconcile.js";

export type JobKind = "full" | "incremental" | "reconcile";

export class JobBusyError extends Error {
  constructor(readonly running: JobKind) {
    super(`a ${running} sync is already running`);
  }
}

export interface SyncRun {
  id: number;
  kind: JobKind;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  summary: string | null;
}

export class SyncRunner {
  running: JobKind | null = null;

  constructor(
    private readonly ctx: SyncContext,
    private readonly opts: { metricsTeams: string[]; dumpDir: string; reconcileMaxDelete: number },
  ) {}

  get db(): Db {
    return this.ctx.db;
  }

  private async track<T>(kind: JobKind, fn: () => Promise<T>): Promise<T> {
    if (this.running) throw new JobBusyError(this.running);
    this.running = kind;
    const started = this.ctx.now().toISOString();
    const { lastInsertRowid } = run(this.db, "INSERT INTO sync_runs (kind, started_at) VALUES ($kind, $started)", { kind, started });
    try {
      const out = await fn();
      run(this.db, "UPDATE sync_runs SET finished_at = $f, ok = 1, summary = $s WHERE id = $id", {
        id: Number(lastInsertRowid),
        f: this.ctx.now().toISOString(),
        s: typeof out === "string" ? out : JSON.stringify(out),
      });
      return out;
    } catch (err) {
      run(this.db, "UPDATE sync_runs SET finished_at = $f, ok = 0, summary = $s WHERE id = $id", {
        id: Number(lastInsertRowid),
        f: this.ctx.now().toISOString(),
        s: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.running = null;
    }
  }

  full() {
    return this.track("full", () => fullSync(this.ctx));
  }

  incremental() {
    return this.track("incremental", () => incrementalSync(this.ctx));
  }

  reconcile(args: Partial<ReconcileArgs> = {}) {
    return this.track("reconcile", async () => {
      const r = await reconcile(this.ctx, {
        execute: args.execute ?? false,
        confirm: args.confirm ?? null,
        ids: args.ids ?? null,
        maxDelete: args.maxDelete ?? this.opts.reconcileMaxDelete,
        dumpDir: this.opts.dumpDir,
        metricsTeams: this.opts.metricsTeams,
      });
      return { ...r, text: formatReport(r) };
    });
  }

  recentRuns(limit = 10): SyncRun[] {
    return all<SyncRun>(this.db, "SELECT * FROM sync_runs ORDER BY id DESC LIMIT $limit", { limit });
  }
}

/**
 * In-process scheduler: incremental every N minutes, reconcile daily at HH:MM Brasília
 * (the real deployment uses two systemd timers). Returns a stop function.
 */
export function startScheduler(
  runner: SyncRunner,
  opts: { intervalMin: number; reconcileAtBrt: string; now: () => Date; log: (m: string) => void },
): () => void {
  const timers: NodeJS.Timeout[] = [];
  const tick = async () => {
    try {
      const r = await runner.incremental();
      opts.log(`incremental: ${r.fetched} fetched, ${r.upserted} upserted, ${r.leftTeamUpdated} left-team updates, ${r.ratings.withRating} new ratings`);
    } catch (err) {
      opts.log(`incremental skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  timers.push(setInterval(tick, opts.intervalMin * 60_000));

  const scheduleReconcile = () => {
    const at = nextBrtTime(opts.now(), opts.reconcileAtBrt);
    const t = setTimeout(async () => {
      try {
        const r = await runner.reconcile({ execute: true, confirm: "EXECUTE" });
        opts.log(r.text);
      } catch (err) {
        opts.log(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      scheduleReconcile();
    }, Math.max(1000, at.getTime() - opts.now().getTime()));
    timers.push(t);
  };
  scheduleReconcile();
  return () => timers.forEach((t) => clearTimeout(t));
}
