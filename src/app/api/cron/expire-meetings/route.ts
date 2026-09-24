/**
 * Daily sweep (see vercel.json's crons entry) that closes out meetings
 * nobody has touched in MEETING_EXPIRY_MS (2 days) — see
 * src/lib/meeting-expiry.ts's own comment for why this exists: a host
 * who leaves without explicitly ending the meeting, with nobody else
 * ever rejoining, previously left that meeting showing as permanently
 * "active" — isMeetingExpired() already existed and was already checked
 * at join time, but only for someone trying to use the stale link; it
 * never actually persisted that state anywhere. This is what does.
 *
 * Auth: Vercel sends every cron invocation with `Authorization: Bearer
 * ${CRON_SECRET}` — see https://vercel.com/docs/cron-jobs/manage-cron-jobs.
 * CRON_SECRET must be set as an env var (Vercel doesn't set it for you);
 * without it, this route refuses every request, including Vercel's own.
 *
 * Idempotent and safe to invoke more than once for the same meeting —
 * endMeetingInDb only ever moves a meeting from "not ended" to "ended";
 * running it again on an already-ended meeting would just be a no-op
 * update to the same endAt-having row, which is why this still filters
 * to endAt: null up front rather than relying on that alone.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { endMeetingInDb } from "@/lib/end-meeting";
import { emitToMeeting } from "@/lib/livekit-emitters";
import { isMeetingExpired, MEETING_EXPIRY_MS } from "@/lib/meeting-expiry";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handler(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Coarse SQL pre-filter, not the final word on which meetings actually
  // qualify — isMeetingExpired() below is. This just keeps the candidate
  // set small (meetings genuinely untouched in 2+ days) rather than
  // pulling every never-ended meeting in the database to check in JS.
  // lastActivityAt only ever moves forward (set to now() at creation,
  // bumped on join — never backdated), so a scheduled-but-never-joined
  // meeting whose scheduledAt is what actually makes it expired still
  // has an old-enough lastActivityAt to be caught here.
  const cutoff = new Date(Date.now() - MEETING_EXPIRY_MS);
  const candidates = await prisma.meeting.findMany({
    where: { endAt: null, lastActivityAt: { lt: cutoff } },
    select: { id: true, token: true, endAt: true, scheduledAt: true, lastActivityAt: true },
  });

  let expiredCount = 0;
  for (const meeting of candidates) {
    if (!isMeetingExpired(meeting)) continue; // pre-filter caught it, but the real check says not yet
    await endMeetingInDb(meeting.id);
    // Best-effort — if this stale room somehow still has anyone in it
    // (the agent, most likely, per its own much-shorter abandoned-room
    // timeout), this lets it wrap up immediately rather than waiting on
    // that separate timeout too.
    void emitToMeeting(meeting.token, "meeting:ended");
    expiredCount += 1;
  }

  return NextResponse.json({ checked: candidates.length, expired: expiredCount });
}

export const GET = handler;
export const POST = handler;
