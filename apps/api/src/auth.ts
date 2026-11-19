/**
 * Sign-In with Ethereum (EIP-4361) and cookie sessions. The signature is
 * checked locally by recovering the signer, so plain wallets (EOAs) work;
 * smart-contract wallets would need an on-chain check and are not supported yet.
 * Nonces live in Redis for 5 minutes and are single-use.
 */
import { randomBytes } from "node:crypto";
import { CHAIN } from "@rationale/config";
import type { PrismaClient, User } from "@rationale/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { verifyMessage, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";

export const SESSION_COOKIE = "rationale_sid";
const SESSION_DAYS = 30;
const NONCE_TTL_SECONDS = 300;

export async function issueNonce(redis: Redis): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  await redis.set(`siwe:nonce:${nonce}`, "1", "EX", NONCE_TTL_SECONDS);
  return nonce;
}

export type VerifyResult = { ok: true; address: string } | { ok: false; message: string };

export async function verifySiwe(
  input: { message: string; signature: string },
  opts: { redis: Redis; appOrigin: string; now?: Date },
): Promise<VerifyResult> {
  const parsed = parseSiweMessage(input.message);
  const host = new URL(opts.appOrigin).host;
  if (!parsed.address || !parsed.nonce) return { ok: false, message: "That sign-in message is not valid." };
  if (parsed.chainId !== CHAIN.id) return { ok: false, message: `Sign in on chain ${CHAIN.id} (${CHAIN.name}).` };
  if (parsed.uri && new URL(parsed.uri).host !== host) return { ok: false, message: "That sign-in message is for another site." };
  const now = opts.now ?? new Date();
  if (parsed.issuedAt && Math.abs(now.getTime() - parsed.issuedAt.getTime()) > NONCE_TTL_SECONDS * 1000) {
    return { ok: false, message: "That sign-in request has expired. Try again." };
  }
  if (!validateSiweMessage({ message: parsed, domain: host, time: now })) {
    return { ok: false, message: "That sign-in message is for another site or has expired." };
  }
  // Single use: the nonce is deleted as it is checked.
  const used = await opts.redis.getdel(`siwe:nonce:${parsed.nonce}`);
  if (!used) return { ok: false, message: "That sign-in request has expired. Try again." };
  if (!/^0x[0-9a-fA-F]+$/.test(input.signature)) return { ok: false, message: "The signature is not valid." };
  const valid = await verifyMessage({ address: parsed.address, message: input.message, signature: input.signature as Hex }).catch(() => false);
  if (!valid) return { ok: false, message: "The signature does not match the wallet." };
  return { ok: true, address: parsed.address.toLowerCase() };
}

export async function createSession(prisma: PrismaClient, address: string): Promise<{ sessionId: string; user: User; expiresAt: Date }> {
  const user = await prisma.user.upsert({ where: { address }, create: { address }, update: {} });
  const sessionId = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await prisma.session.create({ data: { id: sessionId, userId: user.id, expiresAt } });
  return { sessionId, user, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, sessionId, { signed: true, httpOnly: true, sameSite: "lax", secure, path: "/", expires: expiresAt });
}

export function sessionIdFrom(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const un = req.unsignCookie(raw);
  return un.valid && un.value ? un.value : null;
}

export async function currentUser(prisma: PrismaClient, req: FastifyRequest): Promise<User | null> {
  const sid = sessionIdFrom(req);
  if (!sid) return null;
  const s = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s || s.expiresAt.getTime() < Date.now()) return null;
  return s.user;
}
