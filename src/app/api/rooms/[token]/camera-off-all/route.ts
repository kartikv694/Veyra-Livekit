/**
 * Host-only. Force-turns-off the camera for every currently active
 * participant except the host — the bulk version of POST
 * .../participants/[userId]/camera-off. Same one-directional rule as
 * mute: this can only turn cameras off, never back on.
 *
 * Responses:
 *   200  { camerasOff: number[] }  — userIds affected
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
    where: { meetingId: meeting.id, leftAt: null, isHost: false, isCameraOff: false },
    select: { userId: true },
  });

  await prisma.participants.updateMany({
    where: { meetingId: meeting.id, leftAt: null, isHost: false },
    data: { isCameraOff: true },
  });

  const userIds = targets.map((t) => t.userId);
  emitToMeeting(token, "meeting:camera-off-all", { userIds });

  return NextResponse.json({ camerasOff: userIds });
}
