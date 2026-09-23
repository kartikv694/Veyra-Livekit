/**
 * Host-only. Releases the forced-camera-off on every currently-off
 * active participant except the host — the bulk counterpart to POST
 * .../camera-off-all (which only ever locks cameras off, never releases
 * them) and to the individual .../participants/[userId]/camera-off
 * toggle. Without this, a host who turned off everyone's camera at once
 * had no bulk way to let them back on — only one at a time.
 *
 * Responses:
 *   200  { camerasOn: number[] }  — userIds that were released
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
    where: { meetingId: meeting.id, leftAt: null, isHost: false, isCameraOff: true },
    select: { userId: true },
  });

  await prisma.participants.updateMany({
    where: { meetingId: meeting.id, leftAt: null, isHost: false },
    data: { isCameraOff: false },
  });

  const userIds = targets.map((t) => t.userId);
  emitToMeeting(token, "meeting:camera-on-all", { userIds });

  return NextResponse.json({ camerasOn: userIds });
}
