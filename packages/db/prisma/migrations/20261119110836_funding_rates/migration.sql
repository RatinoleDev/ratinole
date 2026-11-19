-- CreateTable
CREATE TABLE "FundingRate" (
    "market" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingRate_pkey" PRIMARY KEY ("market","source","hour")
);
