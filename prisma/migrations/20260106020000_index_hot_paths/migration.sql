-- Indexes for the queries that run on a timer.
--
-- The DJ panel and every public queue screen poll their endpoints every few
-- seconds, and none of these columns were indexed: Postgres does not index
-- foreign keys by itself, so `WHERE "eventId" = $1` was a sequential scan over
-- every request and queue item ever created, on every poll, for every screen.

-- CreateIndex
CREATE INDEX "requests_djId_status_createdAt_idx" ON "requests"("djId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "requests_eventId_status_idx" ON "requests"("eventId", "status");

-- CreateIndex
CREATE INDEX "queue_items_djId_status_idx" ON "queue_items"("djId", "status");

-- CreateIndex
CREATE INDEX "queue_items_eventId_status_idx" ON "queue_items"("eventId", "status");

-- CreateIndex
CREATE INDEX "event_summaries_djId_endedAt_idx" ON "event_summaries"("djId", "endedAt");

-- CreateIndex
CREATE INDEX "events_djId_dateTime_idx" ON "events"("djId", "dateTime");
