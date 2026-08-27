-- The request now exists before the payment does, so it needs somewhere to
-- record which provider holds the authorisation and how far along it is.

-- AlterEnum
ALTER TYPE "RequestStatus" ADD VALUE 'AWAITING_PAYMENT';

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'PAYPAL', 'SATISPAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'CANCELED', 'FAILED');

-- AlterTable
ALTER TABLE "requests" ADD COLUMN "paymentProvider" "PaymentProvider";
ALTER TABLE "requests" ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "requests" ADD COLUMN "authorizedAt" TIMESTAMP(3);
ALTER TABLE "requests" ADD COLUMN "capturedAt" TIMESTAMP(3);

-- Backfill the provider from the payment method, which is the only record we
-- have for rows created before this column existed.
UPDATE "requests" SET "paymentProvider" = CASE "paymentMethod"
  WHEN 'PAYPAL' THEN 'PAYPAL'::"PaymentProvider"
  WHEN 'SATISPAY' THEN 'SATISPAY'::"PaymentProvider"
  ELSE 'STRIPE'::"PaymentProvider"
END;

-- Backfill the payment state from the request state. This is an approximation
-- of history, not a reading of the providers: a request the DJ was still
-- looking at had a live authorisation, one that was refused or timed out had
-- its authorisation released. Rows that never reached a provider stay PENDING.
UPDATE "requests" SET "paymentStatus" = 'AUTHORIZED', "authorizedAt" = "createdAt"
WHERE "paymentIntentId" IS NOT NULL AND "status" IN ('PENDING', 'ACCEPTED');

UPDATE "requests" SET "paymentStatus" = 'CANCELED'
WHERE "paymentIntentId" IS NOT NULL AND "status" IN ('REJECTED', 'EXPIRED');

-- Until now the client chose this value, so the same authorisation could be
-- pinned to any number of requests. Detach every duplicate except the first
-- one to claim it, otherwise the unique index below cannot be created.
UPDATE "requests" r SET "paymentIntentId" = NULL
WHERE r."paymentIntentId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "requests" o
    WHERE o."paymentIntentId" = r."paymentIntentId"
      AND (o."createdAt" < r."createdAt"
        OR (o."createdAt" = r."createdAt" AND o."id" < r."id"))
  );

-- CreateIndex
CREATE UNIQUE INDEX "requests_paymentIntentId_key" ON "requests"("paymentIntentId");
