/**
 * Host-only. Admits a waiting join request — creates the Participant
 * row (same shape as a normal join). The waiting person finds out via
 * their own polling of GET /api/rooms/[token]/join-requests/mine (every
 * 3 seconds — see the polling effect in room/[token]/page.tsx), not a
 * push: they aren't a LiveKit room participant yet at this point, so
 * there's no delivery channel to push to even if there were an instant
 * one to use. A 3-second worst-case delay isn't worth the complexity a
 * push would add here.
 *
 * Responses:
 *   200  { admitted: userId }
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }  — no such meeting or request
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; requestId: string }> },
) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token, requestId } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }
  if (meeting.hostId !== auth.sub) {
    return NextResponse.json({ error: "Only the host can admit people." }, { status: 403 });
  }

  const request = await prisma.joinRequest.findFirst({
    where: { id: Number(requestId), meetingId: meeting.id, status: "PENDING" },
  });
  if (!request) {
    return NextResponse.json({ error: "That request isn't pending anymore." }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.joinRequest.update({
      where: { id: request.id },
      data: { status: "ADMITTED", resolvedAt: new Date() },
    }),
    prisma.participants.upsert({
      where: { meetingId_userId: { meetingId: meeting.id, userId: request.userId } },
      update: { leftAt: null },
      create: { meetingId: meeting.id, userId: request.userId },
    }),
  ]);

  return NextResponse.json({ admitted: request.userId });
}
