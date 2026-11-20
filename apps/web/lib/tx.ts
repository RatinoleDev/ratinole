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
}

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

  const send = useCallback(
    async (label: string, call: TxCall, done: string): Promise<boolean> => {
      if (busy) return false;
      setBusy(label);
      try {
        if (connector && chainId !== CHAIN.id) {
          const outcome = await ensureRobinhoodChain((await connector.getProvider()) as Eip1193);
          if (outcome === "already" || outcome === "switched") connector.emitter.emit("change", { chainId: CHAIN.id });
          else {
            toast(`Switch your wallet to ${CHAIN.name} first.`);
            return false;
          }
        }
        // The call is shaped at run time, so it is passed on without the ABI's compile-time types.
        const hash = await writeContractAsync({ ...call, chainId: CHAIN.id } as never);
        toast("Sent. Waiting for the chain to confirm…");
        let receipt;
        try {
          receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN.id, timeout: 90_000 });
        } catch {
          // The wallet has sent it; only the answer is missing. It may still go through, so this must not read
          // as a failure, and the person must not be nudged into sending it a second time.
          toast("Sent, but the chain has not confirmed it yet. It may still go through: check your wallet's activity before trying again.");
          onDone?.();
          return false;
        }
        if (receipt.status !== "success") {
          toast("The chain refused the transaction. Nothing changed.");
          return false;
        }
        toast(done);
        onDone?.();
        return true;
      } catch (e) {
        toast(isUserRejection(e) ? "Cancelled in your wallet. Nothing was sent." : reason(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy, chainId, connector, onDone, toast, writeContractAsync],
  );

  return { busy, send };
}
