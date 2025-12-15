-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'PAYPAL', 'SATISPAY');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'NOW_PLAYING', 'PLAYED', 'SKIPPED');

-- CreateTable
CREATE TABLE "djs" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stripeAccountId" TEXT,
    "paypalEmail" TEXT,
    "satispayId" TEXT,
    "eventCode" TEXT NOT NULL,
    "minDonation" DECIMAL(65,30) NOT NULL DEFAULT 5.00,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "djs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requests" (
    "id" TEXT NOT NULL,
    "songTitle" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT,
    "donationAmount" DECIMAL(65,30) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "paymentIntentId" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "djId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_items" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "djId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "playedAt" TIMESTAMP(3),

    CONSTRAINT "queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "djs_email_key" ON "djs"("email");

-- CreateIndex
CREATE UNIQUE INDEX "djs_eventCode_key" ON "djs"("eventCode");

-- CreateIndex
CREATE UNIQUE INDEX "queue_items_requestId_key" ON "queue_items"("requestId");

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_djId_fkey" FOREIGN KEY ("djId") REFERENCES "djs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_djId_fkey" FOREIGN KEY ("djId") REFERENCES "djs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
