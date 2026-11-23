/**
 * LOCAL FORK ONLY. Drives the engine's real chain client and the real live runner against a local copy of
 * Robinhood Chain (real pools and price feeds, fake money). It refuses any node that is not a local Hardhat
 * fork, and it WIPES the database it is pointed at, so it only runs on the test database.
 *
 *   Terminal 1:  FORK=1 pnpm --filter @rationale/contracts exec hardhat node
 *   Terminal 2:  VAULT=1 USD=300 pnpm --filter @rationale/contracts exec hardhat run scripts/fork-setup.js --network localhost > /tmp/fork.json
 *                DATABASE_URL=$TEST_DATABASE_URL FORK_SETUP=/tmp/fork.json pnpm --filter @rationale/engine exec tsx test/forkCheck.ts
 */
import { readFileSync } from "node:fs";
import { HOUR_MS, type Plan } from "@rationale/brain";
import { ERC20_ABI, LIVE_STABLE, LIVE_TOKENS, VAULT_ABI, fromUnits, toUnits, type Address } from "@rationale/config";
import { prisma, type Prisma } from "@rationale/db";
import { encodeFunctionData, parseUnits, zeroAddress, type Abi, type Hex } from "viem";
import { viemVaultChain, type SwapOutcome } from "../src/vault/chain";
import { runLiveAgentHour } from "../src/vault/runLive";

const RPC = "http://127.0.0.1:8545";
let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

