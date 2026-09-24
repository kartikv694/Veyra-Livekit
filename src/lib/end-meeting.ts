/**
 * The database-side half of "ending a meeting" — sets endAt, closes out
 * every still-active participant session, and clears live-only chat.
 * Extracted from the original POST /api/rooms/[token]/end route so the
 * new inactivity-expiry cron (src/app/api/cron/expire-meetings/route.ts)
 * can end a stale meeting with the exact same DB behavior, rather than a
 * second, maintained-separately copy of the same transaction.
 *
 * Deliberately does NOT check who's allowed to call this or send the
 * meeting:ended broadcast — those differ by caller (a host's own request
 * vs. a scheduled sweep with no specific room to target from), so they
 * stay in each caller's own route.
 */
import { prisma } from "@/lib/prisma";

export async function endMeetingInDb(meetingId: number) {
  return prisma.$transaction(async (tx) => {
    const endAt = new Date();

    const updatedMeeting = await tx.meeting.update({
      where: { id: meetingId },
      data: { endAt },
    });

    // Explicitly ending for everyone also closes every currently-active
    // participant session. A normal Leave action does NOT end the room.
    await tx.participants.updateMany({
      where: { meetingId, leftAt: null },
      data: { leftAt: endAt },
    });

    // Chat is "live only, not saved anywhere" by design — recoverable
    // on a refresh during the meeting (see GET .../chat), but not a
    // permanent record once the meeting itself is over.
    await tx.chatMessage.deleteMany({ where: { meetingId } });

    return updatedMeeting;
  });
}
