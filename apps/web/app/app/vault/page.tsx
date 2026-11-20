"use client";

/**
 * The vault: real money on Robinhood Chain that only its owner can withdraw. Everything here is read straight
 * from the chain, and every change is a transaction the owner signs in their own wallet. The site holds no key.
 * Until live trading is open on this site, the page is a preview of how a vault works.
 */
import { CHAIN, ERC20_ABI, FACTORY_ABI, VAULT_ABI, explorerAddress, fromUnits, type ChainConfigDTO } from "@rationale/config";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, zeroAddress, type Abi, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useMode } from "../../../components/app/Mode";
import { ConnectPanel, useSession } from "../../../components/app/Session";
import { shortAddress, usd } from "../../../lib/format";
import { useTx } from "../../../lib/tx";

/** Assumptions behind the worst-case figure, shown in the formula text. */
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
        <input type="range" min={50} max={5000} step={50} value={Math.min(5000, Math.max(50, limit))} onChange={(e) => setLimit(Number(e.target.value))} disabled={disabled} />
      </label>
      <label>
        <span>
          Maximum slippage against the oracle <b className="num">{slip.toFixed(1)}%</b>
        </span>
        <input type="range" min={0.1} max={5} step={0.1} value={slip} onChange={(e) => setSlip(Number(e.target.value))} disabled={disabled} />
      </label>
      <div className="worst">
        <small>Most a stolen agent key could cost you per day</small>
        <b className="num">${worstCase(limit, slip).toFixed(2)}</b>
        <small>
          Daily limit × (slippage + {POOL_FEE_PCT}% pool fee + {ORACLE_LAG_PCT}% oracle lag). You stop it by pausing.
        </small>
      </div>
    </>
  );
}

/** Shown while live trading is not open: how a vault will work. */
function VaultPreview() {
  const [limit, setLimit] = useState(500);
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

function RiskNote({ cap, trading }: { cap: number | null; trading: boolean }) {
  if (!trading) {
    return (
      <p className="risknote" role="note">
        <b>Live trading is paused.</b> No agent is trading right now. Your vault is still yours: you can see it and withdraw from it at any time.
      </p>
    );
  }
  return (
    <p className="risknote" role="note">
      <b>Real money, beta.</b> The vault contracts have not had an independent security audit yet. Only deposit money you can afford to lose
      {cap != null ? `; a live agent starts on at most $${cap.toLocaleString("en-US")}` : ""}. Backtests and past results do not predict future returns.
    </p>
  );
}

function CreateVault({ chain, canSign, onCreated }: { chain: ChainConfigDTO; canSign: boolean; onCreated: () => void }) {
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
          <button className="btn blue" onClick={() => void create()} disabled={!canSign || !!tx.busy}>
            {tx.busy ? "Check your wallet…" : "Create my vault"}
          </button>
        </div>
      </div>
    </div>
  );
}

type Asset = { symbol: string; address: Address; decimals: number; raw: bigint; price: number | null };

