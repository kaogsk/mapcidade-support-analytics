import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { makeRuntime } from "../src/runtime.js";

const clock = () => new Date("2026-11-25T16:00:00Z");
const runtime = makeRuntime(loadConfig({ DB_PATH: ":memory:", SYNC_WINDOW_DAYS: "60", RATING_WINDOW_DAYS: "7" }), clock, true);
const app = createApp(runtime);
const manager = request.agent(app);
const analyst = request.agent(app);

beforeAll(async () => {
  const result = await runtime.runner.full();
  expect(result.past + result.recent).toBeGreaterThan(100);
  await manager.post("/api/login").send({ username: "manager", password: "demo-manager" }).expect(200);
  await analyst.post("/api/login").send({ username: "analyst", password: "demo-analyst" }).expect(200);
});
afterAll(() => runtime.db.close());

describe("support analytics workflow", () => {
  it("requires valid credentials to access metrics", async () => {
    await request(app).get("/api/overview").expect(401);
    await request(app).post("/api/login").send({ username: "manager", password: "invalid" }).expect(401);
  });

  it("reports separate intake, output and backlog with an assigned team", async () => {
    const { body } = await manager.get("/api/overview?days=30").expect(200);
    expect(body.kpis.total).toBeGreaterThan(0);
    expect(body.kpisExit.concluded).toBeGreaterThan(0);
    expect(body.backlog.total).toBeGreaterThan(0);
    expect(body.timeline).toHaveLength(30);
    const name = body.ranking[0].analyst;
    const detail = await manager.get(`/api/analyst/${encodeURIComponent(name)}`).expect(200);
    expect(detail.body.analyst).toBe(name);
  });

  it("honors view permissions and restricts manual sync", async () => {
    const { body } = await analyst.get("/api/overview").expect(200);
    expect(body.byCity).toEqual([]);
    expect(body.ratings.items).toEqual([]);
    expect(body.ranking.every((row: { low_rating_ticket: unknown }) => row.low_rating_ticket === null)).toBe(true);
    await analyst.post("/api/sync").send({ kind: "full" }).expect(403);
    await manager.post("/api/sync").send({ kind: "incremental" }).expect(200);
    await analyst.post("/api/logout").expect(204);
    await analyst.get("/api/overview").expect(401);
  });
});
