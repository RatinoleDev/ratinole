import { HOUR_MS } from "@rationale/brain";
import { prisma, type Prisma } from "@rationale/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp, redis, signIn, validDraft, wipe } from "./helpers";

const hasDb = !!process.env.DATABASE_URL;

const plan = {
  markets: ["ETH"],
  kind: "entry_exit",
  entry: [{ signal: "rsi", op: "<", value: 30 }],
  exit: { stopLossPct: 4 },
  filters: [],
  sizePctOfCash: 20,
};

async function doneBacktest(userId: string) {
  return prisma.backtest.create({
    data: {
      userId,
      sentence: "Buy ETH when RSI drops below 30, stop at 4%",
      plan: plan as unknown as Prisma.InputJsonValue,
      market: "ETH",
      status: "done",
      maxSizePct: 35,
      dailyLossCapPct: 3,
      costPct: 0.1,
      startCash: 10_000,
      params: { confidenceThreshold: 50, windows: {} },
      fromTime: new Date(Date.UTC(2026, 7, 21)),
      splitTime: new Date(Date.UTC(2026, 8, 20)),
      toTime: new Date(Date.UTC(2026, 9, 19, 23)),
      candles: 2900,
      tunedReturnPct: 1.5,
      unseenReturnPct: -0.5,
      holdingTunedPct: 3,
      holdingUnseenPct: -10,
      maxDrawdownPct: -2,
      tunedTrades: 4,
      unseenTrades: 2,
      curve: [{ t: "2026-08-21T00:00:00.000Z", strategy: 100, holding: 100 }],
      source: "Binance ETHUSDT hourly",
    },
  });
}

