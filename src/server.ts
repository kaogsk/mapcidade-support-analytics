import { createApp } from "./app.js";
import { getSyncState } from "./db/db.js";
import { makeRuntime } from "./runtime.js";
import { startScheduler } from "./sync/runner.js";

const runtime = makeRuntime();
const { cfg, db, now, runner } = runtime;
createApp(runtime).listen(cfg.port, "127.0.0.1", async () => {
  console.log(`[support-analytics] API listening on http://127.0.0.1:${cfg.port}`);
  try {
    if (!getSyncState(db, "full_sync_done")) {
      const result = await runner.full();
      console.log(`[support-analytics] initial sync: ${result.past + result.recent} tickets fetched`);
    }
  } catch (error) {
    console.error("[support-analytics] initial sync failed", error);
  }
  startScheduler(runner, { ...cfg.sync, now, log: console.log });
});
