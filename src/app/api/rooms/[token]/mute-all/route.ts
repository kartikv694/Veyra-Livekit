/**
 * Host-only. Force-mutes every currently active participant except the
 * host themself — the bulk version of POST
 * .../participants/[userId]/mute. Same one-directional rule applies:
 * this can only mute people, never unmute them; only each person's own
 * control can turn their own mic back on.
 *
 * Responses:
 *   200  { muted: number[] }  — userIds that were muted
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
    where: { meetingId: meeting.id, leftAt: null, isHost: false, isMuted: false },
    select: { userId: true },
  });

  await prisma.participants.updateMany({
    where: { meetingId: meeting.id, leftAt: null, isHost: false },
    data: { isMuted: true },
  });

  const userIds = targets.map((t) => t.userId);
  emitToMeeting(token, "meeting:mute-all", { userIds });

  return NextResponse.json({ muted: userIds });
}
