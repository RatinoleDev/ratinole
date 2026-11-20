-- The block a live order landed in, so that a later read of the vault can wait for a connection that has seen it.
ALTER TABLE "LiveOrder" ADD COLUMN "minedBlock" TEXT;
