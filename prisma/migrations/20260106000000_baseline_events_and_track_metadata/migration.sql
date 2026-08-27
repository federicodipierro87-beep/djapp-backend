-- Baseline migration.
--
-- The `events` table, the `EventStatus` enum, the Spotify track metadata on
-- `requests` and the `eventId` foreign keys were all applied to the production
-- database with `prisma db push`, so no migration ever recorded them. This file
-- closes that gap: it is the missing history, written so that it is a harmless
-- no-op where those objects already exist and correct on an empty database.
--
-- Every statement is therefore guarded. Do not copy this style into ordinary
-- migrations - it exists only because this one has to run against a database
-- that may or may not already be in the target state.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "EventStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "events" (
    "id" TEXT NOT NULL,
    "djId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventCode" TEXT NOT NULL,
    "description" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "dateTime" TIMESTAMP(3) NOT NULL,
    "endDateTime" TIMESTAMP(3),
    "status" "EventStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "events_eventCode_key" ON "events"("eventCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_latitude_longitude_idx" ON "events"("latitude", "longitude");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_status_dateTime_idx" ON "events"("status", "dateTime");

-- AlterTable
ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "spotifyTrackId" TEXT;
ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "albumCover" TEXT;
ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "eventId" TEXT;

-- AlterTable
ALTER TABLE "queue_items" ADD COLUMN IF NOT EXISTS "eventId" TEXT;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_djId_fkey') THEN
    ALTER TABLE "events" ADD CONSTRAINT "events_djId_fkey"
      FOREIGN KEY ("djId") REFERENCES "djs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requests_eventId_fkey') THEN
    ALTER TABLE "requests" ADD CONSTRAINT "requests_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queue_items_eventId_fkey') THEN
    ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
