-- A minimum tip that belongs to the event rather than to the DJ, and the row
-- shape a request with no payment at all needs.
--
-- All three statements are safe to run while the old code is still serving: a
-- nullable column it never reads, a NOT NULL dropped from a column it always
-- fills, and an enum value no row uses yet.

-- AlterTable: null means "inherit the DJ's minimum", which is every event that
-- already exists. The type matches djs.minDonation so the two are comparable.
ALTER TABLE "events" ADD COLUMN "minDonation" DECIMAL(65,30);

-- AlterTable: a free request names no payment method, because there is no
-- payment. The three paths that release or capture money filter on
-- paymentStatus and never reach these rows.
ALTER TABLE "requests" ALTER COLUMN "paymentMethod" DROP NOT NULL;

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'NOT_REQUIRED';
