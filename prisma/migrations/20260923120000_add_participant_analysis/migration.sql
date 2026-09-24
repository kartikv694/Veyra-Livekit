-- CreateTable
CREATE TABLE "ParticipantAnalysis" (
    "id" SERIAL NOT NULL,
    "meetingId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "communication" INTEGER NOT NULL,
    "fluency" INTEGER NOT NULL,
    "topicRelevancy" INTEGER NOT NULL,
    "engagement" INTEGER NOT NULL,
    "clarityConfidence" INTEGER NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipantAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParticipantAnalysis_meetingId_idx" ON "ParticipantAnalysis"("meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantAnalysis_meetingId_userId_key" ON "ParticipantAnalysis"("meetingId", "userId");

-- AddForeignKey
ALTER TABLE "ParticipantAnalysis" ADD CONSTRAINT "ParticipantAnalysis_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
