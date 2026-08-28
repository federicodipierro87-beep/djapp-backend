-- The payee of a multiparty PayPal order is named by merchant id, not by email
-- address. Nullable: a DJ who has not been through PayPal partner onboarding
-- does not have one, and their paypalEmail is used instead.

ALTER TABLE "djs" ADD COLUMN "paypalMerchantId" TEXT;
