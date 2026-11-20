-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "pausedReason" TEXT,
ADD COLUMN     "vault" TEXT;

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "basisAfter" DOUBLE PRECISION,
ADD COLUMN     "execError" TEXT,
ADD COLUMN     "flowUsd" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "LiveOrder" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "side" TEXT NOT NULL,
    "vault" TEXT NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fromBlock" TEXT NOT NULL,
    "txHash" TEXT,
    "amountOut" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveOrder_status_idx" ON "LiveOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LiveOrder_agentId_hour_key" ON "LiveOrder"("agentId", "hour");

-- AddForeignKey
ALTER TABLE "LiveOrder" ADD CONSTRAINT "LiveOrder_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