describe.skipIf(!hasDb)("api", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    await wipe();
  });
  afterAll(async () => {
    await wipe();
    await redis.quit();
    await prisma.$disconnect();
  });

  describe("Sign-In with Ethereum", () => {
    beforeEach(async () => {
      app = await makeApp().app;
    });

    it("signs in with a valid signature, sets an httpOnly cookie and creates the user", async () => {
      const { res, cookie, address } = await signIn(app);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ address, agentCount: 0, maxAgents: 3, maxSizePct: 35 });
      expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly/);
      const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
      expect(me.json().address).toBe(address);
    });

    it("refuses a reused nonce", async () => {
      const first = await signIn(app);
      const again = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { message: first.message, signature: first.signature } });
      expect(again.statusCode).toBe(401);
      expect(again.json().message).toMatch(/expired/);
    });

    it("refuses another site's message, the wrong chain, and a signature from another wallet", async () => {
      expect((await signIn(app, { domain: "evil.example" })).res.statusCode).toBe(401);
      expect((await signIn(app, { chainId: 1 })).res.statusCode).toBe(401);
      const { nonce } = (await app.inject({ method: "GET", url: "/api/auth/nonce" })).json();
      const honest = await signIn(app);
      const forged = honest.message.replace(/Nonce: \w+/, `Nonce: ${nonce}`);
      const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { message: forged, signature: honest.signature } });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a tampered cookie and signs out", async () => {
      const { cookie } = await signIn(app);
      const bad = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookie.replace(/.$/, "x") } });
      expect(bad.statusCode).toBe(401);
      await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
      expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
    });
  });

  describe("settings", () => {
    it("lets a wallet change its own limits within bounds", async () => {
      app = await makeApp().app;
      const { cookie } = await signIn(app);
      const ok = await app.inject({ method: "PATCH", url: "/api/me", headers: { cookie }, payload: { maxSizePct: 20, dailyLossCapPct: 2 } });
      expect(ok.json()).toMatchObject({ maxSizePct: 20, dailyLossCapPct: 2 });
      expect((await app.inject({ method: "PATCH", url: "/api/me", headers: { cookie }, payload: { maxSizePct: 150 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: "/api/me", headers: { cookie }, payload: { dailyLossCapPct: 0 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: "/api/me", headers: { cookie }, payload: { address: "0x0" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: "/api/me", payload: { maxSizePct: 20 } })).statusCode).toBe(401);
    });

    it("applies the new cap to the next intake", async () => {
      app = await makeApp({ drafterFor: () => async () => validDraft({ sizePctOfCash: 25 }) }).app;
      const { cookie } = await signIn(app);
      await app.inject({ method: "PATCH", url: "/api/me", headers: { cookie }, payload: { maxSizePct: 20 } });
      const res = (await app.inject({ method: "POST", url: "/api/intake", headers: { cookie }, payload: { sentence: "Buy ETH when RSI drops below 30, 25% per trade" } })).json();
      expect(res).toMatchObject({ ok: false, code: "size_over_cap" });
      expect(res.message).toMatch(/over your 20% cap/);
    });
  });

  describe("intake", () => {
    it("needs a signed-in wallet", async () => {
      app = await makeApp().app;
      expect((await app.inject({ method: "POST", url: "/api/intake", payload: { sentence: "Buy ETH" } })).statusCode).toBe(401);
    });

    it("says plainly when no language model is configured", async () => {
      app = await makeApp().app;
      const { cookie } = await signIn(app);
      const res = await app.inject({ method: "POST", url: "/api/intake", headers: { cookie }, payload: { sentence: "Buy ETH when RSI drops below 30" } });
      expect(res.json()).toMatchObject({ ok: false, code: "llm_unavailable" });
    });

    it("returns the plan, rows, checks and notes from a valid draft", async () => {
      const sentences: string[] = [];
      app = await makeApp({
        drafterFor: () => async (s) => {
          sentences.push(s);
          return validDraft();
        },
      }).app;
      const { cookie } = await signIn(app);
      const res = await app.inject({ method: "POST", url: "/api/intake", headers: { cookie }, payload: { sentence: " Buy ETH when RSI drops below 30 in an uptrend " } });
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(sentences).toEqual(["Buy ETH when RSI drops below 30 in an uptrend"]);
      expect(body.rows[0]).toEqual({ label: "Market", lines: ["ETH / USDG"] });
      expect(body.checks.map((c: { pass: boolean }) => c.pass)).toEqual([true, true, true, true]);
      expect(body.notChecked[0]).toMatch(/headlines/);
    });

    it("passes on intake refusals and LLM failures without guessing", async () => {
      app = await makeApp({ drafterFor: () => async () => validDraft({ sizePctOfCash: 80 }) }).app;
      let { cookie } = await signIn(app);
      expect((await app.inject({ method: "POST", url: "/api/intake", headers: { cookie }, payload: { sentence: "Buy ETH with 80% per trade" } })).json()).toMatchObject({ ok: false, code: "size_over_cap" });

      app = await makeApp({
        drafterFor: () => async () => {
          throw new Error("network");
        },
      }).app;
      ({ cookie } = await signIn(app));
      expect((await app.inject({ method: "POST", url: "/api/intake", headers: { cookie }, payload: { sentence: "Buy ETH when RSI drops below 30" } })).json()).toMatchObject({ ok: false, code: "llm_unavailable" });
    });

    it("stops at the monthly budget", async () => {
      app = await makeApp({ drafterFor: () => async () => validDraft() }).app;
      const { cookie } = await signIn(app);
      await prisma.llmUsage.create({ data: { model: "claude-opus-5-5", purpose: "intake", inputTokens: 1, outputTokens: 1, costUsd: 25, ok: true } });
      expect((await app.inject({ method: "POST", url: "/api/intake", headers: { cookie }, payload: { sentence: "Buy ETH when RSI drops below 30" } })).json()).toMatchObject({ ok: false, code: "budget_exhausted" });
    });
  });

  describe("backtests and agents", () => {
    it("re-checks a confirmed plan before queueing a backtest", async () => {
      const made = makeApp();
      app = await made.app;
      const { cookie } = await signIn(app);
      const bad = await app.inject({ method: "POST", url: "/api/backtests", headers: { cookie }, payload: { sentence: "x", plan: { ...plan, sizePctOfCash: 90 } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe("size_over_cap");
      const ok = await app.inject({ method: "POST", url: "/api/backtests", headers: { cookie }, payload: { sentence: "Buy ETH when RSI drops below 30", plan } });
      const { id } = ok.json();
      expect(made.enqueued).toEqual([{ name: "backtest", data: { backtestId: id }, jobId: `bt-${id}` }]);
      const got = await app.inject({ method: "GET", url: `/api/backtests/${id}`, headers: { cookie } });
      expect(got.json()).toMatchObject({ id, status: "queued", label: "Price signals only", marketLabel: "ETH / USDG" });
      const other = await signIn(app);
      expect((await app.inject({ method: "GET", url: `/api/backtests/${id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    });

    it("launches a paper agent from a finished backtest, owed from the next hour", async () => {
      const now = Date.UTC(2026, 10, 19, 10, 20);
      app = await makeApp({ now: () => now }).app;
      const { cookie, address } = await signIn(app);
      const user = await prisma.user.findUniqueOrThrow({ where: { address } });
      const queued = await prisma.backtest.create({ data: { userId: user.id, sentence: "s", plan: plan as unknown as Prisma.InputJsonValue, market: "ETH", maxSizePct: 35, dailyLossCapPct: 3, costPct: 0.1, startCash: 10_000 } });
      expect((await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { backtestId: queued.id } })).statusCode).toBe(409);

      const bt = await doneBacktest(user.id);
      const res = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { backtestId: bt.id } });
      expect(res.statusCode).toBe(201);
      const agent = res.json();
      expect(agent).toMatchObject({ name: "Meridian", mode: "paper", status: "active", equity: null, decisions: 0, startingCash: 10_000 });
      const shown = (await app.inject({ method: "GET", url: `/api/backtests/${bt.id}`, headers: { cookie } })).json();
      expect(shown.result.warnings[0]).toMatch(/^Only 2 buys and sells on the unseen days/);
      expect(agent.paramsText[0]).toMatch(/confidence is at least 50%/);
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(row.owedFrom.getTime()).toBe(Date.UTC(2026, 10, 19, 11));

      // three agents per wallet
      await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { backtestId: bt.id, name: "Second" } });
      await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { backtestId: bt.id } });
      const fourth = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { backtestId: bt.id } });
      expect(fourth.json().error).toBe("agent_limit");
      const list = (await app.inject({ method: "GET", url: "/api/agents", headers: { cookie } })).json();
      expect(list.map((a: { name: string }) => a.name).sort()).toEqual(["Larkspur", "Meridian", "Second"]);
    });

    it("pauses and resumes, owing decisions only from the next hour after resuming", async () => {
      let now = Date.UTC(2026, 10, 19, 10, 20);
      app = await makeApp({ now: () => now }).app;
      const { cookie, address } = await signIn(app);
      const user = await prisma.user.findUniqueOrThrow({ where: { address } });
      const bt = await doneBacktest(user.id);
      const { id } = (await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { backtestId: bt.id } })).json();
      expect((await app.inject({ method: "PATCH", url: `/api/agents/${id}`, headers: { cookie }, payload: { status: "paused" } })).json().status).toBe("paused");
      now = Date.UTC(2026, 10, 20, 8, 5);
      expect((await app.inject({ method: "PATCH", url: `/api/agents/${id}`, headers: { cookie }, payload: { status: "active" } })).json().status).toBe("active");
      expect((await prisma.agent.findUniqueOrThrow({ where: { id } })).owedFrom.getTime()).toBe(Date.UTC(2026, 10, 20, 9));
      const other = await signIn(app);
      expect((await app.inject({ method: "PATCH", url: `/api/agents/${id}`, headers: { cookie: other.cookie }, payload: { status: "paused" } })).statusCode).toBe(404);
    });
  });

  describe("decisions, overview, leaderboard, health", () => {
    const H = Date.UTC(2026, 10, 19, 11);

    async function seed(app: FastifyInstance) {
      const { cookie, address } = await signIn(app);
      const user = await prisma.user.findUniqueOrThrow({ where: { address } });
      const mk = (name: string) =>
        prisma.agent.create({
          data: { userId: user.id, name, sentence: "s", plan: plan as unknown as Prisma.InputJsonValue, params: { confidenceThreshold: 50, windows: {} }, market: "ETH", startingCash: 10_000, maxSizePct: 35, dailyLossCapPct: 3, owedFrom: new Date(H), launchedAt: new Date(H - 3 * 24 * HOUR_MS) },
        });
      const a = await mk("Alpha");
      const b = await mk("Beta");
      const dec = (agentId: string, k: number, equity: number, hold: number, action = "hold") =>
        prisma.decision.create({
          data: { agentId, hour: new Date(H + k * HOUR_MS), action, confidence: 60, regime: "trending", evidence: [{ name: "RSI", value: "40", score: -30 }], guard: [{ check: "Fresh data", pass: true, detail: "ok" }], explanation: `Hold ${k}`, cashAfter: equity, qtyAfter: 0, equityAfter: equity, holdingEquityAfter: hold, markPrice: 2000, candleSource: "binance:ETHUSDT", candleTime: new Date(H + (k - 1) * HOUR_MS) },
        });
      await dec(a.id, 0, 10_000, 9_990);
      await dec(a.id, 1, 9_500, 9_800, "buy");
      await dec(a.id, 2, 10_400, 10_100);
      await dec(b.id, 0, 10_000, 9_990);
      await dec(b.id, 1, 10_050, 10_200);
      // Running stats as the engine keeps them.
      const st = (agentId: string, decisions: number, lastEquity: number, lastHoldingEquity: number, peakEquity: number, maxDrawdownPct: number) =>
        prisma.agentState.create({
          data: { agentId, cash: lastEquity, qty: 0, dayStart: new Date(H), dayStartEquity: 10_000, decisions, lastHour: new Date(H + (decisions - 1) * HOUR_MS), lastEquity, lastHoldingEquity, peakEquity, maxDrawdownPct },
        });
      await st(a.id, 3, 10_400, 10_100, 10_400, -5);
      await st(b.id, 2, 10_050, 10_200, 10_050, 0);
      return { cookie, a, b, user };
    }

    it("serves the decision log newest first, publicly", async () => {
      app = await makeApp().app;
      const { a } = await seed(app);
      const res = (await app.inject({ method: "GET", url: `/api/agents/${a.id}/decisions?limit=2` })).json();
      expect(res.map((d: { explanation: string }) => d.explanation)).toEqual(["Hold 2", "Hold 1"]);
      expect(res[0]).toMatchObject({ agentName: "Alpha", marketLabel: "ETH / USDG", late: false, fill: null, candleSource: "binance:ETHUSDT" });
      const older = (await app.inject({ method: "GET", url: `/api/agents/${a.id}/decisions?before=${encodeURIComponent(res[1].hour)}` })).json();
      expect(older.map((d: { explanation: string }) => d.explanation)).toEqual(["Hold 0"]);
    });

    it("computes the overview from stored decisions", async () => {
      app = await makeApp({ now: () => H + 3 * HOUR_MS }).app;
      const { cookie } = await seed(app);
      const o = (await app.inject({ method: "GET", url: "/api/overview", headers: { cookie } })).json();
      expect(o.agentCount).toBe(2);
      expect(o.kpis.equity).toBeCloseTo(20_450, 6);
      expect(o.kpis.returnPct).toBeCloseTo(2.25, 6);
      expect(o.kpis.holdingPct).toBeCloseTo(1.5, 6);
      // combined 20000 -> 19550 (worst) -> 20450
      expect(o.kpis.maxDrawdownPct).toBeCloseTo((19_550 / 20_000 - 1) * 100, 6);
      expect(o.series).toHaveLength(3);
      expect(o.latest[0].explanation).toBe("Hold 2");
    });

    it("ranks agents live 7+ days by edge over holding, from stored stats, and lists newer ones after", async () => {
      app = await makeApp({ now: () => H + 3 * HOUR_MS }).app;
      const { b } = await seed(app);
      let lb = (await app.inject({ method: "GET", url: "/api/leaderboard" })).json();
      expect(lb.map((r: { name: string }) => r.name)).toEqual(["Alpha", "Beta"]);
      expect(lb[0]).toMatchObject({ returnPct: expect.closeTo(4, 6), holdingPct: expect.closeTo(1, 6), edgePct: expect.closeTo(3, 6), maxDrawdownPct: -5, daysLive: 3, decisions: 3, mode: "paper", ranked: false });
      expect(lb[1].edgePct).toBeCloseTo(0.5 - 2, 6);
      // Beta has been live long enough; it is ranked and so comes first despite a lower edge.
      await prisma.agent.update({ where: { id: b.id }, data: { launchedAt: new Date(H - 10 * 24 * HOUR_MS) } });
      lb = (await app.inject({ method: "GET", url: "/api/leaderboard" })).json();
      expect(lb.map((r: { name: string; ranked: boolean }) => [r.name, r.ranked])).toEqual([["Beta", true], ["Alpha", false]]);
    });

    it("deleting an agent archives it: off lists and rankings, slot freed, decisions kept", async () => {
      app = await makeApp({ now: () => H + 3 * HOUR_MS }).app;
      const { cookie, a } = await seed(app);
      const other = await signIn(app);
      expect((await app.inject({ method: "DELETE", url: `/api/agents/${a.id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/agents/${a.id}`, headers: { cookie } })).json()).toEqual({ ok: true });
      expect((await app.inject({ method: "GET", url: "/api/agents", headers: { cookie } })).json().map((x: { name: string }) => x.name)).toEqual(["Beta"]);
      expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json().agentCount).toBe(1);
      expect((await app.inject({ method: "GET", url: "/api/leaderboard" })).json().map((r: { name: string }) => r.name)).toEqual(["Beta"]);
      const feed = (await app.inject({ method: "GET", url: "/api/public/decisions" })).json();
      expect(feed.every((d: { agentName: string }) => d.agentName === "Beta")).toBe(true);
      expect(await prisma.decision.count({ where: { agentId: a.id } })).toBe(3);
      expect((await app.inject({ method: "GET", url: `/api/agents/${a.id}` })).json().status).toBe("archived");
      expect((await app.inject({ method: "PATCH", url: `/api/agents/${a.id}`, headers: { cookie }, payload: { status: "active" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/agents/${a.id}`, headers: { cookie } })).statusCode).toBe(404);
    });

    it("reports missed hours and engine health", async () => {
      app = await makeApp({ now: () => H + 3 * HOUR_MS + 20 * 60_000 }).app;
      await seed(app);
      let h = (await app.inject({ method: "GET", url: "/api/health" })).json();
      // Alpha owes H..H+3 and has 3; Beta owes H..H+3 and has 2.
      expect(h).toMatchObject({ ok: false, activeAgents: 2, missedHours: 3, lateDecisions: 0, engine: { lastHeartbeat: null } });
      await redis.set("engine:heartbeat", new Date(H + 3 * HOUR_MS + 19 * 60_000).toISOString());
      h = (await app.inject({ method: "GET", url: "/api/health" })).json();
      expect(h.engine.lastHeartbeat).not.toBeNull();
    });

    it("lists the latest public decisions and the landing example", async () => {
      app = await makeApp().app;
      await seed(app);
      const latest = (await app.inject({ method: "GET", url: "/api/public/decisions?limit=3" })).json();
      expect(latest).toHaveLength(3);
      const ex = (await app.inject({ method: "GET", url: "/api/public/example" })).json();
      expect(ex.backtest).toBeNull();
      expect(ex.rows[1].lines).toEqual(["RSI is below 30", "The long trend is rising"]);
    });
  });
});

describe.skipIf(!hasDb)("health without redis", () => {
  it("reports not ok instead of failing when redis is unreachable", async () => {
    const { Redis } = await import("ioredis");
    const dead = new Redis("redis://127.0.0.1:9", { maxRetriesPerRequest: 0, lazyConnect: true, retryStrategy: () => null });
    dead.on("error", () => undefined);
    const app = await makeApp({ redis: dead }).app;
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, engine: { lastHeartbeat: null, lastTick: null } });
    dead.disconnect();
  });
});
