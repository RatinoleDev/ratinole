/** Live mode through the API, with a pretend chain reader: the API only ever reads vaults, it never signs. */
import { HOUR_MS } from "@rationale/brain";
import type { Address } from "@rationale/config";
import { prisma, type Prisma } from "@rationale/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { VaultInfo, VaultReader } from "../src/chain";
import { env, makeApp, redis, signIn, wipe } from "./helpers";

const hasDb = !!process.env.DATABASE_URL;
const FACTORY = "0xfac70000000000000000000000000000000000aa" as Address;
const OPERATOR = "0x0be7a70700000000000000000000000000000001" as Address;
const VAULT = "0x7a11700000000000000000000000000000000001" as Address;

const plan = { markets: ["ETH"], kind: "entry_exit", entry: [{ signal: "rsi", op: "<", value: 30 }], exit: { stopLossPct: 4 }, filters: [], sizePctOfCash: 20 };

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
    },
  });
}

/** A vault the tests can change between calls, as its owner could on-chain. */
function pretendVaults(owner: string) {
  const state = {
    has: true,
    down: false,
    info: { vault: VAULT, owner: owner.toLowerCase() as Address, operator: OPERATOR, paused: false, cash: 100, token: { qty: 0, tradable: true, priceUsd: 2000 }, otherUsd: 0 } as VaultInfo,
  };
  const reader: VaultReader = {
    factory: FACTORY,
    defaultOperator: async () => OPERATOR,
    vaultOf: async (who) => {
      if (state.down) throw new Error("rpc down");
      return state.has && who.toLowerCase() === owner.toLowerCase() ? VAULT : null;
    },
    read: async () => structuredClone(state.info),
  };
  return { state, reader };
}

