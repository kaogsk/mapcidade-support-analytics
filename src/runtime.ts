import { dirname, join } from "node:path";
import { loadConfig, METRICS_TEAMS, SYNCED_TEAMS, type AppConfig } from "./config.js";
import { getSyncState, openDb, setSyncState } from "./db/db.js";
import { HelpdeskClient } from "./helpdesk/client.js";
import { FakeHelpdesk } from "./helpdesk/fakeHelpdesk.js";
import { generateWorld } from "./helpdesk/world.js";
import { SyncRunner } from "./sync/runner.js";

export function makeRuntime(cfg: AppConfig = loadConfig(), clock = () => new Date(), inProcess = false) {
  const db = openDb(cfg.dbPath);
  const date = clock();
  const anchor = getSyncState(db, "demo_world_anchor") ?? `${date.toISOString().slice(0, 10)}T00:00:00Z`;
  if (cfg.helpdesk.fake) setSyncState(db, "demo_world_anchor", anchor, date);
  const fake = cfg.helpdesk.fake ? new FakeHelpdesk({
    world: generateWorld({ anchor: new Date(anchor), seed: cfg.helpdesk.seed }),
    token: cfg.helpdesk.token,
    clock: () => clock().getTime(),
  }) : null;
  const now = () => fake ? new Date(fake.now()) : clock();
  const client = new HelpdeskClient({
    baseUrl: cfg.helpdesk.baseUrl,
    token: cfg.helpdesk.token,
    fetchImpl: inProcess ? fake?.fetch : undefined,
  });
  const runner = new SyncRunner({
    db, client, now,
    syncedTeams: SYNCED_TEAMS,
    windowDays: cfg.sync.windowDays,
    ratingWindowDays: cfg.sync.ratingWindowDays,
    overlapMin: cfg.sync.overlapMin,
  }, {
    metricsTeams: METRICS_TEAMS,
    dumpDir: join(dirname(cfg.dbPath), "audit"),
    reconcileMaxDelete: cfg.sync.reconcileMaxDelete,
  });
  return { cfg, db, fake, now, runner };
}
