-- Stripe Connect: the DJ's own account, and Stripe's verdict on it.

ALTER TABLE "djs" ADD COLUMN "chargesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "djs" ADD COLUMN "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- stripeAccountId used to be a free-text field the DJ typed into their own
-- settings form, so whatever is in it now was never verified and was never
-- used for anything. From here on it names where a guest's money is sent, and
-- it is written only by the onboarding flow. Anything that is not a Stripe
-- account id is cleared, both because it is junk and because it would make the
-- unique index below fail.
UPDATE "djs" SET "stripeAccountId" = NULL WHERE "stripeAccountId" !~ '^acct_[A-Za-z0-9]+$';

-- Two DJs cannot share a payout destination, and the account.updated webhook
-- looks a DJ up by this column.
CREATE UNIQUE INDEX "djs_stripeAccountId_key" ON "djs"("stripeAccountId");
