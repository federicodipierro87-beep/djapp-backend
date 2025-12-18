-- CreateTable
CREATE TABLE "event_summaries" (
    "id" TEXT NOT NULL,
    "djId" TEXT NOT NULL,
    "eventCode" TEXT NOT NULL,
    "totalRequests" INTEGER NOT NULL,
    "acceptedRequests" INTEGER NOT NULL,
    "rejectedRequests" INTEGER NOT NULL,
    "expiredRequests" INTEGER NOT NULL,
    "playedSongs" INTEGER NOT NULL,
    "skippedSongs" INTEGER NOT NULL,
    "totalEarnings" DECIMAL(65,30) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_summaries_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "event_summaries" ADD CONSTRAINT "event_summaries_djId_fkey" FOREIGN KEY ("djId") REFERENCES "djs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
