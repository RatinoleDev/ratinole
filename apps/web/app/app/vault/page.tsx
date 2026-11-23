"use client";

/**
 * The vault: real money on Robinhood Chain that only its owner can withdraw. Everything here is read straight
 * from the chain, and every change is a transaction the owner signs in their own wallet. The site holds no key.
 * Until live trading is open on this site, the page is a preview of how a vault works.
 */
import { CHAIN, ERC20_ABI, FACTORY_ABI, LIVE, LIVE_TOKENS, VAULT_ABI, explorerAddress, fromUnits, parseAmount, type ChainConfigDTO } from "@rationale/config";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, zeroAddress, type Abi, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useMode } from "../../../components/app/Mode";
import { ConnectPanel, useSession } from "../../../components/app/Session";
import { SwapEth } from "../../../components/app/SwapEth";
import { shortAddress, usd } from "../../../lib/format";
import { useTx } from "../../../lib/tx";

/**
 * Assumptions behind the figure in the "stolen agent key" box, shown in its formula text. It describes normal
 * conditions and is not a maximum: the box says so, and says what makes it larger.
 */
const POOL_FEE_PCT = 0.3;
const ORACLE_LAG_PCT = 0.5;
const worstCase = (limit: number, slipPct: number) => (limit * (slipPct + POOL_FEE_PCT + ORACLE_LAG_PCT)) / 100;

const PERMISSIONS: [string, boolean, boolean, boolean][] = [
  ["Withdraw", true, false, false],
  ["Swap inside the vault", false, true, false],
  ["Change limits", true, false, false],
  ["Pause or revoke", true, false, false],
  ["Move the vault to a new wallet", true, false, false],
];

