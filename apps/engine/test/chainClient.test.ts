/**
 * The real chain client against a pretend node on this machine. What matters here is how it reads a node's
 * answers: a refusal by the vault ends the order with its reason, while a node's own trouble is thrown so that the
 * order is tried again. Reading one as the other either writes off an order that should have gone out, or retries
 * all hour an order the vault will never take.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LIVE_STABLE, LIVE_TOKENS, VAULT_ABI, type Address } from "@rationale/config";
import { encodeAbiParameters, encodeErrorResult, type Abi, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OrderPendingError, refusalReason, viemVaultChain, withoutUrls, type SwapOutcome, type VaultChain } from "../src/vault/chain";

type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
type Handler = (params: unknown[]) => Reply;

const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const FACTORY = "0x4444444444444444444444444444444444444444" as Address;
const ok = (result: unknown): Reply => ({ result });
const fail = (code: number, message: string, data?: unknown): Reply => ({ error: { code, message, data } });
const vaultError = (errorName: string, args: unknown[] = []) => encodeErrorResult({ abi: VAULT_ABI as Abi, errorName, args });

/** A node that answers each method the way the test says, and counts what it was asked. */
class PretendNode {
  handlers = new Map<string, Handler>();
  asked: string[] = [];
  private server: Server | null = null;
  url = "";

