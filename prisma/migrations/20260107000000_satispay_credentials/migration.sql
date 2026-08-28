-- Satispay is not a marketplace: money reaches a DJ only if the payment is
-- created against their own business account, which means holding that
-- account's API credentials.
--
-- satispayKeyId is public and identifies the key to Satispay. satispayPrivateKey
-- is the key that signs requests for the DJ's money and is stored encrypted with
-- CREDENTIALS_ENCRYPTION_KEY, never in the clear - the database on its own must
-- not be enough to use it.

ALTER TABLE "djs" ADD COLUMN "satispayKeyId" TEXT;
ALTER TABLE "djs" ADD COLUMN "satispayPrivateKey" TEXT;

-- satispayId was a free-text field the DJ filled in themselves. It never took
-- part in a payment: the old integration read its credentials from the
-- environment and ignored this entirely. Nothing reads it now either, so it goes
-- rather than sitting there looking like configuration that matters.
ALTER TABLE "djs" DROP COLUMN "satispayId";
