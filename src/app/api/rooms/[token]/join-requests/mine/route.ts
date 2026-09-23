/**
 * The waiting joiner's own view of their request — polled from the
 * lobby's "Asking to join..." screen every few seconds until it
 * resolves. Not authenticated as "the host" — this is the requester
 * checking on themselves, so it only ever returns their own status,
 * never anyone else's.
 *
 * Responses:
 *   200  { status: "PENDING" | "ADMITTED" | "DENIED" | "NONE" }
 *   401  { error }
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

  const request = await prisma.joinRequest.findUnique({
    where: { meetingId_userId: { meetingId: meeting.id, userId: auth.sub } },
  });

  return NextResponse.json({ status: request?.status ?? "NONE" });
}
