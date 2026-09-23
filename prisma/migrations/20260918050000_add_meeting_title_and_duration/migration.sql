-- Adds Meeting.title (optional display name, set at scheduling time) and
-- Meeting.durationMinutes (optional auto-end time limit, also set at
-- scheduling time via a toggle). Both nullable — existing meetings simply
-- don't have them, same pattern as the earlier timeZone column.

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "title" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "durationMinutes" INTEGER;
