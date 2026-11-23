-- A sale keeps which exit asked for it.
ALTER TABLE "LiveOrder" ADD COLUMN "exitKind" TEXT;
