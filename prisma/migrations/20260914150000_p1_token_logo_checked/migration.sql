-- When a token's logo was last looked for in the external sources.
--
-- A token most sources have never heard of would otherwise be asked about
-- on every pass, for ever, against rate-limited public APIs. Null means
-- never asked; a lookup that finds nothing still sets it, and the token is
-- asked again only after the retry window.
ALTER TABLE "tokens" ADD COLUMN "logo_checked_at" TIMESTAMP(3);
