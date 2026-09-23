/**
 * Host-only. Force-turns-off another active participant's camera — the
 * video equivalent of .../mute. Sets `Participant.isCameraOff` and
 * pushes a real-time `participant:force-camera-off` event so the
 * affected person's own client disables its video track immediately.
 *
 * Deliberately one-directional, same as mute: the host can force the
 * camera off, but only that person's own control can turn it back on.
 *
 * Responses:
 *   200  { camerasOff: <userId> }
 *   400  { error }  — invalid participant id, or targeting yourself
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }  — no such meeting, or target isn't currently in it
 */
import { requireAuth, unauthorized } from "@/lib/auth";
import { resolveHostAction } from "@/lib/host-action";
import { prisma } from "@/lib/prisma";
import { emitToMeeting } from "@/lib/livekit-emitters";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; userId: string }> },
) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token, userId } = await params;
  const targetUserId = Number(userId);
  if (!Number.isInteger(targetUserId)) {
    return NextResponse.json({ error: "Invalid participant id." }, { status: 400 });
  }
  const resolved = await resolveHostAction(auth, token, targetUserId);
  if (!resolved.ok) return resolved.response;

  const current = await prisma.participants.findUnique({
    where: { id: resolved.target.id },
    select: { isCameraOff: true },
  });
  if (!current) {
    return NextResponse.json({ error: "That person isn't currently in this meeting." }, { status: 404 });
  }
  const cameraOff = !current.isCameraOff;
  await prisma.participants.update({
    where: { id: resolved.target.id },
    data: { isCameraOff: cameraOff },
  });

  emitToMeeting(token, cameraOff ? "participant:force-camera-off" : "participant:force-camera-on", { userId: targetUserId });

  return NextResponse.json({ userId: targetUserId, cameraOff });
}
