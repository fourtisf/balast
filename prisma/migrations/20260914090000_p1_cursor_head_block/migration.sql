-- The chain's head as of the last pass.
--
-- So "how far through the first sync is this" can be answered from the
-- database alone. /api/health is what the waiting page reads, and without
-- this it could say only which block the indexer had reached — a number that
-- cannot tell an operator whether the site is still backfilling or has
-- finished and found nothing.
ALTER TABLE "indexer_cursors" ADD COLUMN "head_block" BIGINT;
