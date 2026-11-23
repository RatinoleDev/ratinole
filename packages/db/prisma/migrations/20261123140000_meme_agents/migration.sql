-- Meme agents: buy one launchpad token from the owner's meme vault, then sell it on a take profit or a stop loss.
-- New tables only; nothing existing is changed.
-- CreateTable
CREATE TABLE "MemeAgent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vault" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "tokenName" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "buyWei" TEXT NOT NULL,
    "takeProfitPct" DOUBLE PRECISION,
    "stopLossPct" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stage" TEXT NOT NULL DEFAULT 'buying',
    "pausedReason" TEXT,
    "spentWei" TEXT NOT NULL DEFAULT '0',
    "tokensRaw" TEXT NOT NULL DEFAULT '0',
    "receivedWei" TEXT NOT NULL DEFAULT '0',
    "entryValueWei" TEXT,
    "lastValueWei" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckNote" TEXT,
    "buyTries" INTEGER NOT NULL DEFAULT 0,
    "sellRequested" BOOLEAN NOT NULL DEFAULT false,
    "exitKind" TEXT,
    "launchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemeAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemeOrder" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "txHash" TEXT,
    "deadline" INTEGER NOT NULL,
    "ethWei" TEXT,
    "tokensRaw" TEXT,
    "minedBlock" TEXT,
    "error" TEXT,
    "exitKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemeEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "txHash" TEXT,
    "detail" JSONB,

    CONSTRAINT "MemeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemeAgent_userId_idx" ON "MemeAgent"("userId");

-- CreateIndex
CREATE INDEX "MemeAgent_status_idx" ON "MemeAgent"("status");

-- CreateIndex
CREATE INDEX "MemeAgent_vault_token_idx" ON "MemeAgent"("vault", "token");

-- CreateIndex
CREATE UNIQUE INDEX "MemeOrder_txHash_key" ON "MemeOrder"("txHash");

-- CreateIndex
CREATE INDEX "MemeOrder_agentId_status_idx" ON "MemeOrder"("agentId", "status");

-- CreateIndex
CREATE INDEX "MemeEvent_agentId_at_idx" ON "MemeEvent"("agentId", "at");

-- AddForeignKey
ALTER TABLE "MemeAgent" ADD CONSTRAINT "MemeAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemeOrder" ADD CONSTRAINT "MemeOrder_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "MemeAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemeEvent" ADD CONSTRAINT "MemeEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "MemeAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

