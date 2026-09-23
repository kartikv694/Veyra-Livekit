-- Adds Meeting.lastActivityAt, used to auto-expire a meeting link that
-- nobody has used in a while (see MEETING_EXPIRY_MS in
-- src/lib/meeting-expiry.ts and the check in POST /api/rooms/join).
-- Defaults existing rows to their createdAt-equivalent (NOW() at migration
-- time is the closest available approximation for already-existing
-- meetings; going forward every join updates it properly).

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
