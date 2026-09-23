/**
 * A meeting link that nobody has used in this long auto-expires — see
 * Meeting.lastActivityAt's schema comment for why this exists: if the
 * host leaves without explicitly ending the meeting (and nobody else
 * ever rejoins), the room would otherwise stay open forever with a
 * permanently-valid link.
 */
export const MEETING_EXPIRY_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

/**
 * True if a meeting has gone unused long enough to auto-expire. Never
 * true for one that's already ended (that's a different, already-final
 * state — see the join route, which checks endAt separately and first).
 *
 * The reference point is whichever is LATER of lastActivityAt and
 * scheduledAt — not lastActivityAt alone — so a meeting scheduled days
 * out doesn't look stale before its scheduled time has even arrived.
 * scheduledAt is only ever in the future relative to lastActivityAt for a
 * meeting nobody has joined yet (once someone joins, lastActivityAt moves
 * ahead of it and takes over as the reference point naturally).
 */
export function isMeetingExpired(meeting: {
  endAt: Date | null;
  scheduledAt: Date | null;
  lastActivityAt: Date;
}): boolean {
  if (meeting.endAt) return false;
  const referenceTime =
    meeting.scheduledAt && meeting.scheduledAt.getTime() > meeting.lastActivityAt.getTime()
      ? meeting.scheduledAt
      : meeting.lastActivityAt;
  return Date.now() - referenceTime.getTime() > MEETING_EXPIRY_MS;
}
