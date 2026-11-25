import express, { type NextFunction, type Request, type Response } from "express";
import { readCookie, signJwt, verifyJwt } from "./auth/crypto.js";
import { canSee, seedDemoUsers, UsersStore } from "./auth/users.js";
import { TEAMS } from "./config.js";
import { HELPDESK_MOUNT, helpdeskMiddleware } from "./helpdesk/fakeHelpdesk.js";
import { Metrics } from "./metrics/metrics.js";
import type { makeRuntime } from "./runtime.js";
import { JobBusyError } from "./sync/runner.js";
import { periodFromDays, resolvePeriod } from "./time/brt.js";

export function createApp({ cfg, db, fake, now, runner }: ReturnType<typeof makeRuntime>) {
  const app = express();
  const metrics = new Metrics(db, now);
  const users = new UsersStore(db);
  if (fake) seedDemoUsers(users, now());
  const cookie = { httpOnly: true, sameSite: "strict" as const, secure: cfg.auth.cookieSecure, path: "/" };
  const userOf = (req: Request) => users.find(verifyJwt(readCookie(req.get("cookie"), cfg.auth.cookieName), cfg.auth.jwtSecret, now())?.sub);
  const periodOf = (req: Request) => req.query.from || req.query.to ? resolvePeriod(req.query, now()) : periodFromDays(Number(req.query.days), now());

  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  if (fake) app.use(HELPDESK_MOUNT, helpdeskMiddleware(fake));
  app.get("/health", (_req, res) => res.json({ ok: true, running: runner.running }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Enter a username and password." });
      return;
    }
    const user = users.verify(username, password);
    if (!user) {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }
    const ttl = 8 * 60 * 60;
    const token = signJwt({ sub: user.username, name: user.name }, cfg.auth.jwtSecret, { expiresInSec: ttl, now: now() });
    res.cookie(cfg.auth.cookieName, token, { ...cookie, maxAge: ttl * 1000 }).json(user);
  });
  app.post("/api/logout", (_req, res) => res.clearCookie(cfg.auth.cookieName, cookie).status(204).end());
  app.use("/api", (req, res, next) => {
    const user = userOf(req);
    if (!user) {
      res.status(401).json({ error: "Sign in to view analytics." });
      return;
    }
    res.locals.user = user;
    next();
  });
  app.get("/api/session", (_req, res) => res.json(res.locals.user));
  app.get("/api/teams", (_req, res) => res.json(Object.values(TEAMS)));
  app.get("/api/overview", (req, res) => {
    const summary = metrics.overview(periodOf(req), req.query.team);
    const user = res.locals.user;
    if (!canSee(user, "cities")) summary.byCity = [];
    if (!canSee(user, "lowRatings")) {
      summary.ratings.items = [];
      summary.ranking = summary.ranking.map((row) => ({ ...row, low_rating: null, low_rating_ticket: null }));
    }
    res.json(summary);
  });
  app.get("/api/analyst/:name", (req, res) => {
    const summary = metrics.analyst(req.params.name, periodOf(req), req.query.team);
    if (!canSee(res.locals.user, "cities")) summary.byCity = [];
    if (!canSee(res.locals.user, "lowRatings")) summary.ratings.items = [];
    res.json(summary);
  });
  app.get("/api/sync", (_req, res) => res.json({ running: runner.running, recent: runner.recentRuns() }));
  app.post("/api/sync", async (req, res) => {
    if (!res.locals.user.admin) {
      res.status(403).json({ error: "Manager access required." });
      return;
    }
    const kind = req.body?.kind;
    if (kind === "full") res.json(await runner.full());
    else if (kind === "incremental") res.json(await runner.incremental());
    else if (kind === "reconcile") res.json(await runner.reconcile());
    else res.status(400).json({ error: "Choose full, incremental, or reconcile." });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof JobBusyError) res.status(409).json({ error: err.message });
    else if (err instanceof RangeError) res.status(400).json({ error: err.message });
    else {
      console.error(err);
      res.status(500).json({ error: "The analytics request failed." });
    }
  });
  return app;
}
