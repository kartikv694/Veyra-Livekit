/**
 * 
 *
 * Marks the caller as having left a meeting (`Participant.leftAt = now()`).
 *
 * Deliberately simple: host status is NOT transferred and the meeting is
 * NOT auto-ended when the host leaves.
 *
 *   - `Meeting.hostId` is permanent — it's the creator's identity, not a
 *     live role that gets handed off. It never changes here, or anywhere
 *     else in this API.
 *   - A leaving host's `Participant.isHost` flag is left as `true`. It
 *     records their permanent role, not whether they're currently in the
 *     call — so when they rejoin (via /api/rooms/join) they regain full
 *     host rights immediately, with no re-admission or restriction.
 *   - The room keeps running while the host is away. Participants who are
 *     already part of the meeting can freely leave and rejoin regardless
 *     of whether the host is present (see /api/rooms/join for the one
 *     place host presence *does* matter: admitting brand-new participants
 *     who've never joined before).
 *   - In short: host rights don't "finish" just because the host
 *     disconnects — only their live presence pauses. The rights themselves
 *     stay tied to that one account for as long as the meeting exists.
 *
 * Request body:
 *   { "token": string }   — the room code being left
 *
 * Responses:
 *   200  { meeting: { id, token, hostId }, wasHost: boolean }
 *   400  { error, details }
 *   401  { error }
 *   404  { error }  — no meeting with that token, or caller isn't an active participant
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";

const leaveSchema = z.object({
  token: z.string().min(1, "Room token is required"),
});

// POST /api/rooms/leave
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = leaveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const meeting = await prisma.meeting.findUnique({ where: { token: parsed.data.token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }

  const me = await prisma.participants.findUnique({
    where: { meetingId_userId: { meetingId: meeting.id, userId: auth.sub } },
  });
  if (!me || me.leftAt) {
    return NextResponse.json(
      { error: "You are not an active participant in this meeting." },
      { status: 404 },
    );
  }

  // Note: isHost is intentionally left untouched here — see file doc comment.
  await prisma.participants.update({
    where: { id: me.id },
    data: { leftAt: new Date() },
  });

  return NextResponse.json({
    meeting: { id: meeting.id, token: meeting.token, hostId: meeting.hostId },
    wasHost: me.isHost,
  });
}
