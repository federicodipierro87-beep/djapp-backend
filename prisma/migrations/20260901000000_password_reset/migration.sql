-- A DJ who forgets their password has no way back in: this is what the reset
-- flow needs to exist.
--
-- passwordResetTokenHash holds the SHA-256 of the token, not the token. The
-- clear text travels only in the link sent by email, so a copy of this table is
-- not a set of usable reset links. Unique because a token belongs to one DJ and
-- the reset finds them by it.
--
-- passwordChangedAt is what makes the reset actually revoke access: JWTs last
-- seven days and cannot be withdrawn, so a token issued before this instant is
-- refused by the auth middleware.
--
-- All three are nullable, so the columns can be added while the old code is
-- still running.
ALTER TABLE "djs" ADD COLUMN "passwordResetTokenHash" TEXT;
ALTER TABLE "djs" ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);
ALTER TABLE "djs" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "djs_passwordResetTokenHash_key" ON "djs"("passwordResetTokenHash");
