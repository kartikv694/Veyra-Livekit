/**
 *
 * Returns a meeting's details plus its full participant roster — what the
 * meeting-room screen needs to render video tiles and the participant list
 * (SRS: "Display participant video tiles and participant list").
 *
 * Access is restricted to people who are (or have been) an active
 * participant in this specific meeting — not just any authenticated user —
 * so someone can't enumerate room tokens to see who's in other people's
 * meetings.
 *
 * Responses:
 *   200  {
 *     meeting: { id, token, createdAt, endAt, hostId, locked, passcodeSet, title, durationMinutes },
 *     participants: [{ userId, name, email, isHost, isMuted, joinedAt, leftAt }]
 *   }
 *   401  { error }  — missing/invalid auth token
 *   403  { error }  — caller has never joined this meeting
 *   404  { error }  — no meeting with this token
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/rooms/[token]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const auth = requireAuth(req);

  if (!auth) return unauthorized();

  const { token } = await params;

  // Fetch only the meeting fields needed by the room UI. The roster is
  // queried separately with `leftAt: null`, so old attendance rows don't
  // make every room refresh slower as a meeting accumulates history.
  const meeting = await prisma.meeting.findUnique({
    where: { token },
    select: {
      id: true,
      token: true,
      createdAt: true,
      scheduledAt: true,
      endAt: true,
      hostId: true,
      locked: true,
      passcode: true,
      title: true,
      durationMinutes: true,
    },
  });

  if (!meeting) {
    return NextResponse.json(
      { error: "No meeting found with that room code." },
      { status: 404 },
    );
  }

  // Access check is a narrow indexed lookup rather than loading the entire
  // participant history into memory just to find the caller.
  const callerIsParticipant = await prisma.participants.findUnique({
    where: { meetingId_userId: { meetingId: meeting.id, userId: auth.sub } },
    select: { id: true },
  });

  if (!callerIsParticipant) {
    return NextResponse.json(
      { error: "You don't have access to this meeting." },
      { status: 403 },
    );
  }

  // Only active participants are rendered in the live room. Historical
  // attendance stays in the database for reporting but no longer bloats
  // every 8–15 second roster refresh.
  const participants = await prisma.participants.findMany({
    where: { meetingId: meeting.id, leftAt: null },
    select: {
      userId: true,
      isHost: true,
      isMuted: true,
      isCameraOff: true,
      joinedAt: true,
      leftAt: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { joinedAt: "asc" },
  });

  return NextResponse.json({
    meeting: {
      id: meeting.id,
      token: meeting.token,
      createdAt: meeting.createdAt,
      scheduledAt: meeting.scheduledAt,
      endAt: meeting.endAt,
      hostId: meeting.hostId,
      locked: meeting.locked,
      passcodeSet: meeting.passcode !== null,
      title: meeting.title,
      durationMinutes: meeting.durationMinutes,
    },
    participants: participants.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      email: p.user.email,
      isHost: p.isHost,
      isMuted: p.isMuted,
      isCameraOff: p.isCameraOff,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
    })),
  });
}