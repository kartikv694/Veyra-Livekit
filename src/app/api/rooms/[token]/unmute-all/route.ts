/**
 * Host-only. Releases the mute on every currently-muted active
 * participant except the host — the bulk counterpart to POST
 * .../mute-all (which only ever locks people, never releases them) and
 * to the individual .../participants/[userId]/mute toggle. Without this,
 * a host who muted everyone at once had no bulk way to let them back in —
 * only one at a time, from the People panel.
 *
 * Responses:
 *   200  { unmuted: number[] }  — userIds that were released
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }  — no such meeting
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitToMeeting } from "@/lib/livekit-emitters";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }
  if (meeting.hostId !== auth.sub) {
    return NextResponse.json({ error: "Only the host can do that." }, { status: 403 });
  }

  const targets = await prisma.participants.findMany({
    where: { meetingId: meeting.id, leftAt: null, isHost: false, isMuted: true },
    select: { userId: true },
  });

  await prisma.participants.updateMany({
    where: { meetingId: meeting.id, leftAt: null, isHost: false },
    data: { isMuted: false },
  });

  const userIds = targets.map((t) => t.userId);
  emitToMeeting(token, "meeting:unmute-all", { userIds });

  return NextResponse.json({ unmuted: userIds });
}
