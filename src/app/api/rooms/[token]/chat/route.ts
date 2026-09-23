/**
 * GET returns this meeting's chat history so far — read once when the
 * room page loads (including on a refresh), so an ongoing conversation
 * isn't lost. POST sends a new message: persists it, then broadcasts it
 * in real time via LiveKit's data channel (see
 * src/lib/livekit-emitters.ts) so everyone currently in the meeting sees
 * it immediately. This used to be entirely the backend Socket.IO
 * server's job (both the DB write and the broadcast) — POST here
 * replaces both halves, so chat no longer depends on that separate
 * service being up. Broadcast payload shape is unchanged from the old
 * socket event (`peer:chat-message`: { text, name, userId, at }), so the
 * receiving side's dispatcher (handleRealtimeEvent in
 * useMeetingRoom.ts) needed no changes beyond listening on a new
 * transport.
 *
 * Anyone currently a participant can read or send, not just the host —
 * chat has always been open to everyone in the meeting.
 *
 * Responses:
 *   GET   200  { messages: { id, userId, fromName, text, at }[] }
 *         401  { error }
 *         403  { error }  — caller has never been a participant
 *         404  { error }  — no such meeting
 *   POST  200  { id, userId, fromName, text, at }
 *         400  { error }  — empty or too-long message
 *         401  { error }
 *         403  { error }  — caller isn't *currently* a participant
 *         404  { error }  — no such meeting
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitToMeeting } from "@/lib/livekit-emitters";

export const runtime = "nodejs";

const MAX_MESSAGE_LENGTH = 2000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }

  const isParticipant = await prisma.participants.findFirst({
    where: { meetingId: meeting.id, userId: auth.sub },
  });
  if (!isParticipant) {
    return NextResponse.json({ error: "You're not currently in this meeting." }, { status: 403 });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { meetingId: meeting.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, userId: true, fromName: true, text: true, createdAt: true },
  });

  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      userId: m.userId,
      fromName: m.fromName,
      text: m.text,
      at: m.createdAt.getTime(),
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Message can't be empty." }, { status: 400 });
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` }, { status: 400 });
  }

  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }

  const participant = await prisma.participants.findFirst({
    where: { meetingId: meeting.id, userId: auth.sub, leftAt: null },
  });
  if (!participant) {
    return NextResponse.json({ error: "You're not currently in this meeting." }, { status: 403 });
  }

  const user = await prisma.users.findUnique({ where: { id: auth.sub }, select: { name: true } });
  const fromName = user?.name ?? "Guest";

  const message = await prisma.chatMessage.create({
    data: { meetingId: meeting.id, userId: auth.sub, fromName, text },
    select: { id: true, userId: true, fromName: true, text: true, createdAt: true },
  });

  const at = message.createdAt.getTime();
  emitToMeeting(token, "peer:chat-message", { text: message.text, name: message.fromName, userId: message.userId, at });

  return NextResponse.json({ id: message.id, userId: message.userId, fromName: message.fromName, text: message.text, at });
}
