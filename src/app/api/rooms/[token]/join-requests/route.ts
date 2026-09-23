/**
 * Host-only. Lists everyone currently waiting to be admitted into this
 * meeting — the "Waiting to be admitted" list (matches Meet's own
 * People panel section). Used for the initial load, and also polled
 * periodically by the room page as a fallback in case the "new request"
 * socket push (join-request:new) is slow or dropped — see the polling
 * effect in room/[token]/page.tsx for why that matters.
 *
 * Responses:
 *   200  { requests: { id, userId, name, requestedAt }[] }
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }  — no such meeting
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }
  if (meeting.hostId !== auth.sub) {
    return NextResponse.json({ error: "Only the host can see this." }, { status: 403 });
  }

  const requests = await prisma.joinRequest.findMany({
    where: { meetingId: meeting.id, status: "PENDING" },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { requestedAt: "asc" },
  });

  return NextResponse.json({
    requests: requests.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.user.name ?? r.user.email,
      requestedAt: r.requestedAt,
    })),
  });
}
