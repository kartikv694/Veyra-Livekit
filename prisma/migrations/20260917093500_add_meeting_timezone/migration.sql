-- Adds Meeting.timeZone so the scheduling confirmation email can be
-- rendered in the host's actual local time instead of the server
-- process's own default timezone (UTC on Vercel). scheduledAt itself was
-- always a correct absolute instant — this only fixes how it's *displayed*.
-- Nullable: existing scheduled meetings simply don't have this yet, and
-- non-scheduled meetings never will (no scheduledAt to format either).

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "timeZone" TEXT;
