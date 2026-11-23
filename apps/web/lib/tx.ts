"use client";

/**
 * One wallet transaction at a time, with plain feedback: asked for, sent, confirmed or refused. The site only
 * prepares the transaction. The user's own wallet shows it and signs it; the site never holds a key.
 */
import { CHAIN } from "@rationale/config";
import { useCallback, useState } from "react";
import type { Abi, Address } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { useToast } from "../components/Toast";
import { ensureRobinhoodChain, isUserRejection, type Eip1193 } from "./chain";
import { wagmiConfig } from "./wagmi";

export interface TxCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** ETH sent with the call, for the few calls that take it. */
  value?: bigint;
}

/**
 * How a send ended.
 *  - "confirmed": the chain ran exactly what was asked, and it succeeded.
 *  - "unconfirmed": the wallet sent it, and the chain has not answered in time. It may still go through.
 *  - "failed": nothing is known to have changed (refused, cancelled, replaced, or never sent).
 */
export type TxResult = "confirmed" | "unconfirmed" | "failed";

/** How long the page waits for the chain before it stops saying "waiting". The transaction itself is not affected. */
const CONFIRM_WAIT_MS = 90_000;

/** A short reason from a wallet or chain error, without the stack of technical detail. */
function reason(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  const text = (err.shortMessage ?? err.message ?? "").split("\n")[0]!.trim();
  if (/insufficient funds/i.test(text)) return "Your wallet has no ETH for the network fee.";
  return text && text.length < 160 ? text : "The transaction did not go through.";
}

export function useTx(onDone?: () => void) {
  const toast = useToast();
  const { connector, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  /** The label of the action in progress, so only its button shows as busy. */
  const [busy, setBusy] = useState<string | null>(null);
  /** The label of an action the wallet sent that the chain had not confirmed when the page stopped waiting. */
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const dismissUnconfirmed = useCallback(() => setUnconfirmed(null), []);

  const send = useCallback(
    async (label: string, call: TxCall, done: string): Promise<TxResult> => {
      if (busy) return "failed";
      setBusy(label);
      try {
        if (connector && chainId !== CHAIN.id) {
          const outcome = await ensureRobinhoodChain((await connector.getProvider()) as Eip1193);
          if (outcome === "already" || outcome === "switched") connector.emitter.emit("change", { chainId: CHAIN.id });
          else {
            toast(`Switch your wallet to ${CHAIN.name} first.`);
            return "failed";
          }
        }
        // The call is shaped at run time, so it is passed on without the ABI's compile-time types.
        const hash = await writeContractAsync({ ...call, chainId: CHAIN.id } as never);
        setUnconfirmed(null);
        toast("Sent. Waiting for the chain to confirm…");
        // A wallet can swap a pending transaction for another one in the same slot: the same call with a higher
        // fee ("repriced"), or something else entirely, such as its own "cancel". The receipt that comes back is
        // then the other transaction's, and its success says nothing about what was asked for here.
        const swap: { reason: "repriced" | "cancelled" | "replaced" | null } = { reason: null };
        let receipt;
        try {
          receipt = await waitForTransactionReceipt(wagmiConfig, {
            hash,
            chainId: CHAIN.id,
            timeout: CONFIRM_WAIT_MS,
            onReplaced: (r) => {
              swap.reason = r.reason;
            },
          });
        } catch {
          // The wallet has sent it; only the answer is missing. It may still go through, so this must not read
          // as a failure, and the person must not be nudged into sending it a second time.
          setUnconfirmed(label);
          toast("Sent, but the chain has not confirmed it yet. It may still go through: check your wallet's activity before trying again.");
          onDone?.();
          return "unconfirmed";
        }
        const other = swap.reason !== null ? swap.reason !== "repriced" : receipt.transactionHash.toLowerCase() !== hash.toLowerCase();
        if (other) {
          toast(
            swap.reason === "cancelled"
              ? "That transaction was cancelled in your wallet. Nothing changed."
              : "Your wallet replaced that transaction with another one. Nothing is known to have changed: check what this page shows now.",
          );
          onDone?.();
          return "failed";
        }
        if (receipt.status !== "success") {
          toast("The chain refused the transaction. Nothing changed.");
          return "failed";
        }
        toast(done);
        onDone?.();
        return "confirmed";
      } catch (e) {
        toast(isUserRejection(e) ? "Cancelled in your wallet. Nothing was sent." : reason(e));
        return "failed";
      } finally {
        setBusy(null);
      }
    },
    [busy, chainId, connector, onDone, toast, writeContractAsync],
  );

  return { busy, send, unconfirmed, dismissUnconfirmed };
}
