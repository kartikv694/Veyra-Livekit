/**
 * Returns everyone who has previously joined a meeting hosted by the
 * caller — used to populate the "Add others" contacts dropdown so a host
 * doesn't have to retype an email they've already invited before.
 *
 * Deliberately scoped to meetings the caller HOSTED (not every meeting
 * they've ever attended) — that's the relationship that actually implies
 * "I can invite this person to my next meeting."
 *
 * Responses:
 *   200  { contacts: { id, name, email }[] }  — most recently joined first
 *   401  { error }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const hostedMeetings = await prisma.meeting.findMany({
    where: { hostId: auth.sub },
    select: { id: true },
  });
  const meetingIds = hostedMeetings.map((m) => m.id);

  if (meetingIds.length === 0) {
    return NextResponse.json({ contacts: [] });
  }

  const rows = await prisma.participants.findMany({
    where: { meetingId: { in: meetingIds }, userId: { not: auth.sub } },
    select: { userId: true, joinedAt: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { joinedAt: "desc" },
  });

  // Dedup by user — rows are already newest-first, so the first time we
  // see a given userId is their most recent join across any of my meetings.
  const seen = new Set<number>();
  const contacts: { id: number; name: string | null; email: string }[] = [];
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    contacts.push({ id: row.user.id, name: row.user.name, email: row.user.email });
  }

  return NextResponse.json({ contacts });
}
