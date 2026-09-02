-- The legacy per-DJ event code had no way to be closed: resolveEventCode
-- reported it active unconditionally, so the QR poster from an old night went on
-- taking payments after the night had been ended and summarised. Default true so
-- every existing DJ keeps working exactly as before; ending a night now sets it
-- false and starting one sets it back.
ALTER TABLE "djs" ADD COLUMN "eventCodeActive" BOOLEAN NOT NULL DEFAULT true;

-- Stripe refuses a euro charge below 50 cents at PaymentIntent creation, so any
-- minimum under that quotes the guest an amount their card would never accept.
-- The zeroes come from the free-request window; the rest is defensive.
UPDATE "djs" SET "minDonation" = 0.50 WHERE "minDonation" < 0.50;
UPDATE "events" SET "minDonation" = 0.50 WHERE "minDonation" IS NOT NULL AND "minDonation" < 0.50;

-- requests.paymentMethod stays nullable and PaymentStatus keeps NOT_REQUIRED.
-- Nothing writes either any more, but rows created during the free-request
-- window still carry them, and the expiry sweep needs to keep finding those.
