-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "maxSizePct" DOUBLE PRECISION NOT NULL DEFAULT 35,
    "dailyLossCapPct" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sentence" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "market" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "status" TEXT NOT NULL DEFAULT 'active',
    "startingCash" DOUBLE PRECISION NOT NULL,
    "maxSizePct" DOUBLE PRECISION NOT NULL,
    "dailyLossCapPct" DOUBLE PRECISION NOT NULL,
    "backtestId" TEXT,
    "launchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "owedFrom" TIMESTAMP(3) NOT NULL,
    "holdEntryPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentState" (
    "agentId" TEXT NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "avgEntry" DOUBLE PRECISION,
    "peak" DOUBLE PRECISION,
    "lastBuyAt" TIMESTAMP(3),
    "dayStart" TIMESTAMP(3) NOT NULL,
    "dayStartEquity" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentState_pkey" PRIMARY KEY ("agentId")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "regime" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "guard" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "txHash" TEXT,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "fillSide" TEXT,
    "fillPrice" DOUBLE PRECISION,
    "fillQty" DOUBLE PRECISION,
    "fillNotional" DOUBLE PRECISION,
    "fillFee" DOUBLE PRECISION,
    "cashAfter" DOUBLE PRECISION NOT NULL,
    "qtyAfter" DOUBLE PRECISION NOT NULL,
    "equityAfter" DOUBLE PRECISION NOT NULL,
    "holdingEquityAfter" DOUBLE PRECISION NOT NULL,
    "markPrice" DOUBLE PRECISION NOT NULL,
    "candleSource" TEXT NOT NULL,
    "candleTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backtest" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'user',
    "sentence" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "market" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "source" TEXT,
    "label" TEXT NOT NULL DEFAULT 'Price signals only',
    "maxSizePct" DOUBLE PRECISION NOT NULL,
    "dailyLossCapPct" DOUBLE PRECISION NOT NULL,
    "costPct" DOUBLE PRECISION NOT NULL,
    "startCash" DOUBLE PRECISION NOT NULL,
    "params" JSONB,
    "fromTime" TIMESTAMP(3),
    "splitTime" TIMESTAMP(3),
    "toTime" TIMESTAMP(3),
    "candles" INTEGER,
    "tunedReturnPct" DOUBLE PRECISION,
    "unseenReturnPct" DOUBLE PRECISION,
    "holdingTunedPct" DOUBLE PRECISION,
    "holdingUnseenPct" DOUBLE PRECISION,
    "maxDrawdownPct" DOUBLE PRECISION,
    "tunedTrades" INTEGER,
    "unseenTrades" INTEGER,
    "curve" JSONB,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Backtest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "market" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("market","source","openTime")
);

-- CreateTable
CREATE TABLE "EngineRun" (
    "id" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "agents" INTEGER NOT NULL DEFAULT 0,
    "decisions" INTEGER NOT NULL DEFAULT 0,
    "late" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,

    CONSTRAINT "EngineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmUsage" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "ok" BOOLEAN NOT NULL,

    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_address_key" ON "User"("address");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");

-- CreateIndex
CREATE INDEX "Agent_status_idx" ON "Agent"("status");

-- CreateIndex
CREATE INDEX "Decision_hour_idx" ON "Decision"("hour");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_agentId_hour_key" ON "Decision"("agentId", "hour");

-- CreateIndex
CREATE INDEX "Backtest_kind_status_createdAt_idx" ON "Backtest"("kind", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Backtest_userId_idx" ON "Backtest"("userId");

-- CreateIndex
CREATE INDEX "EngineRun_hour_idx" ON "EngineRun"("hour");

-- CreateIndex
CREATE INDEX "LlmUsage_at_idx" ON "LlmUsage"("at");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentState" ADD CONSTRAINT "AgentState_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backtest" ADD CONSTRAINT "Backtest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
