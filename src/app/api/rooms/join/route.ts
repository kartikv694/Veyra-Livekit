/**
 * Joins the caller to an existing meeting by its room token.
 * Requires `Authorization: Bearer <token>`.
 *
 * Three distinct cases:
 *
 *   - RETURNING participant (already has a Participant row here, e.g.
 *     reconnecting after a dropped call, or the host themself): always
 *     let straight in, regardless of anything else below. Just clears
 *     `leftAt`. This is what keeps the room freely re-joinable for
 *     people already part of it.
 *
 *   - FIRST-TIME participant whose account email matches an `Invite`
 *     the host sent for this meeting (see POST /api/rooms/[token]/invite):
 *     let straight in.
 *
 *   - Everyone else, first time: NOT let in directly. Instead this
 *     creates (or refreshes) a `JoinRequest` and notifies the host in
 *     real time — the waiting-room mechanism (SRS: host admits
 *     participants before they can join). The caller gets a 202 with
 *     `{ pending: true, requestId }` instead of a meeting/participant
 *     payload; the frontend polls GET .../join-requests/mine until the
 *     host admits or denies it.
 *
 * A locked meeting (`Meeting.locked`) blocks ALL first-time joins
 * outright — even an invited email — since locking is meant as an absolute
 * "no new joins right now". It never affects returning participants.
 *
 * A meeting link nobody has used in MEETING_EXPIRY_MS (see
 * src/lib/meeting-expiry.ts) auto-expires on the next join attempt — the
 * meeting is closed out right then (same as an explicit host end) and the
 * request is rejected. This is what stops an abandoned meeting (host left
 * without ending it, nobody ever came back) from having a permanently
 * valid link.
 *
 * Host identity itself is untouched by any of this — `Meeting.hostId`
 * never changes here. See /api/rooms/leave for why.
 *
 * Request body:
 *   { "token": string }
 *
 * Responses:
 *   200  { meeting: {...}, participant: {...}, participants: [...],
 *          livekitToken: string | null, livekitUrl: string | null }
 *        — let straight in. livekitToken/livekitUrl are null if LiveKit
 *          isn't configured (env vars unset) rather than failing the
 *          whole join — see the LiveKit section below.
 *   202  { pending: true, requestId: number }                 — waiting on host
 *   400  { error, details }  — validation failed
 *   401  { error }           — missing/invalid auth token
 *   403  { error }           — meeting is locked
 *   404  { error }           — no meeting with that token
 *   410  { error }           — meeting has already ended, or just expired from disuse
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, unauthorized } from "@/lib/auth";
import { buildRoomLink } from "@/lib/room-code";
import { emitToUser } from "@/lib/livekit-emitters";
import { isMeetingExpired } from "@/lib/meeting-expiry";
import { mintLiveKitToken, getLiveKitUrl } from "@/lib/livekit";

export const runtime = "nodejs";

const joinSchema = z.object({
  token: z.string().min(1, "Room token is required"),
});

// POST /api/rooms/join
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = joinSchema.safeParse(body);
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

  const metaRows = await prisma.$queryRaw<Array<{ scheduledAt: Date | null; lastActivityAt: Date }>>`
    SELECT "scheduledAt", "lastActivityAt" FROM "Meeting" WHERE "id" = ${meeting.id}
  `;
  const scheduledAt = metaRows[0]?.scheduledAt ?? null;
  const lastActivityAt = metaRows[0]?.lastActivityAt ?? meeting.createdAt;
  if (scheduledAt && scheduledAt.getTime() > Date.now()) {
    return NextResponse.json(
      { error: `This meeting is scheduled for ${scheduledAt.toLocaleString()}.` },
      { status: 403 },
    );
  }
  if (meeting.endAt) {
    return NextResponse.json({ error: "This meeting has already ended." }, { status: 410 });
  }

  // A link nobody has used in MEETING_EXPIRY_MS auto-expires — see the
  // Meeting.lastActivityAt schema comment. Closes it out exactly like an
  // explicit host end (endAt, active participants marked left, chat
  // cleared) so every other "meeting is over" code path treats it
  // identically, rather than needing a separate "expired" state.
  if (isMeetingExpired({ endAt: meeting.endAt, scheduledAt, lastActivityAt })) {
    await prisma.$transaction(async (tx) => {
      const endAt = new Date();
      await tx.meeting.update({ where: { id: meeting.id }, data: { endAt } });
      await tx.participants.updateMany({ where: { meetingId: meeting.id, leftAt: null }, data: { leftAt: endAt } });
      await tx.chatMessage.deleteMany({ where: { meetingId: meeting.id } });
    });
    return NextResponse.json({ error: "This meeting link has expired." }, { status: 410 });
  }

  const existingParticipant = await prisma.participants.findUnique({
    where: { meetingId_userId: { meetingId: meeting.id, userId: auth.sub } },
  });
  const isHostThemself = auth.sub === meeting.hostId;
  const isReturning = Boolean(existingParticipant) || isHostThemself;

  if (!isReturning) {
    if (meeting.locked) {
      return NextResponse.json(
        { error: "This meeting is locked. Ask the host to let you in." },
        { status: 403 },
      );
    }

    const me = await prisma.users.findUnique({ where: { id: auth.sub }, select: { email: true, name: true } });
    const invited = me
      ? await prisma.invite.findFirst({
          where: { meetingId: meeting.id, email: { equals: me.email, mode: "insensitive" } },
        })
      : null;
    if (!invited) {
      // Not pre-approved — queue a waiting-room request instead of
      // letting them in, and let the host know right away.
      const request = await prisma.joinRequest.upsert({
        where: { meetingId_userId: { meetingId: meeting.id, userId: auth.sub } },
        update: { status: "PENDING", requestedAt: new Date(), resolvedAt: null },
        create: { meetingId: meeting.id, userId: auth.sub, status: "PENDING" },
      });

      emitToUser(meeting.token, meeting.hostId, "join-request:new", {
        requestId: request.id,
        userId: auth.sub,
        name: me?.name ?? me?.email ?? "Someone",
      });

      return NextResponse.json({ pending: true, requestId: request.id }, { status: 202 });
    }
  }

  // Returning participants (including the host reconnecting) and invited
  // emails land here — this just clears
  // leftAt. isHost is only ever set on first creation (below), never
  // touched on a rejoin, so a returning host regains their rights
  // automatically and a returning regular participant stays regular.
  const participant = await prisma.participants.upsert({
    where: { meetingId_userId: { meetingId: meeting.id, userId: auth.sub } },
    update: { leftAt: null, joinedAt: new Date(), isHost: isHostThemself },
    create: {
      meetingId: meeting.id,
      userId: auth.sub,
      isHost: isHostThemself,
    },
  });

  // Resets the auto-expiry clock — this join IS the "activity" that
  // proves the link is still in use. Raw SQL since lastActivityAt is a
  // newer column the locally generated client may not know about yet on
  // some checkouts (same defensive pattern as the scheduledAt query
  // above) — a plain UPDATE doesn't depend on that.
  await prisma.$executeRaw`UPDATE "Meeting" SET "lastActivityAt" = NOW() WHERE "id" = ${meeting.id}`;

  // Clear any resolved/pending request now that they're actually in —
  // keeps GET .../join-requests from showing a stale entry for someone
  // who's since been let in some other way (e.g. the host invited them
  // by email after they'd already asked to join).
  await prisma.joinRequest.updateMany({
    where: { meetingId: meeting.id, userId: auth.sub, status: "PENDING" },
    data: { status: "ADMITTED", resolvedAt: new Date() },
  });

  // Return the active roster with the join response. This removes the
  // follow-up GET /api/rooms call that the room page previously made after
  // every successful join.
  const activeParticipants = await prisma.participants.findMany({
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

  // LiveKit token for this join — minted fresh every time (including a
  // rejoin after a refresh), not stored. If LiveKit isn't configured yet
  // (env vars unset — e.g. mid-migration, before the frontend has been
  // switched over to it), this degrades to null rather than failing the
  // whole join: the room name/media transport aren't ready for it yet,
  // but chat, presence, and everything else this route already provides
  // should keep working regardless.
  let livekitToken: string | null = null;
  let livekitUrl: string | null = null;
  try {
    livekitUrl = getLiveKitUrl();
    const me = await prisma.users.findUnique({ where: { id: auth.sub }, select: { name: true } });
    livekitToken = await mintLiveKitToken({
      roomName: meeting.token,
      identity: String(auth.sub),
      name: me?.name ?? "Guest",
    });
  } catch (err) {
    console.error("Failed to mint LiveKit token (LiveKit not configured yet?):", err);
  }

  return NextResponse.json({
    meeting: {
      id: meeting.id,
      token: meeting.token,
      link: buildRoomLink(meeting.token),
      createdAt: meeting.createdAt,
      scheduledAt,
      endAt: meeting.endAt,
      hostId: meeting.hostId,
      locked: meeting.locked,
      passcodeSet: meeting.passcode !== null,
      title: meeting.title,
      durationMinutes: meeting.durationMinutes,
    },
    participant: {
      id: participant.id,
      isHost: participant.isHost,
      isMuted: participant.isMuted,
      isCameraOff: participant.isCameraOff,
      joinedAt: participant.joinedAt,
    },
    participants: activeParticipants.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      email: p.user.email,
      isHost: p.isHost,
      isMuted: p.isMuted,
      isCameraOff: p.isCameraOff,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
    })),
    livekitToken,
    livekitUrl,
  });
}
