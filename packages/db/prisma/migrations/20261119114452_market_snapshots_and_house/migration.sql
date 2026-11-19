-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "house" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "market" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "change24Pct" DOUBLE PRECISION NOT NULL,
    "regime" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rsi" DOUBLE PRECISION,
    "funding8hPct" DOUBLE PRECISION,
    "dailyVolPct" DOUBLE PRECISION NOT NULL,
    "closes7d" JSONB NOT NULL,
    "candleSource" TEXT NOT NULL,
    "fundingSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("market","hour")
);

-- CreateIndex
CREATE INDEX "MarketSnapshot_hour_idx" ON "MarketSnapshot"("hour");