function WhoCanDoWhat({ hint, caption }: { hint: string; caption?: string }) {
  return (
    <div className="panel">
      <h2>Who can do what</h2>
      <p className="hint">{hint}</p>
      <table className="perm">
        {caption && (
          <caption className="hint" style={{ textAlign: "left", captionSide: "bottom", marginTop: 12 }}>
            {caption}
          </caption>
        )}
        <thead>
          <tr>
            <th />
            <th>You</th>
            <th>Agent</th>
            <th>Anyone</th>
          </tr>
        </thead>
        <tbody>
          {PERMISSIONS.map(([label, ...who]) => (
            <tr key={label}>
              <td>{label}</td>
              {who.map((v, i) => (
                <td key={i} className={v ? "yes" : "no"}>
                  {v ? "Yes" : "No"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The two limits a vault enforces, with what they mean in the worst case. */
function LimitSliders({ limit, slip, setLimit, setSlip, disabled }: { limit: number; slip: number; setLimit: (n: number) => void; setSlip: (n: number) => void; disabled?: boolean }) {
  return (
    <>
      <label>
        <span>
          Daily trading limit <b className="num">${limit.toLocaleString("en-US")}</b>
        </span>
        <input type="range" min={10} max={5000} step={10} value={Math.min(5000, Math.max(10, limit))} onChange={(e) => setLimit(Number(e.target.value))} disabled={disabled} />
      </label>
      <p className="hint" style={{ margin: 0 }}>
        Buys and sales both count towards it. An agent that has an exit rule never holds more than it could sell in one day: with nothing held, its largest
        buy is <b className="num">${Math.floor((limit * LIVE.limitMargin) / LIVE.exitRoomFactor).toLocaleString("en-US")}</b>.
      </p>
      <label>
        <span>
          Maximum slippage against the oracle <b className="num">{slip.toFixed(1)}%</b>
        </span>
        <input type="range" min={0.1} max={5} step={0.1} value={slip} onChange={(e) => setSlip(Number(e.target.value))} disabled={disabled} />
      </label>
      <div className="worst">
        <small>What a stolen agent key could cost you in one 24-hour window, in normal conditions</small>
        <b className="num">${worstCase(limit, slip).toFixed(2)}</b>
        <small>
          Daily limit × (slippage + {POOL_FEE_PCT}% pool fee + {ORACLE_LAG_PCT}% oracle lag). This is not a maximum. Two windows can meet, which doubles it. If
          the price feed stops updating while the market moves, the loss in a window can be as large as the daily limit times that move. You stop it by pausing.
        </small>
      </div>
    </>
  );
}

/** Shown while live trading is not open: how a vault will work. */
function VaultPreview() {
  const [limit, setLimit] = useState<number>(LIVE.defaults.dailyLimitUsd);
  const [slip, setSlip] = useState(1);
  const soon = "Vaults open with live trading";
  return (
    <section>
      <div className="grid2">
        <div className="panel">
          <h2>Limits the contract enforces</h2>
          <p className="hint">The agent cannot change these. Only your wallet can.</p>
          <div className="ctrl">
            <LimitSliders limit={limit} slip={slip} setLimit={setLimit} setSlip={setSlip} />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn sm" disabled title={soon}>
                Pause vault
              </button>
              <button className="btn sm ghost" disabled title={soon}>
                Revoke agent access
              </button>
              <button className="btn sm ghost" disabled title={soon}>
                Withdraw
              </button>
            </div>
          </div>
        </div>
        <WhoCanDoWhat hint="No vault yet. Vaults open with live trading." caption="How a vault will work once live trading opens." />
      </div>
    </section>
  );
}

/**
 * Shown only while live trading is paused. While it is open the page carries no banner (the owner's choice): that
 * the contracts are not audited and that money can be lost is said where a live agent is launched, and on the
 * risk page.
 */
function RiskNote({ trading }: { trading: boolean }) {
  if (trading) return null;
  return (
    <p className="risknote" role="note">
      <b>Live trading is paused.</b> No agent is trading right now. Your vault is still yours: you can see it and withdraw from it at any time.
    </p>
  );
}

function CreateVault({ chain, canSign, degraded, onCreated }: { chain: ChainConfigDTO; canSign: boolean; degraded: boolean; onCreated: () => void }) {
  const [limit, setLimit] = useState(chain.limits.defaultDailyLimitUsd);
  const [slip, setSlip] = useState(chain.limits.defaultSlippageBps / 100);
  const tx = useTx(onCreated);
  const create = () =>
    tx.send(
      "create",
      { address: chain.factory as Address, abi: FACTORY_ABI as Abi, functionName: "createVault", args: [Math.round(slip * 100), parseUnits(String(limit), 18)] },
      "Your vault is ready.",
    );
  return (
    <div className="panel">
      <h2>Create your vault</h2>
      <p className="hint">
        One transaction in your wallet, for a small network fee. The vault is yours: only your wallet can withdraw, and the agent can only swap inside it, within
        these limits. You can change them at any time.
      </p>
      <div className="ctrl">
        <LimitSliders limit={limit} slip={slip} setLimit={setLimit} setSlip={setSlip} />
        <div>
          <button className="btn blue" onClick={() => void create()} disabled={!canSign || !!tx.busy || degraded}>
            {tx.busy ? "Check your wallet…" : "Create my vault"}
          </button>
          {degraded && <p className="hint">Creating a vault is off until this site's server answers again.</p>}
        </div>
      </div>
    </div>
  );
}

type Asset = { symbol: string; address: Address; decimals: number; raw: bigint; price: number | null };

/**
 * One complete reading of the vault. It exists only when every call it needs answered: a balance or a limit
 * that could not be read is never shown as zero or as a default. A token's price alone may be missing (the
 * oracle refuses to give a stale one), and is then shown as missing.
 */
interface Reading {
  paused: boolean;
  operator: Address;
  slipBps: number;
  limit: bigint;
  remaining: bigint;
  walletStable: bigint;
  /** The agent's key, as the factory on-chain names it today. */
  agentKey: Address;
  /** Who the vault itself says owns it. The factory's list only says where to look. */
  vaultOwner: Address;
  /** A wallet the vault has been offered to, and until when it can accept (seconds). */
  pendingOwner: Address;
  pendingUntil: number;
  /** The recovery wallet, and from when it can take the vault if it has started a claim (seconds; 0 = no claim). */
  recovery: Address;
  recoveryReadyAt: number;
  assets: Asset[];
}
/** Calls before the per-token ones in the batch. */
const CORE = 13;
type Outcome = { status: "success" | "failure"; result?: unknown };

function toReading(r: readonly Outcome[] | undefined, chain: ChainConfigDTO): Reading | null {
  if (!r) return null;
  const ok = (i: number) => r[i]?.status === "success";
  const at = <T,>(i: number) => r[i]!.result as T;
  for (let i = 0; i < CORE; i++) if (!ok(i)) return null;
  const assets: Asset[] = [{ symbol: chain.stable.symbol, address: chain.stable.address as Address, decimals: chain.stable.decimals, raw: at<bigint>(5), price: 1 }];
  for (const [k, t] of chain.tokens.entries()) {
    const bal = CORE + 2 * k;
    if (!ok(bal)) return null;
    assets.push({ symbol: t.symbol, address: t.address as Address, decimals: t.decimals, raw: at<bigint>(bal), price: ok(bal + 1) ? fromUnits(at<bigint>(bal + 1), 18) : null });
  }
  return {
    paused: at<boolean>(0),
    operator: at<Address>(1),
    slipBps: Number(at<number>(2)),
    limit: at<bigint>(3),
    remaining: at<bigint>(4),
    walletStable: at<bigint>(6),
    agentKey: at<Address>(7),
    vaultOwner: at<Address>(8),
    pendingOwner: at<Address>(9),
    pendingUntil: Number(at<bigint>(10)),
    recovery: at<Address>(11),
    recoveryReadyAt: Number(at<bigint>(12)),
    assets,
  };
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function ManageVault({
  chain,
  vault,
  owner,
  ownerIs,
  canSign,
  degraded,
  onCreated,
}: {
  chain: ChainConfigDTO;
  vault: Address;
  owner: Address;
  /** How `owner` is known, for the sentence that says where a withdrawal goes. */
  ownerIs: string;
  canSign: boolean;
  /** The site's server cannot be reached: nothing that sends money in or grants access is offered. */
  degraded: boolean;
  onCreated: () => void;
}) {
  // Read as one batch. The calls are a plain list, so results are picked by position in `toReading`.
  const stable = chain.stable;
  const contracts = useMemo(() => {
    const call = (address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) => ({ address: address as Address, abi, functionName, args, chainId: CHAIN.id });
    const va = VAULT_ABI as Abi;
    const erc = ERC20_ABI as Abi;
    return [
      call(vault, va, "paused"),
      call(vault, va, "operator"),
      call(vault, va, "maxSlippageBps"),
      call(vault, va, "dailyLimitUsd"),
      call(vault, va, "remainingDailyUsd"),
      call(stable.address, erc, "balanceOf", [vault]),
      call(stable.address, erc, "balanceOf", [owner]),
      call(chain.factory as Address, FACTORY_ABI as Abi, "defaultOperator"),
      call(vault, va, "owner"),
      call(vault, va, "pendingOwner"),
      call(vault, va, "pendingOwnerExpiresAt"),
      call(vault, va, "recovery"),
      call(vault, va, "recoveryReadyAt"),
      ...chain.tokens.flatMap((t) => [call(t.address, erc, "balanceOf", [vault]), call(vault, va, "priceUsd", [t.address])]),
    ];
  }, [chain.factory, chain.tokens, owner, stable.address, vault]);
  const reads = useReadContracts({ allowFailure: true, contracts, query: { refetchInterval: 20_000 } });
  const tx = useTx(() => void reads.refetch());

  // The newest complete reading. If a later poll fails, or comes back with a hole in it, the last complete one
  // stays on screen, marked as old, instead of zeros.
  const latest = useMemo(() => toReading(reads.data as readonly Outcome[] | undefined, chain), [reads.data, chain]);
  const [kept, setKept] = useState<{ reading: Reading; at: number } | null>(null);
  useEffect(() => {
    if (latest) setKept({ reading: latest, at: reads.dataUpdatedAt || Date.now() });
  }, [latest, reads.dataUpdatedAt]);
  const v = latest ?? kept?.reading ?? null;
  const old = !!v && (reads.isError || !latest);

  // The sliders follow the vault until the owner moves one. Only a value the owner chose is ever sent.
  const [limit, setLimit] = useState<number | null>(null);
  const [slip, setSlip] = useState<number | null>(null);
  const liveLimit = v ? Math.round(fromUnits(v.limit, 18)) : null;
  const liveSlip = v ? v.slipBps / 100 : null;
  useEffect(() => {
    // After a save the chain agrees with the sliders again: let them follow the chain.
    if (limit != null && limit === liveLimit) setLimit(null);
    if (slip != null && slip === liveSlip) setSlip(null);
  }, [limit, liveLimit, slip, liveSlip]);

  const [deposit, setDeposit] = useState("");
  const [take, setTake] = useState("");
  const [takeSym, setTakeSym] = useState(stable.symbol);

  // A transaction the wallet sent that the chain had not confirmed when the page stopped waiting. The note about
  // it stays until the vault's reading changes (it went through, or something else happened) or it is hidden.
  const print = v
    ? [v.paused, v.operator, v.slipBps, v.limit, v.walletStable, v.vaultOwner, v.pendingOwner, v.recovery, v.recoveryReadyAt, ...v.assets.map((a) => a.raw)].join("|")
    : "";
  const [printWhenSent, setPrintWhenSent] = useState<string | null>(null);
  const { unconfirmed, dismissUnconfirmed } = tx;
  useEffect(() => {
    if (!unconfirmed) {
      if (printWhenSent !== null) setPrintWhenSent(null);
    } else if (printWhenSent === null) {
      setPrintWhenSent(print);
      // The amounts are cleared, so the same transaction cannot be sent a second time by one more click.
      setDeposit("");
      setTake("");
    } else if (print !== printWhenSent) {
      dismissUnconfirmed();
    }
  }, [unconfirmed, print, printWhenSent, dismissUnconfirmed]);

  if (!v) {
    return (
      <div className="panel">
        <p className="empty">
          {reads.isLoading
            ? "Reading your vault from Robinhood Chain…"
            : "Your vault could not be read from Robinhood Chain just now. It is untouched; this page tries again every few seconds."}
        </p>
      </div>
    );
  }

  // The factory's list says where a wallet's vault is; only the vault says whose it is. A vault that has moved
  // to another wallet is never shown as "yours", and nothing can be sent to it from here.
  if (!sameAddress(v.vaultOwner, owner)) {
    return (
      <div className="vaultcol">
        <div className="panel">
          <h2>This vault has moved</h2>
          <p className="hint">
            The vault that was listed for your wallet,{" "}
            <a href={explorerAddress(chain.explorerUrl, vault)} target="_blank" rel="noopener noreferrer">
              {shortAddress(vault)}
            </a>
            , now belongs to {shortAddress(v.vaultOwner)}. You cannot withdraw from it, and you should not send money to it. If you did not hand it over or set a
            recovery wallet yourself, someone else has taken it.
          </p>
        </div>
        <CreateVault chain={chain} canSign={canSign} degraded={degraded} onCreated={onCreated} />
      </div>
    );
  }

  const assets = v.assets;
  const takeAsset = assets.find((a) => a.symbol === takeSym) ?? assets[0]!;
  const nowSeconds = Date.now() / 1000;
  const offered = v.pendingOwner !== zeroAddress && v.pendingUntil >= nowSeconds;
  const claimed = v.recoveryReadyAt > 0;
  const dep = parseAmount(deposit, stable.decimals);
  const out = parseAmount(take, takeAsset.decimals);
  const depositOk = dep.ok && dep.raw <= v.walletStable;
  const takeOk = out.ok && out.raw <= takeAsset.raw;
  const off = !canSign || !!tx.busy;
  const vaultAbi = VAULT_ABI as Abi;

  const unpriced = assets.filter((a) => a.raw > 0n && a.price == null).map((a) => a.symbol);
  const total = assets.reduce((sum, a) => sum + fromUnits(a.raw, a.decimals) * (a.price ?? 0), 0);
  // Three states, not two: another key holding access must never read as "off".
  const access: "agent" | "none" | "other" = v.operator === zeroAddress ? "none" : sameAddress(v.operator, v.agentKey) ? "agent" : "other";

  const shownLimit = limit ?? liveLimit!;
  const shownSlip = slip ?? liveSlip!;
  const limitsChanged = (limit != null && limit !== liveLimit) || (slip != null && slip !== liveSlip);
  // The limit that was not touched is sent back exactly as the vault holds it, not as the rounded number on screen.
  const saveLimits = () =>
    tx.send(
      "limits",
      { address: vault, abi: vaultAbi, functionName: "setLimits", args: [slip != null ? Math.round(slip * 100) : v.slipBps, limit != null ? parseUnits(String(limit), 18) : v.limit] },
      "Limits saved.",
    );
  const setOperator = (label: string, to: Address, done: string) => tx.send(label, { address: vault, abi: vaultAbi, functionName: "setOperator", args: [to] }, done);

  return (
    <div className="vaultcol">
      <div className="panel">
        <h2>Your vault</h2>
        <p className="hint">
          <a href={explorerAddress(chain.explorerUrl, vault)} target="_blank" rel="noopener noreferrer">
            {shortAddress(vault)} on the explorer ↗
          </a>
          . Only your wallet can withdraw.
        </p>
        {old && (
          <p className="risknote" role="status">
            Robinhood Chain could not be reached just now. These numbers are from {new Date(kept?.at ?? Date.now()).toLocaleTimeString()}; the page keeps trying.
          </p>
        )}
        {unconfirmed && (
          <div className="risknote" role="status">
            <b>Your last transaction is not confirmed yet.</b> It may still go through. Check your wallet's activity before you send it again. This note goes away
            when the numbers on this page change.
            <div style={{ marginTop: 10 }}>
              <button className="btn sm ghost" type="button" onClick={dismissUnconfirmed}>
                Hide this note
              </button>
            </div>
          </div>
        )}
        {claimed && (
          <div className="risknote" role="alert">
            <b>A recovery claim is running on this vault.</b> The recovery wallet {shortAddress(v.recovery)} can take the whole vault{" "}
            {v.recoveryReadyAt > nowSeconds ? `from ${when(v.recoveryReadyAt)}` : "now"}. If you did not start that yourself, stop it now.
            <div style={{ marginTop: 10 }}>
              <button className="btn sm" disabled={off} onClick={() => void tx.send("stopclaim", { address: vault, abi: vaultAbi, functionName: "cancelRecovery", args: [] }, "The claim was stopped.")}>
                {tx.busy === "stopclaim" ? "Check your wallet…" : "Stop the claim"}
              </button>
            </div>
          </div>
        )}
        {offered && (
          <div className="risknote" role="alert">
            <b>This vault has been offered to {shortAddress(v.pendingOwner)}.</b> That wallet can take the whole vault until {when(v.pendingUntil)}. If you did not
            offer it yourself, cancel it now.
            <div style={{ marginTop: 10 }}>
              <button
                className="btn sm"
                disabled={off}
                onClick={() => void tx.send("canceloffer", { address: vault, abi: vaultAbi, functionName: "transferOwnership", args: [zeroAddress] }, "The offer was cancelled.")}
              >
                {tx.busy === "canceloffer" ? "Check your wallet…" : "Cancel the offer"}
              </button>
            </div>
          </div>
        )}
        {!claimed && v.recovery !== zeroAddress && (
          <p className="hint">
            Recovery wallet: {shortAddress(v.recovery)}. It can start a claim on this vault and take it after the waiting time you set. Anything you do with the vault
            stops a claim.
          </p>
        )}
        <div className="vtotal">
          <small>{unpriced.length ? `Value now, without ${unpriced.join(" and ")}` : "Value now"}</small>
          <b className="num">{usd(total, 2)}</b>
        </div>
        {unpriced.length > 0 && (
          <p className="hint">The price oracle has no fresh price for {unpriced.join(" and ")} right now, so it is left out of the total. The tokens are in your vault all the same.</p>
        )}
        <table className="vassets">
          <tbody>
            {assets.map((a) => {
              const qty = fromUnits(a.raw, a.decimals);
              return (
                <tr key={a.symbol}>
                  <td>{a.symbol}</td>
                  <td className="r num">{qty === 0 ? "0" : qty >= 1 ? qty.toLocaleString("en-US", { maximumFractionDigits: 4 }) : qty.toPrecision(4)}</td>
                  <td className="r num">{a.price == null ? "no price now" : usd(qty * a.price, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="vchips">
          <span className={`stat ${access === "agent" ? "on" : "off"}`}>{access === "agent" ? "Agent access on" : access === "none" ? "Agent access off" : "Another key has access"}</span>
          <span className={`stat ${v.paused ? "off" : "on"}`}>{v.paused ? "Paused" : "Not paused"}</span>
          <span className="stat">
            {usd(fromUnits(v.remaining, 18))} of {usd(fromUnits(v.limit, 18))} left to trade in this 24-hour window
          </span>
        </div>
      </div>

      <div className="panel">
        <h2>Deposit and withdraw</h2>
        <p className="hint">A deposit moves USDG from your wallet into your vault. A withdrawal sends it back to your wallet, at any time, even while paused.</p>
        {/* For a wallet that holds ETH and no USDG yet. Its own swap, signed in the wallet. */}
        <SwapEth owner={owner} off={off || degraded} busy={tx.busy} ethPrice={assets.find((a) => sameAddress(a.address, LIVE_TOKENS.ETH.address))?.price ?? null} send={tx.send} />
        <div className="vform">
          <label htmlFor="v-dep">Deposit USDG</label>
          <div className="vfield">
            <input id="v-dep" type="text" inputMode="decimal" placeholder="0.00" value={deposit} onChange={(e) => setDeposit(e.target.value)} aria-describedby="v-dep-note" />
            <button className="btn sm ghost" type="button" onClick={() => setDeposit(formatUnits(v.walletStable, stable.decimals))}>
              Max
            </button>
            <button
              className="btn sm blue"
              disabled={off || !depositOk || degraded}
              onClick={() =>
                dep.ok &&
                void tx
                  .send("deposit", { address: stable.address as Address, abi: ERC20_ABI as Abi, functionName: "transfer", args: [vault, dep.raw] }, "Deposited into your vault.")
                  .then((result) => result !== "failed" && setDeposit(""))
              }
            >
              {tx.busy === "deposit" ? "Check your wallet…" : "Deposit"}
            </button>
          </div>
          <small id="v-dep-note">
            {degraded
              ? "Deposits are off until this site's server answers again. Withdrawals work."
              : !dep.ok && dep.error
                ? dep.error
                : dep.ok && !depositOk
                  ? `That is more than the ${usd(fromUnits(v.walletStable, stable.decimals), 2)} of ${stable.symbol} in your wallet.`
                  : `In your wallet: ${usd(fromUnits(v.walletStable, stable.decimals), 2)} of ${stable.symbol}.${dep.ok && dep.note ? ` ${dep.note}` : ""}`}
          </small>
        </div>
        <div className="vform">
          <label htmlFor="v-out">Withdraw to your wallet</label>
          <div className="vfield">
            <select aria-label="Token to withdraw" value={takeSym} onChange={(e) => (setTakeSym(e.target.value), setTake(""))}>
              {assets.map((a) => (
                <option key={a.symbol}>{a.symbol}</option>
              ))}
            </select>
            <input id="v-out" type="text" inputMode="decimal" placeholder="0.00" value={take} onChange={(e) => setTake(e.target.value)} aria-describedby="v-out-note" />
            <button className="btn sm ghost" type="button" onClick={() => setTake(formatUnits(takeAsset.raw, takeAsset.decimals))}>
              Max
            </button>
            <button
              className="btn sm"
              disabled={off || !takeOk}
              onClick={() =>
                out.ok &&
                void tx
                  .send("withdraw", { address: vault, abi: vaultAbi, functionName: "withdraw", args: [takeAsset.address, out.raw, owner] }, "Withdrawn to your wallet.")
                  .then((result) => result !== "failed" && setTake(""))
              }
            >
              {tx.busy === "withdraw" ? "Check your wallet…" : "Withdraw"}
            </button>
          </div>
          <small id="v-out-note">
            {!out.ok && out.error ? out.error : out.ok && !takeOk ? `That is more than the vault holds of ${takeAsset.symbol}.` : out.ok && out.note ? out.note : `It goes to ${shortAddress(owner)}, ${ownerIs}.`}
          </small>
        </div>
      </div>

      <div className="panel">
        <h2>Limits the contract enforces</h2>
        <p className="hint">The agent cannot change these. Only your wallet can.</p>
        <div className="ctrl">
          <LimitSliders limit={shownLimit} slip={shownSlip} setLimit={setLimit} setSlip={setSlip} disabled={off || old} />
          {old && (
            <p className="hint" role="note">
              Saving limits and switching agent access are off until Robinhood Chain answers again. Both would be built from the numbers above, which may be out of
              date. Withdraw, pause and revoke still work.
            </p>
          )}
          {degraded && access !== "agent" && <p className="hint">Giving the agent access is off until this site's server answers again.</p>}
          {access === "other" && (
            <p className="risknote" role="note">
              <b>A key that is not Ratinole's agent can trade this vault:</b>{" "}
              <a href={explorerAddress(chain.explorerUrl, v.operator)} target="_blank" rel="noopener noreferrer">
                {shortAddress(v.operator)}
              </a>
              . If you did not set that yourself, revoke it. Ratinole's agent cannot trade until you switch access to it.
            </p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn sm blue" disabled={off || old || !limitsChanged} onClick={() => void saveLimits()}>
              {tx.busy === "limits" ? "Check your wallet…" : "Save limits"}
            </button>
            <button
              className="btn sm"
              disabled={off}
              onClick={() => void tx.send("pause", { address: vault, abi: vaultAbi, functionName: "setPaused", args: [!v.paused] }, v.paused ? "Vault resumed." : "Vault paused. The agent cannot trade it.")}
            >
              {tx.busy === "pause" ? "Check your wallet…" : v.paused ? "Resume vault" : "Pause vault"}
            </button>
            {access !== "none" && (
              <button className="btn sm ghost" disabled={off} onClick={() => void setOperator("revoke", zeroAddress, "Access revoked. No key can trade this vault now.")}>
                {tx.busy === "revoke" ? "Check your wallet…" : access === "agent" ? "Revoke agent access" : "Revoke that key's access"}
              </button>
            )}
            {access !== "agent" && (
              <button
                className="btn sm ghost"
                disabled={off || degraded || old || v.agentKey === zeroAddress}
                onClick={() => void setOperator("access", v.agentKey, "Ratinole's agent can trade this vault now.")}
              >
                {tx.busy === "access" ? "Check your wallet…" : access === "none" ? "Restore agent access" : "Switch access to Ratinole's agent"}
              </button>
            )}
          </div>
          {/* A dimmed "Save limits" with no reason next to it reads as broken. It is dimmed because nothing changed. */}
          {!limitsChanged && !old && (
            <p className="hint" style={{ margin: "10px 0 0" }}>
              These are the limits your vault holds now: {usd(fromUnits(v.limit, 18), 0)} a day and {shownSlip.toFixed(1)}% slippage. Move a slider to change them, then save.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveVault({ chain, degraded }: { chain: ChainConfigDTO; degraded: boolean }) {
  const { me, unreachable, connectWallet, signingIn } = useSession();
  const { address, isConnected } = useAccount();
  // Normally the page is for the wallet that signed in. When the site's server cannot say who is signed in, the
  // wallet connected in this browser is the only identity there is. That is enough to look at that wallet's own
  // vault and to take money out of it: every vault action is signed by the wallet and checked by the vault's
  // contract, never by this site. Nothing that sends money in or grants access is offered in that state.
  const offline = !me && unreachable;
  const who = me?.address ?? (offline && isConnected && address ? address : null);
  const owner = (who ?? zeroAddress) as Address;
  const vaultQ = useReadContract({
    address: chain.factory as Address,
    abi: FACTORY_ABI,
    functionName: "vaultOf",
    args: [owner],
    chainId: CHAIN.id,
    query: { enabled: !!who, refetchInterval: 20_000 },
  });
  if (!who) {
    if (!offline) return <ConnectPanel text="Sign in with your wallet to create or manage your vault." />;
    return (
      <section>
        <div className="panel connect">
          <p>
            <b>This site's server cannot be reached, so you cannot sign in right now.</b> Connect your wallet to see its vault straight from Robinhood Chain. You can
            withdraw, pause and revoke. Deposits and new vaults are off until the server answers again.
          </p>
          <button className="btn sm" onClick={() => void connectWallet()} disabled={signingIn}>
            {signingIn ? "Check your wallet…" : "Connect wallet"}
          </button>
        </div>
      </section>
    );
  }
  const limited = degraded || offline;
  // Changing the vault needs the wallet it is shown for to be connected in this browser.
  const canSign = isConnected && address?.toLowerCase() === who.toLowerCase();
  // Once the answer is known it is kept: a later poll that fails must not take the vault off the screen, or
  // offer "create a vault" to someone who has one.
  const known = vaultQ.data !== undefined;
  const vault = vaultQ.data && vaultQ.data !== zeroAddress ? (vaultQ.data as Address) : null;
  return (
    <section>
      <RiskNote trading={chain.trading} />
      {limited && (
        <p className="risknote" role="status">
          <b>This site's server cannot be reached.</b>{" "}
          {offline
            ? "You are not signed in, so this page shows the vault of the wallet connected in this browser, straight from Robinhood Chain"
            : "Your vault is shown straight from Robinhood Chain"}
          {degraded ? ", at the contract address this device saw last time" : ""}. You can withdraw, pause and revoke. Deposits and new vaults are off until the
          server answers again.
        </p>
      )}
      {!canSign && (
        <div className="panel connect" style={{ marginBottom: 20 }}>
          <p>
            {isConnected
              ? `Your wallet is on another account. Switch it to ${shortAddress(who)}, the account you signed in with, to change the vault.`
              : "Your wallet is not connected in this browser. Connect it to change the vault; you can still see it below."}
          </p>
          {!isConnected && (
            <button className="btn sm" onClick={() => void connectWallet()} disabled={signingIn}>
              {signingIn ? "Check your wallet…" : "Connect wallet"}
            </button>
          )}
        </div>
      )}
      <div className="grid2">
        {!known ? (
          <div className="panel">
            <p className="empty">
              {vaultQ.isError
                ? "Robinhood Chain could not be reached, so this page cannot tell yet whether you have a vault. If you have one, it is untouched. Trying again…"
                : "Looking for your vault on Robinhood Chain…"}
            </p>
          </div>
        ) : vault ? (
          <ManageVault
            chain={chain}
            vault={vault}
            owner={owner}
            ownerIs={offline ? "the wallet connected in this browser" : "the wallet you signed in with"}
            canSign={canSign}
            degraded={limited}
            onCreated={() => void vaultQ.refetch()}
          />
        ) : (
          <CreateVault chain={chain} canSign={canSign} degraded={limited} onCreated={() => void vaultQ.refetch()} />
        )}
        <WhoCanDoWhat hint="Enforced by your vault's contract, not by this site." />
      </div>
    </section>
  );
}

export default function VaultPage() {
  const { liveOn, chain, status, degraded, retry } = useMode();
  // "Vaults are not open" is only said once the server has said so.
  if (status === "loading") {
    return (
      <div className="panel">
        <p className="empty">Checking whether live trading is open…</p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="panel connect">
        <p>This site's server could not be reached, so this page cannot show a vault right now. If you have a vault, it is untouched on Robinhood Chain.</p>
        <button className="btn sm" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  if (!liveOn || !chain) return <VaultPreview />;
  return <LiveVault chain={chain} degraded={degraded} />;
}
