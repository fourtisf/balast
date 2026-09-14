-- Small facts the indexer has to remember across restarts, by name.
--
-- The first one: which USD anchor the priced tables were last rebuilt for.
-- The full rebuild used to run on every restart as well as on every change
-- of anchor, and on a table of a few million rows that is longer than the
-- gap between two deploys — so a day of deploys was a day in which no pass
-- ever finished. Remembered here, a restart with the same anchor does the
-- bounded rebuild every pass does, and `npm run aggregates:rebuild` is the
-- way to ask for the full one.
CREATE TABLE "indexer_state" (
  "key"        TEXT NOT NULL,
  "value"      TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "indexer_state_pkey" PRIMARY KEY ("key")
);