async function main() {
  if (!/hardhat/i.test(await rpc<string>("web3_clientVersion"))) throw new Error("Not a local Hardhat fork. Stopping.");
  if (!/test/i.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL must be the test database: this check wipes it.");
  const text = readFileSync(process.env.FORK_SETUP ?? "", "utf8");
  const cfg = JSON.parse(text.slice(text.indexOf("{"))) as { vault: Address; owner: Address; operator: Address; operatorKey: Hex; factory: Address };
  const chain = viemVaultChain({ rpcUrl: RPC, factory: cfg.factory, privateKey: cfg.operatorKey, confirmTimeoutMs: 30_000 });
  const vault = cfg.vault;
  const WETH = LIVE_TOKENS.ETH;
  const BTC = LIVE_TOKENS.BTC;
  const asOwner = async (to: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from: cfg.owner, to, data: encodeFunctionData({ abi, functionName, args }) }]);
    for (;;) {
      const r = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
      if (r) return r.status === "0x1";
    }
  };
  const nonce = async () => Number(await rpc<string>("eth_getTransactionCount", [chain.operator, "latest"]));
  const reasonOf = (o: SwapOutcome) => (o.ok ? "UNEXPECTEDLY OK" : o.reason);
  // The fork's clock is today's, and the candles the runner uses below are from hours that are already over. So
  // the check gives every order a deadline by the fork's own clock instead of by its hour.
  const later = (await chain.chainTime()) + 3600;
  const buy = (token: Address, feeTier: number, usd: number, onSigned: (h: Hex) => Promise<void> = async () => undefined, deadline = later) =>
    chain.swap({ vault, tokenIn: LIVE_STABLE.address, tokenOut: token, feeTier, amountIn: toUnits(usd, 6), deadline }, onSigned);

  console.log("\nChain client");
  check("the engine's key is the vault's operator", chain.operator === cfg.operator.toLowerCase());
  const s0 = await chain.snapshot(vault, WETH);
  check("the vault is read: owner, operator, tradable, pool fee", s0.owner === cfg.owner.toLowerCase() && s0.operator === chain.operator && s0.tradable && s0.feeTier === 100, `USDG ${fromUnits(s0.stable, 6)}`);

  let handed = "" as Hex;
  const b1 = await buy(WETH.address, s0.feeTier, 50, async (h) => void (handed = h));
  const s1 = await chain.snapshot(vault, WETH);
  check("a WETH buy goes through the real pool", b1.ok, b1.ok ? `${fromUnits(b1.amountOut, 18)} WETH for $50` : b1.reason);
  check("the hash written down before sending is the transaction that landed", b1.ok && handed === b1.txHash);
  check("the vault moved by exactly the amounts in the receipt", b1.ok && s0.stable - s1.stable === b1.amountIn && s1.token - s0.token === b1.amountOut);
  check("the order can be found again by its hash", b1.ok && (await chain.outcomeOf(b1.txHash, vault))?.ok === true);
  check("an unknown hash is unknown, not an error", (await chain.outcomeOf(`0x${"ab".repeat(32)}`, vault)) === null);

  const n0 = await nonce();
  const withdrawn = await buy(WETH.address, s0.feeTier, 20, async () => Promise.reject(new Error("order withdrawn"))).then(() => "sent", (e: Error) => e.message);
  const s2 = await chain.snapshot(vault, WETH);
  check("an order withdrawn after signing is never sent", withdrawn === "order withdrawn" && s2.stable === s1.stable && (await nonce()) === n0);

  const sell = await chain.swap({ vault, tokenIn: WETH.address, tokenOut: LIVE_STABLE.address, feeTier: s0.feeTier, amountIn: s2.token, deadline: later }, async () => undefined);
  const s3 = await chain.snapshot(vault, WETH);
  check("selling the whole WETH balance leaves none", sell.ok && s3.token === 0n, sell.ok ? `$${fromUnits(sell.amountOut, 6)} back` : sell.reason);

  console.log("\nBTC market (cbBTC, 8 decimals)");
  const c0 = await chain.snapshot(vault, BTC);
  check("cbBTC is tradable in the vault at its pinned pool", c0.tradable && c0.feeTier === 500, `fee tier ${c0.feeTier}`);
  const cb = await buy(BTC.address, c0.feeTier, 40);
  const c1 = await chain.snapshot(vault, BTC);
  const btcPrice = cb.ok ? fromUnits(cb.amountIn, 6) / fromUnits(cb.amountOut, BTC.decimals) : 0;
  check("a cbBTC buy goes through, at a believable price", cb.ok && btcPrice > 10_000 && btcPrice < 1_000_000, cb.ok ? `${fromUnits(cb.amountOut, 8)} cbBTC, $${btcPrice.toFixed(0)} each` : cb.reason);
  const cs = await chain.swap({ vault, tokenIn: BTC.address, tokenOut: LIVE_STABLE.address, feeTier: c0.feeTier, amountIn: c1.token, deadline: later }, async () => undefined);
  check("selling the whole cbBTC balance leaves none", cs.ok && (await chain.snapshot(vault, BTC)).token === 0n, cs.ok ? `$${fromUnits(cs.amountOut, 6)} back` : cs.reason);

  console.log("\nRefusals are caught before anything is signed, in plain words");
  const va = VAULT_ABI as Abi;
  const before = await nonce();
  await asOwner(vault, va, "setPaused", [true]);
  check("a paused vault", reasonOf(await buy(WETH.address, 100, 5)) === "the vault is paused");
  await asOwner(vault, va, "setPaused", [false]);
  await asOwner(vault, va, "setLimits", [100, parseUnits("1", 18)]);
  check("the daily limit", reasonOf(await buy(WETH.address, 100, 5)) === "the vault's daily trading limit is used up");
  await asOwner(vault, va, "setLimits", [100, parseUnits("5000", 18)]);
  await asOwner(vault, va, "setOperator", [zeroAddress]);
  check("revoked access", reasonOf(await buy(WETH.address, 100, 5)) === "the agent's access to the vault was revoked");
  check("a revoked vault reads as revoked", (await chain.snapshot(vault, WETH)).operator !== chain.operator);
  await asOwner(vault, va, "setOperator", [chain.operator]);
  // More than the balance, but inside the daily limit, so it is the balance that stops it.
  check("more than the vault holds", reasonOf(await buy(WETH.address, 100, 1000)) === "the vault holds less than the order needed");
  check("the wrong pool", reasonOf(await buy(WETH.address, 3000, 5)) === "the vault no longer allows this market");
  const clock = await chain.chainTime();
  check("the chain's clock is read, and is close to this machine's", Math.abs(clock - Date.now() / 1000) < 900, `${Math.round(clock - Date.now() / 1000)} s apart`);
  check("an order past its deadline", reasonOf(await buy(WETH.address, 100, 5, async () => undefined, clock - 5)) === "the order was placed too late in the hour");
  check("none of the refused orders cost a transaction", (await nonce()) === before);

  console.log("\nThe live runner, with the real chain and real candles");
  await prisma.liveOrder.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.agentState.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  const start = await chain.snapshot(vault, WETH);
  const cash0 = fromUnits(start.stable, 6);
  const plan: Plan = { markets: ["ETH"], kind: "dca", entry: [], cadenceHours: 24, sizePctOfCash: 10, exit: { stopLossPct: 15 }, filters: [] };
  const h = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 9 * HOUR_MS;
  const user = await prisma.user.create({ data: { address: cfg.owner.toLowerCase() } });
  const agent = await prisma.agent.create({
    data: {
      userId: user.id, name: "Fork check", sentence: "Buy ETH with 10% of cash every day, stop at 15%", plan: plan as unknown as Prisma.InputJsonValue,
      params: { confidenceThreshold: 0, windows: {} }, market: "ETH", mode: "live", vault: vault.toLowerCase(), startingCash: cash0, maxSizePct: 35, dailyLossCapPct: 3,
      owedFrom: new Date(h), state: { create: { cash: cash0, qty: 0, dayStart: new Date(Math.floor(h / (24 * HOUR_MS)) * 24 * HOUR_MS), dayStartEquity: cash0 } },
    },
  });
  const run = (hour: number) => runLiveAgentHour(agent.id, hour, { prisma, chain, now: () => hour + 60_000, orderDeadline: () => later });
  const decisions = () => prisma.decision.findMany({ where: { agentId: agent.id }, orderBy: { hour: "asc" } });

  await run(h);
  const afterBuy = await chain.snapshot(vault, WETH);
  const [d1] = await decisions();
  check("hour 1: buys a tenth of the cash, and stores the transaction", d1?.action === "buy" && !!d1.txHash && near(d1.fillNotional ?? 0, cash0 / 10, 0.01), d1?.explanation);
  check("hour 1: the stored position is the vault's", !!d1 && near(d1.cashAfter, fromUnits(afterBuy.stable, 6), 1e-6) && near(d1.qtyAfter, fromUnits(afterBuy.token, 18), 1e-12));
  check("hour 1: the price paid is the pool's, after its fee", !!d1 && near((d1.fillNotional! - d1.fillFee!) / d1.fillQty!, d1.fillPrice!, 1e-6) && d1.fillFee! > 0);
  const nav1 = d1!.equityAfter / d1!.basisAfter!;

  check("the owner withdraws $50 with their own wallet", await asOwner(vault, va, "withdraw", [LIVE_STABLE.address, toUnits(50, 6), cfg.owner]));
  const n1 = await nonce();
  await run(h + HOUR_MS);
  const d2 = (await decisions())[1];
  check("hour 2: the withdrawal is a flow of minus $50, and no order is placed", d2?.action === "hold" && near(d2.flowUsd ?? 0, -50, 0.01) && (await nonce()) === n1, `flow ${d2?.flowUsd?.toFixed(2)}`);
  check("hour 2: the withdrawal is not a loss", !!d2 && Math.abs(d2.equityAfter / d2.basisAfter! - nav1) < 0.01, `value per unit ${nav1.toFixed(5)} then ${(d2!.equityAfter / d2!.basisAfter!).toFixed(5)}`);

  check("the owner deposits $30 of USDG", await asOwner(LIVE_STABLE.address, ERC20_ABI as Abi, "transfer", [vault, toUnits(30, 6)]));
  await prisma.agentState.update({ where: { agentId: agent.id }, data: { avgEntry: (d1!.fillPrice ?? 0) * 1.4 } }); // far above the market: the stop is hit
  await run(h + 2 * HOUR_MS);
  const afterSell = await chain.snapshot(vault, WETH);
  const d3 = (await decisions())[2];
  check("hour 3: the deposit is a flow of plus $30", near(d3?.flowUsd ?? 0, 30, 0.01), `flow ${d3?.flowUsd?.toFixed(2)}`);
  check("hour 3: the stop sells the whole position through the real pool", d3?.action === "sell" && !!d3.txHash && afterSell.token === 0n && d3.qtyAfter === 0, d3?.explanation);
  check("hour 3: the stored cash is the vault's cash", !!d3 && near(d3.cashAfter, fromUnits(afterSell.stable, 6), 1e-6), `$${d3?.cashAfter.toFixed(4)}`);
  const n2 = await nonce();
  const again = await run(h + 2 * HOUR_MS);
  check("running the same hour again does nothing", again.skipped && (await nonce()) === n2 && (await decisions()).length === 3);
  const orders = await prisma.liveOrder.findMany({ orderBy: { hour: "asc" } });
  check("two orders on record, both done, each with its transaction", orders.length === 2 && orders.every((o) => o.status === "done" && !!o.txHash && !!o.amountOut));
  const fresh = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  const ret = (d3!.equityAfter / fresh.startingCash - 1) * 100;
  check("the return is a small number, not a deposit or a withdrawal", Math.abs(ret) < 2, `${ret.toFixed(3)}% after a $50 withdrawal and a $30 deposit`);

  console.log("\nAn exit the vault refuses stays an order to sell");
  // A plan that buys whenever it has no position, so the next hour opens one.
  const always: Plan = { markets: ["ETH"], kind: "entry_exit", entry: [{ signal: "rsi", op: "<", value: 101 }], exit: { stopLossPct: 15 }, filters: [], sizePctOfCash: 10 };
  await prisma.agent.update({ where: { id: agent.id }, data: { plan: always as unknown as Prisma.InputJsonValue } });
  const stateNow = () => prisma.agentState.findUniqueOrThrow({ where: { agentId: agent.id } });
  const last = async () => (await decisions()).at(-1)!;
  await run(h + 3 * HOUR_MS);
  const b2 = await last();
  check("hour 4: buys again", b2.action === "buy" && !!b2.txHash, b2.explanation);
  const held = (await chain.snapshot(vault, WETH)).token;
  await asOwner(vault, va, "setPaused", [true]);
  await prisma.agentState.update({ where: { agentId: agent.id }, data: { avgEntry: (b2.fillPrice ?? 0) * 1.4 } }); // the stop is hit
  await run(h + 4 * HOUR_MS);
  const refused = await last();
  check(
    "hour 5: the stop is reached, the vault is paused, and the decision says the position is still open",
    refused.action === "hold" && refused.execError === "the vault is paused" && /but the position was not sold: the vault is paused\. It is still open, and the agent tries again next hour\.$/.test(refused.explanation),
    refused.explanation,
  );
  check("hour 5: nothing was sold, and the exit is kept open on the record", (await chain.snapshot(vault, WETH)).token === held && (await stateNow()).exitPendingKind === "stop loss");
  await asOwner(vault, va, "setPaused", [false]);
  // By the next hour the position is no longer past its stop (its entry price is put back at the market's).
  await prisma.agentState.update({ where: { agentId: agent.id }, data: { avgEntry: refused.markPrice } });
  await run(h + 5 * HOUR_MS);
  const finished = await last();
  check(
    "hour 6: the vault is open again, and the position is sold although the stop no longer holds",
    finished.action === "sell" && !!finished.txHash && (await chain.snapshot(vault, WETH)).token === 0n && /^Sell\. Finishing the sale from /.test(finished.explanation),
    finished.explanation,
  );
  check("hour 6: no exit is left open", (await stateNow()).exitPendingSince === null && (await stateNow()).qty === 0);

  console.log("\nA buy leaves room in the vault's daily limit for its own sale");
  // Leave $40 of the daily limit, by the vault's own count of what was traded today.
  const used = 5000 - (await chain.snapshot(vault, WETH)).remainingUsd;
  await asOwner(vault, va, "setLimits", [100, parseUnits((used + 40).toFixed(6), 18)]);
  const room = (await chain.snapshot(vault, WETH)).remainingUsd;
  check("the vault has about $40 left to trade today", near(room, 40, 0.01), `$${room.toFixed(4)}`);
  await run(h + 6 * HOUR_MS);
  const small = await last();
  check(
    "hour 7: the buy is cut to what leaves room for its sale, and says so",
    small.action === "buy" && near(small.fillNotional ?? 0, (room * 0.98) / 2.2, 0.01) && /so that the sale of this position still fits in the vault's daily trading limit\.$/.test(small.explanation),
    small.explanation,
  );
  await prisma.agentState.update({ where: { agentId: agent.id }, data: { avgEntry: (small.fillPrice ?? 0) * 1.4 } }); // the stop is hit
  await run(h + 7 * HOUR_MS);
  const out = await last();
  check(
    "hour 8: the stop sells all of it inside the same day's limit",
    out.action === "sell" && out.execError === null && out.qtyAfter === 0 && (await chain.snapshot(vault, WETH)).token === 0n && !/still held/.test(out.explanation),
    out.explanation,
  );
  await asOwner(vault, va, "setLimits", [100, parseUnits("5000", 18)]);

  await prisma.$disconnect();
  console.log(failures.length ? `\n${failures.length} check(s) FAILED:\n  ${failures.join("\n  ")}` : "\nAll checks passed.");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
