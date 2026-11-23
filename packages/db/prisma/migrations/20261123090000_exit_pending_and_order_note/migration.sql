-- An exit whose sale did not complete stays open until the position is closed, and the trailing-stop high
-- remembers how far it has looked. A live order keeps the reason it was smaller than planned.
ALTER TABLE "AgentState" ADD COLUMN "peakSeenTo" TIMESTAMP(3),
ADD COLUMN "exitPendingSince" TIMESTAMP(3),
ADD COLUMN "exitPendingKind" TEXT;

ALTER TABLE "LiveOrder" ADD COLUMN "note" TEXT;