  async start() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        this.asked.push(method);
        const reply = (this.handlers.get(method) ?? (() => fail(-32601, `method ${method} is not mocked`)))(params ?? []);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/?key=SECRETTOKEN123`;
  }
  stop() {
    return new Promise<void>((done) => this.server?.close(() => done()) ?? done());
  }
  /** A healthy chain: the dry run works, gas can be estimated, fees and the nonce are known. */
  healthy() {
    this.asked = [];
    this.handlers = new Map<string, Handler>([
      ["eth_chainId", () => ok("0x1237")],
      ["eth_call", () => ok(encodeAbiParameters([{ type: "uint256" }], [5n * 10n ** 16n]))],
      ["eth_estimateGas", () => ok("0x493e0")],
      ["eth_getTransactionCount", () => ok("0x7")],
      ["eth_blockNumber", () => ok("0x10")],
      ["eth_getBlockByNumber", () => ok({ number: "0x10", timestamp: "0x6920c100", baseFeePerGas: "0x1312d00", hash: `0x${"11".repeat(32)}`, transactions: [] })],
      ["eth_maxPriorityFeePerGas", () => ok("0x0")],
      ["eth_gasPrice", () => ok("0x1312d00")],
      ["eth_sendRawTransaction", () => ok(`0x${"22".repeat(32)}`)],
      ["eth_getTransactionReceipt", () => ok(null)],
    ]);
  }
}

describe("the chain client reads a node's answers correctly", () => {
  const node = new PretendNode();
  let chain: VaultChain;
  let signed: Hex[] = [];
  const buy = (): Promise<SwapOutcome> =>
    chain.swap({ vault: VAULT, tokenIn: LIVE_STABLE.address, tokenOut: LIVE_TOKENS.ETH.address, feeTier: 100, amountIn: 100_000_000n, deadline: 1_900_000_000 }, async (h) => void signed.push(h));
  const sent = () => node.asked.includes("eth_sendRawTransaction");

  beforeAll(async () => {
    await node.start();
    chain = viemVaultChain({ rpcUrl: node.url, factory: FACTORY, privateKey: generatePrivateKey(), confirmTimeoutMs: 300 });
  });
  afterAll(() => node.stop());
  beforeEach(() => {
    node.healthy();
    signed = [];
  });

  it("a refusal by the vault ends the order with its reason, and nothing is signed", async () => {
    const cases: [Reply, string][] = [
      [fail(3, "execution reverted", vaultError("Paused")), "the vault is paused"],
      [fail(3, "execution reverted", vaultError("NotOperator")), "the agent's access to the vault was revoked"],
      [fail(3, "execution reverted", vaultError("DailyLimitExceeded", [1n, 0n])), "the vault's daily trading limit is used up"],
      [fail(3, "execution reverted", vaultError("OrderExpired", [1n])), "the order was placed too late in the hour"],
      // Some nodes wrap the same answer in their "internal error" code. The contract's own data still says what it is.
      [fail(-32603, "Internal error", vaultError("StaleOraclePrice", [LIVE_TOKENS.ETH.address])), "the price oracle had no fresh price"],
      [fail(-32603, "execution reverted", { data: vaultError("Paused") }), "the vault is paused"],
      // A revert with no data at all, the way some nodes report it.
      [fail(-32000, "execution reverted"), "the vault refused the order"],
      [fail(3, "execution reverted"), "the vault refused the order"],
    ];
    for (const [reply, reason] of cases) {
      node.healthy();
      node.handlers.set("eth_call", () => reply);
      expect(await buy(), JSON.stringify(reply)).toEqual({ ok: false, reason });
      expect(sent()).toBe(false);
    }
    expect(signed).toHaveLength(0);
  });

  it("a node's own trouble is not a refusal: it is thrown, so the order is tried again", async () => {
    for (const message of ["Internal error", "upstream request timeout", "header not found"]) {
      node.healthy();
      node.handlers.set("eth_call", () => fail(-32603, message));
      const out = await buy().then(
        (o) => o,
        (e: unknown) => e,
      );
      expect(out, message).toBeInstanceOf(Error);
      expect(out, message).not.toBeInstanceOf(OrderPendingError);
      expect(sent()).toBe(false);
    }
    expect(signed).toHaveLength(0);
  });

  it("says so when the agent's own wallet cannot pay the network fee", async () => {
    node.handlers.set("eth_estimateGas", () => fail(-32000, "gas required exceeds allowance (0)"));
    expect(await buy()).toEqual({ ok: false, reason: "the agent's own wallet is out of gas money" });
    expect(sent()).toBe(false);

    node.healthy();
    node.handlers.set("eth_sendRawTransaction", () => fail(-32000, "insufficient funds for gas * price + value"));
    const out = await buy();
    expect(out).toMatchObject({ ok: false, reason: "the agent's own wallet is out of gas money" });
    // It was signed and handed over before it was refused, so the record carries its hash.
    expect(signed).toHaveLength(1);
    expect(out.txHash).toBe(signed[0]);
  });

  it("once an order is signed, an unclear answer is 'not known yet', never 'it did not happen'", async () => {
    for (const reply of [fail(-32603, "Internal error"), fail(-32000, "already known"), fail(-32000, "nonce too low")]) {
      node.healthy();
      signed = [];
      node.handlers.set("eth_sendRawTransaction", () => reply);
      await expect(buy(), JSON.stringify(reply)).rejects.toBeInstanceOf(OrderPendingError);
      expect(signed).toHaveLength(1);
    }
    // Sent, but no receipt in time: also not known yet.
    node.healthy();
    await expect(buy()).rejects.toBeInstanceOf(OrderPendingError);
  });

  it("tells an unknown transaction from one it could not ask about", async () => {
    expect(await chain.outcomeOf(`0x${"ab".repeat(32)}`, VAULT)).toBeNull();
    node.handlers.set("eth_getTransactionReceipt", () => fail(-32603, "Internal error"));
    await expect(chain.outcomeOf(`0x${"ab".repeat(32)}`, VAULT)).rejects.toBeInstanceOf(Error);
  });

  it("gives the chain's own time, and keeps the RPC address out of what it reports", async () => {
    expect(await chain.chainTime()).toBe(0x6920c100);
    // A node that cannot be reached at all: the library's error names the address it tried, access key included.
    const away = viemVaultChain({ rpcUrl: "http://127.0.0.1:1/?key=SECRETTOKEN123", factory: FACTORY, privateKey: generatePrivateKey() });
    const err = await away.swap({ vault: VAULT, tokenIn: LIVE_STABLE.address, tokenOut: LIVE_TOKENS.ETH.address, feeTier: 100, amountIn: 1n, deadline: 1_900_000_000 }, async () => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OrderPendingError);
    expect(String((err as Error).message)).toContain("SECRETTOKEN123");
    expect(withoutUrls(err)).not.toContain("SECRETTOKEN123");
    expect(refusalReason(err)).toBe("the network refused the order");
  });
});