describe.skipIf(!hasDb)("live mode", () => {
  let app: FastifyInstance;
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await redis.quit();
    await prisma.$disconnect();
  });

  /** Signs in first, then builds a second app over the same session with that wallet's pretend vault. */
  async function withVault(now = Date.UTC(2026, 10, 20, 10, 20)) {
    const first = await makeApp().app;
    const session = await signIn(first);
    const vaults = pretendVaults(session.address);
    app = await makeApp({ vaults: vaults.reader, now: () => now }).app;
    const user = await prisma.user.findUniqueOrThrow({ where: { address: session.address } });
    const bt = await doneBacktest(user.id);
    const launch = (payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/agents", headers: { cookie: session.cookie }, payload: { backtestId: bt.id, mode: "live", ...payload } });
    return { ...session, user, bt, launch, vault: vaults.state };
  }

  it("is off until a factory is configured, and says so", async () => {
    app = await makeApp().app;
    const { cookie, address } = await signIn(app);
    const chain = (await app.inject({ method: "GET", url: "/api/public/chain" })).json();
    expect(chain).toMatchObject({ live: false, trading: false, factory: null, operator: null, chainId: 4663 });
    expect(chain.tokens.map((t: { symbol: string }) => t.symbol)).toEqual(["WETH", "cbBTC"]);
    const user = await prisma.user.findUniqueOrThrow({ where: { address } });
    const bt = await doneBacktest(user.id);
    const res = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie }, payload: { backtestId: bt.id, mode: "live" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "live_off" });
    expect(await prisma.agent.count()).toBe(0);
  });

  it("publishes the factory, the agent's address and the limits once it is on", async () => {
    await withVault();
    expect((await app.inject({ method: "GET", url: "/api/public/chain" })).json()).toMatchObject({
      live: true,
      trading: true,
      factory: FACTORY,
      operator: OPERATOR,
      stable: { symbol: "USDG", decimals: 6 },
      limits: { minVaultUsd: 5, maxVaultUsd: env.liveMaxVaultUsd, defaultSlippageBps: 100 },
    });
  });

  it("launches a live agent on the wallet's own vault, measured against what the vault holds", async () => {
    const s = await withVault();
    s.vault.info.cash = 120;
    s.vault.info.token.qty = 0.05; // $100 of WETH at the oracle price
    const res = await s.launch();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mode: "live", vault: VAULT, status: "active", startingCash: 220, decisions: 0, inPosition: true, pausedReason: null });
    const row = await prisma.agent.findFirstOrThrow({ include: { state: true } });
    expect(row).toMatchObject({ mode: "live", vault: VAULT, startingCash: 220 });
    expect(row.state).toMatchObject({ cash: 120, qty: 0.05, avgEntry: 2000, dayStartEquity: 220 });
    expect(row.owedFrom.getTime()).toBe(Date.UTC(2026, 10, 20, 11));

    // One live agent per vault; paper agents are counted on their own.
    expect((await s.launch()).json()).toMatchObject({ error: "live_limit" });
    for (let i = 0; i < 3; i++) expect((await s.launch({ mode: "paper" })).statusCode).toBe(201);
    expect((await s.launch({ mode: "paper" })).json()).toMatchObject({ error: "agent_limit" });
    const list = (mode?: string) => app.inject({ method: "GET", url: `/api/agents${mode ? `?mode=${mode}` : ""}`, headers: { cookie: s.cookie } });
    expect((await list("live")).json()).toHaveLength(1);
    expect((await list("paper")).json()).toHaveLength(3);
    expect((await list()).json()).toHaveLength(4);
  });

  it("refuses to launch on a vault that cannot be traded, each time with the reason", async () => {
    const cases: [string, (v: Awaited<ReturnType<typeof withVault>>["vault"]) => void, number][] = [
      ["no_vault", (v) => void (v.has = false), 409],
      ["not_your_vault", (v) => void (v.info.owner = "0x9999999999999999999999999999999999999999"), 409],
      ["agent_access", (v) => void (v.info.operator = "0x0000000000000000000000000000000000000000"), 409],
      ["vault_paused", (v) => void (v.info.paused = true), 409],
      ["token_not_allowed", (v) => void (v.info.token.tradable = false), 409],
      ["vault_empty", (v) => void (v.info.cash = 4.5), 409],
      ["beta_cap", (v) => void (v.info.cash = 600), 409],
      ["chain_unavailable", (v) => void (v.down = true), 503],
    ];
    for (const [error, breakIt, status] of cases) {
      await wipe();
      const s = await withVault();
      breakIt(s.vault);
      const res = await s.launch();
      expect(res.statusCode, error).toBe(status);
      expect(res.json().error).toBe(error);
      expect(res.json().message.length).toBeGreaterThan(20);
      expect(await prisma.agent.count()).toBe(0);
    }
  });

  it("two launches sent together cannot both get through", async () => {
    const s = await withVault();
    const both = await Promise.all([s.launch(), s.launch()]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.agent.count({ where: { mode: "live" } })).toBe(1);
    // The lock is released afterwards: the usual refusal comes back, not "busy".
    expect((await s.launch()).json()).toMatchObject({ error: "live_limit" });
  });

  it("when the owner pauses live trading, vaults stay reachable but nothing starts or resumes", async () => {
    const first = await makeApp().app;
    const session = await signIn(first);
    const vaults = pretendVaults(session.address);
    app = await makeApp({ vaults: vaults.reader, env: { ...env, liveTradingPaused: true } }).app;
    // The site still knows the factory, so the Vault page keeps working for everyone.
    expect((await app.inject({ method: "GET", url: "/api/public/chain" })).json()).toMatchObject({ live: true, trading: false, factory: FACTORY });
    const user = await prisma.user.findUniqueOrThrow({ where: { address: session.address } });
    const bt = await doneBacktest(user.id);
    const res = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie: session.cookie }, payload: { backtestId: bt.id, mode: "live" } });
    expect(res.json()).toMatchObject({ error: "live_paused" });
    expect(res.json().message).toMatch(/you can withdraw at any time/);
    // A live agent that exists is not counted as missing its hours while trading is paused.
    const agent = await prisma.agent.create({
      data: { userId: user.id, name: "Old", sentence: "s", plan: plan as unknown as Prisma.InputJsonValue, params: {}, market: "ETH", mode: "live", vault: VAULT, startingCash: 100, maxSizePct: 35, dailyLossCapPct: 3, owedFrom: new Date(Date.now() - 5 * HOUR_MS), status: "paused" },
    });
    expect((await app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, headers: { cookie: session.cookie }, payload: { status: "active" } })).json()).toMatchObject({ error: "live_paused" });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "active" } });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ missedHours: 0, activeAgents: 0 });
  });

  it("does not count a speck of a token, or a token the oracle has no price for", async () => {
    const s = await withVault();
    s.vault.info.token.qty = 0.0001; // 20 cents
    expect((await s.launch()).json()).toMatchObject({ startingCash: 100, inPosition: false });
    await prisma.agent.deleteMany();
    s.vault.info.token = { qty: 1, tradable: true, priceUsd: null };
    expect((await s.launch()).json()).toMatchObject({ startingCash: 100, inPosition: false });
  });

  it("shows why the engine stopped a live agent, and only resumes on a tradable vault", async () => {
    const s = await withVault();
    const { id } = (await s.launch()).json();
    await prisma.agent.update({ where: { id }, data: { status: "paused", pausedReason: "The vault is empty, so this agent was stopped. Deposit, then resume it." } });
    const get = async () => (await app.inject({ method: "GET", url: `/api/agents/${id}`, headers: { cookie: s.cookie } })).json();
    expect(await get()).toMatchObject({ status: "paused", pausedReason: expect.stringMatching(/vault is empty/) });

    const resume = () => app.inject({ method: "PATCH", url: `/api/agents/${id}`, headers: { cookie: s.cookie }, payload: { status: "active" } });
    s.vault.info.cash = 0;
    expect((await resume()).json()).toMatchObject({ error: "vault_empty" });
    expect((await get()).status).toBe("paused");
    // Over the launch cap is fine for an agent that is already running: the cap is for starting.
    s.vault.info.cash = 900;
    expect((await resume()).json()).toMatchObject({ status: "active", pausedReason: null });
  });

  it("only the owner can read a live agent or its decisions; paper agents stay open", async () => {
    const s = await withVault();
    const live = (await s.launch()).json();
    const paper = (await s.launch({ mode: "paper" })).json();
    const other = await signIn(app);
    for (const cookie of [undefined, other.cookie]) {
      const headers = cookie ? { cookie } : {};
      for (const url of [`/api/agents/${live.id}`, `/api/agents/${live.id}/decisions`]) {
        const res = await app.inject({ method: "GET", url, headers });
        expect(res.statusCode, url).toBe(404);
        expect(res.body).not.toContain(VAULT);
      }
      expect((await app.inject({ method: "GET", url: `/api/agents/${paper.id}`, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/agents/${paper.id}/decisions`, headers })).statusCode).toBe(200);
    }
    // Another wallet cannot pause, resume or delete it either.
    expect((await app.inject({ method: "PATCH", url: `/api/agents/${live.id}`, headers: { cookie: other.cookie }, payload: { status: "paused" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${live.id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/agents/${live.id}`, headers: { cookie: s.cookie } })).json()).toMatchObject({ id: live.id, mode: "live", status: "active", vault: VAULT });
    expect((await app.inject({ method: "GET", url: `/api/agents/${live.id}/decisions`, headers: { cookie: s.cookie } })).statusCode).toBe(200);
    // The public lists never carry it.
    for (const url of ["/api/public/leaderboard", "/api/public/feed"]) {
      expect((await app.inject({ method: "GET", url })).body).not.toContain(live.id);
    }
  });

  it("counts every token in the vault towards the launch cap, not only this agent's market", async () => {
    const s = await withVault();
    s.vault.info.cash = 100;
    s.vault.info.otherUsd = 450; // cbBTC the ETH agent's key could also trade
    const res = await s.launch();
    expect(res.json()).toMatchObject({ error: "beta_cap" });
    expect(res.json().message).toMatch(/Yours holds about \$550/);
    s.vault.info.otherUsd = 350;
    // The agent is still measured against its own market only.
    expect((await s.launch()).json()).toMatchObject({ mode: "live", startingCash: 100 });
  });

  it("an agent only resumes on the vault it was launched on", async () => {
    const s = await withVault();
    const { id } = (await s.launch()).json();
    await prisma.agent.update({ where: { id }, data: { status: "paused", vault: "0x7a11700000000000000000000000000000000002" } });
    const res = await app.inject({ method: "PATCH", url: `/api/agents/${id}`, headers: { cookie: s.cookie }, payload: { status: "active" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "other_vault" });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id } })).status).toBe("paused");
  });

  it("limits how often one wallet can make the server read the chain", async () => {
    const s = await withVault();
    s.vault.has = false;
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await s.launch()).statusCode);
    expect(codes.slice(0, 12).every((c) => c === 409)).toBe(true);
    expect(codes.slice(12)).toEqual([429, 429]);
    // Another wallet is not held back by it.
    const other = await signIn(app);
    const user = await prisma.user.findUniqueOrThrow({ where: { address: other.address } });
    const bt = await doneBacktest(user.id);
    const res = await app.inject({ method: "POST", url: "/api/agents", headers: { cookie: other.cookie }, payload: { backtestId: bt.id, mode: "live" } });
    expect(res.json()).toMatchObject({ error: "no_vault" });
  });

  it("never adds virtual and real money together, and divides each hour by the base it had", async () => {
    const s = await withVault();
    const live = (await s.launch()).json();
    const paper = (await s.launch({ mode: "paper" })).json();
    const h = Date.UTC(2026, 10, 20, 11);
    const base = { action: "hold", confidence: 50, regime: "ranging", evidence: [], guard: [], explanation: "Hold.", cashAfter: 0, qtyAfter: 0, markPrice: 2000, candleSource: "binance:ETHUSDT", candleTime: new Date(h - HOUR_MS) };
    await prisma.decision.createMany({
      data: [
        { ...base, agentId: paper.id, hour: new Date(h), equityAfter: 10_100, holdingEquityAfter: 10_050 },
        // Live: $100 at launch, then a $200 deposit and a $10 gain in the next hour.
        { ...base, agentId: live.id, hour: new Date(h), equityAfter: 100, holdingEquityAfter: 99, basisAfter: 100 },
        { ...base, agentId: live.id, hour: new Date(h + HOUR_MS), equityAfter: 310, holdingEquityAfter: 303, basisAfter: 300, flowUsd: 200, txHash: "0xabc", execError: null },
        { ...base, agentId: live.id, hour: new Date(h + 2 * HOUR_MS), equityAfter: 310, holdingEquityAfter: 303, basisAfter: 300, execError: "the vault is paused" },
      ],
    });
    await prisma.agent.update({ where: { id: live.id }, data: { startingCash: 300 } });
    const overview = async (mode?: string) => (await app.inject({ method: "GET", url: `/api/overview${mode ? `?mode=${mode}` : ""}`, headers: { cookie: s.cookie } })).json();

    const p = await overview();
    expect(p).toMatchObject({ agentCount: 1, kpis: { equity: 10_100 } });
    expect(p.kpis.returnPct).toBeCloseTo(1, 6);
    expect(p.latest.every((d: { mode: string }) => d.mode === "paper")).toBe(true);

    const l = await overview("live");
    expect(l.agentCount).toBe(1);
    expect(l.kpis.equity).toBe(310);
    // $10 gained on $300 of base: the $200 deposit is not a gain.
    expect(l.kpis.returnPct).toBeCloseTo((310 / 300 - 1) * 100, 6);
    expect(l.series.map((x: { strategy: number }) => x.strategy)).toEqual([100, expect.closeTo(103.333, 2), expect.closeTo(103.333, 2)]);
    expect(l.kpis.maxDrawdownPct).toBe(0);
    expect(l.latest[0]).toMatchObject({ mode: "live", execError: "the vault is paused" });
    expect(l.latest[1]).toMatchObject({ mode: "live", flowUsd: 200, txHash: "0xabc" });

    // Real-money agents stay off the public ranking and the public feed.
    await prisma.agentState.createMany({ data: [live.id, paper.id].map((agentId) => ({ agentId, cash: 0, qty: 0, dayStart: new Date(h), dayStartEquity: 1, decisions: 1, lastEquity: 1, lastHoldingEquity: 1 })), skipDuplicates: true });
    await prisma.agentState.updateMany({ data: { decisions: 3 } });
    const board = (await app.inject({ method: "GET", url: "/api/leaderboard" })).json();
    expect(board.map((r: { agentId: string }) => r.agentId)).toEqual([paper.id]);
    const feed = (await app.inject({ method: "GET", url: "/api/public/decisions" })).json();
    expect(feed.every((d: { agentId: string }) => d.agentId === paper.id)).toBe(true);
  });
});