function ManageVault({ chain, vault, owner, canSign }: { chain: ChainConfigDTO; vault: Address; owner: Address; canSign: boolean }) {
  // Read as one batch. The calls are a plain list, so results are picked by position below.
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
      ...chain.tokens.flatMap((t) => [call(t.address, erc, "balanceOf", [vault]), call(vault, va, "priceUsd", [t.address])]),
    ];
  }, [chain.tokens, owner, stable.address, vault]);
  const reads = useReadContracts({ allowFailure: true, contracts, query: { refetchInterval: 20_000 } });
  const tx = useTx(() => void reads.refetch());
  const r = reads.data;
  const get = <T,>(i: number): T | null => (r && r[i]?.status === "success" ? (r[i]!.result as T) : null);

  const paused = get<boolean>(0);
  const operator = get<Address>(1);
  const chainSlipBps = get<number>(2);
  const chainLimit = get<bigint>(3);
  const remaining = get<bigint>(4);
  const walletStable = get<bigint>(6) ?? 0n;
  const assets: Asset[] = useMemo(
    () => [
      { symbol: stable.symbol, address: stable.address as Address, decimals: stable.decimals, raw: (r && r[5]?.status === "success" ? (r[5].result as bigint) : 0n), price: 1 },
      ...chain.tokens.map((t, k) => {
        const bal = r?.[7 + 2 * k];
        const px = r?.[8 + 2 * k];
        return {
          symbol: t.symbol,
          address: t.address as Address,
          decimals: t.decimals,
          raw: bal?.status === "success" ? (bal.result as bigint) : 0n,
          price: px?.status === "success" ? fromUnits(px.result as bigint, 18) : null,
        };
      }),
    ],
    [chain.tokens, r, stable],
  );
  const total = assets.reduce((s, a) => s + fromUnits(a.raw, a.decimals) * (a.price ?? 0), 0);
  const agentOn = !!operator && !!chain.operator && operator.toLowerCase() === chain.operator.toLowerCase();

  // Limits start from what the vault enforces now, and follow it until the owner moves a slider.
  const [limit, setLimit] = useState<number | null>(null);
  const [slip, setSlip] = useState<number | null>(null);
  const liveLimit = chainLimit != null ? Math.round(fromUnits(chainLimit, 18)) : null;
  const liveSlip = chainSlipBps != null ? chainSlipBps / 100 : null;
  const shownLimit = limit ?? liveLimit ?? chain.limits.defaultDailyLimitUsd;
  const shownSlip = slip ?? liveSlip ?? chain.limits.defaultSlippageBps / 100;
  const limitsChanged = (limit != null && limit !== liveLimit) || (slip != null && slip !== liveSlip);
  useEffect(() => {
    // After a save the chain agrees with the sliders again: let them follow the chain.
    if (limit === liveLimit) setLimit(null);
    if (slip === liveSlip) setSlip(null);
  }, [limit, liveLimit, slip, liveSlip]);

  const [deposit, setDeposit] = useState("");
  const [take, setTake] = useState("");
  const [takeSym, setTakeSym] = useState(stable.symbol);
  const takeAsset = assets.find((a) => a.symbol === takeSym) ?? assets[0]!;
  const parse = (text: string, decimals: number): bigint | null => {
    if (!/^\d+(\.\d+)?$/.test(text.trim())) return null;
    try {
      const n = parseUnits(text.trim(), decimals);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  };
  const depositRaw = parse(deposit, stable.decimals);
  const takeRaw = parse(take, takeAsset.decimals);
  const depositOk = depositRaw != null && depositRaw <= walletStable;
  const takeOk = takeRaw != null && takeRaw <= takeAsset.raw;
  const off = !canSign || !!tx.busy;
  const vaultAbi = VAULT_ABI as Abi;

  if (reads.isLoading) return <div className="panel"><p className="empty">Reading your vault from Robinhood Chain…</p></div>;
  if (!r) return <div className="panel"><p className="empty">Robinhood Chain could not be reached. Your vault is safe; try again in a moment.</p></div>;

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
        <div className="vtotal">
          <small>Value now</small>
          <b className="num">{usd(total, 2)}</b>
        </div>
        <table className="vassets">
          <tbody>
            {assets.map((a) => {
              const qty = fromUnits(a.raw, a.decimals);
              return (
                <tr key={a.symbol}>
                  <td>{a.symbol}</td>
                  <td className="r num">{qty === 0 ? "0" : qty >= 1 ? qty.toLocaleString("en-US", { maximumFractionDigits: 4 }) : qty.toPrecision(4)}</td>
                  <td className="r num">{a.price == null ? "no price" : usd(qty * a.price, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="vchips">
          <span className={`stat ${agentOn ? "on" : "off"}`}>Agent access {agentOn ? "on" : "off"}</span>
          <span className={`stat ${paused ? "off" : "on"}`}>{paused ? "Paused" : "Not paused"}</span>
          {remaining != null && chainLimit != null && (
            <span className="stat">
              {usd(fromUnits(remaining, 18))} of {usd(fromUnits(chainLimit, 18))} left to trade today
            </span>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Deposit and withdraw</h2>
        <p className="hint">A deposit moves USDG from your wallet into your vault. A withdrawal sends it back to your wallet, at any time, even while paused.</p>
        <div className="vform">
          <label htmlFor="v-dep">Deposit USDG</label>
          <div className="vfield">
            <input id="v-dep" type="text" inputMode="decimal" placeholder="0.00" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            <button className="btn sm ghost" type="button" onClick={() => setDeposit(formatUnits(walletStable, stable.decimals))}>
              Max
            </button>
            <button
              className="btn sm blue"
              disabled={off || !depositOk}
              onClick={() =>
                void tx
                  .send("deposit", { address: stable.address as Address, abi: ERC20_ABI as Abi, functionName: "transfer", args: [vault, depositRaw!] }, "Deposited into your vault.")
                  .then((ok) => ok && setDeposit(""))
              }
            >
              {tx.busy === "deposit" ? "Check your wallet…" : "Deposit"}
            </button>
          </div>
          <small>
            In your wallet: {usd(fromUnits(walletStable, stable.decimals), 2)} of {stable.symbol}
            {depositRaw != null && !depositOk ? ". That is more than your wallet holds." : ""}
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
            <input id="v-out" type="text" inputMode="decimal" placeholder="0.00" value={take} onChange={(e) => setTake(e.target.value)} />
            <button className="btn sm ghost" type="button" onClick={() => setTake(formatUnits(takeAsset.raw, takeAsset.decimals))}>
              Max
            </button>
            <button
              className="btn sm"
              disabled={off || !takeOk}
              onClick={() =>
                void tx
                  .send("withdraw", { address: vault, abi: vaultAbi, functionName: "withdraw", args: [takeAsset.address, takeRaw!, owner] }, "Withdrawn to your wallet.")
                  .then((ok) => ok && setTake(""))
              }
            >
              {tx.busy === "withdraw" ? "Check your wallet…" : "Withdraw"}
            </button>
          </div>
          {takeRaw != null && !takeOk && <small>That is more than the vault holds.</small>}
        </div>
      </div>

      <div className="panel">
        <h2>Limits the contract enforces</h2>
        <p className="hint">The agent cannot change these. Only your wallet can.</p>
        <div className="ctrl">
          <LimitSliders limit={shownLimit} slip={shownSlip} setLimit={setLimit} setSlip={setSlip} disabled={off} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn sm blue"
              disabled={off || !limitsChanged}
              onClick={() => void tx.send("limits", { address: vault, abi: vaultAbi, functionName: "setLimits", args: [Math.round(shownSlip * 100), parseUnits(String(shownLimit), 18)] }, "Limits saved.")}
            >
              {tx.busy === "limits" ? "Check your wallet…" : "Save limits"}
            </button>
            <button
              className="btn sm"
              disabled={off || paused == null}
              onClick={() => void tx.send("pause", { address: vault, abi: vaultAbi, functionName: "setPaused", args: [!paused] }, paused ? "Vault resumed." : "Vault paused. The agent cannot trade it.")}
            >
              {tx.busy === "pause" ? "Check your wallet…" : paused ? "Resume vault" : "Pause vault"}
            </button>
            <button
              className="btn sm ghost"
              disabled={off || !chain.operator}
              onClick={() =>
                void tx.send(
                  "access",
                  { address: vault, abi: vaultAbi, functionName: "setOperator", args: [agentOn ? zeroAddress : chain.operator] },
                  agentOn ? "Agent access revoked." : "Agent access restored.",
                )
              }
            >
              {tx.busy === "access" ? "Check your wallet…" : agentOn ? "Revoke agent access" : "Restore agent access"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveVault({ chain }: { chain: ChainConfigDTO }) {
  const { me, signIn, signingIn } = useSession();
  const { address, isConnected } = useAccount();
  const owner = (me?.address ?? zeroAddress) as Address;
  const vaultQ = useReadContract({
    address: chain.factory as Address,
    abi: FACTORY_ABI,
    functionName: "vaultOf",
    args: [owner],
    chainId: CHAIN.id,
    query: { enabled: !!me, refetchInterval: 20_000 },
  });
  if (!me) return <ConnectPanel text="Sign in with your wallet to create or manage your vault." />;
  // Signing needs the same wallet that signed in to be connected in this browser.
  const canSign = isConnected && address?.toLowerCase() === me.address.toLowerCase();
  const vault = vaultQ.data && vaultQ.data !== zeroAddress ? (vaultQ.data as Address) : null;
  return (
    <section>
      <RiskNote cap={chain.limits.maxVaultUsd} trading={chain.trading} />
      {!canSign && (
        <div className="panel connect" style={{ marginBottom: 20 }}>
          <p>
            {isConnected
              ? `Your wallet is on another account. Switch it to ${shortAddress(me.address)}, the account you signed in with, to change the vault.`
              : "Your wallet is not connected in this browser. Connect it to change the vault; you can still see it below."}
          </p>
          {!isConnected && (
            <button className="btn sm" onClick={() => void signIn()} disabled={signingIn}>
              {signingIn ? "Check your wallet…" : "Connect wallet"}
            </button>
          )}
        </div>
      )}
      <div className="grid2">
        {vaultQ.isLoading ? (
          <div className="panel">
            <p className="empty">Looking for your vault on Robinhood Chain…</p>
          </div>
        ) : vaultQ.isError ? (
          <div className="panel">
            <p className="empty">Robinhood Chain could not be reached. Try again in a moment.</p>
          </div>
        ) : vault ? (
          <ManageVault chain={chain} vault={vault} owner={owner} canSign={canSign} />
        ) : (
          <CreateVault chain={chain} canSign={canSign} onCreated={() => void vaultQ.refetch()} />
        )}
        <WhoCanDoWhat hint="Enforced by your vault's contract, not by this site." />
      </div>
    </section>
  );
}

export default function VaultPage() {
  const { liveOn, chain } = useMode();
  if (!liveOn || !chain) return <VaultPreview />;
  return <LiveVault chain={chain} />;
}
