import { loadConfig } from "./config.js";
import { makeRuntime } from "./runtime.js";
import { parseArgs } from "./sync/reconcile.js";

const [kind, ...args] = process.argv.slice(2);
const { cfg, db, runner } = makeRuntime(loadConfig(), undefined, true);
try {
  if (kind === "reconcile") {
    const options = parseArgs(args);
    if (!args.some((arg) => arg.startsWith("--max-delete="))) options.maxDelete = cfg.sync.reconcileMaxDelete;
    console.log((await runner.reconcile(options)).text);
  } else if (kind === "full" || kind === "incremental") {
    console.log(await runner[kind]());
  } else {
    console.error("Usage: cli <full|incremental|reconcile>");
    process.exitCode = 2;
  }
} finally {
  db.close();
}
