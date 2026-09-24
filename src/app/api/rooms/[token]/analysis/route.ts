/**
 * Host-only. Returns the AI meeting analysis (see `ParticipantAnalysis` in
 * the schema) for this meeting — one entry per participant who spoke,
 * scored 0-5 on communication, fluency, topic knowledge, teamwork &
 * listening, leadership & initiative, and confidence & professionalism,
 * plus an optional short summary. Written by the separate LiveKit agent
 * worker (../../../../agent-worker, not this Next.js app) after the
 * meeting ends, so this can legitimately return an empty list for a while
 * even for a meeting that's genuinely over — the meeting-ended screen
 * polls this for exactly that reason (see its own comment), not because a
 * first empty response means analysis will never arrive.
 *
 * Host-only specifically because this is analysis *of* the other
 * participants — not something they'd see about themselves, same
 * reasoning as why only the host sees things like the invite list.
 *
 * Responses:
 *   200  { analysis: { userId, name, communication, fluency, topicKnowledge,
 *          teamworkListening, leadershipInitiative,
 *          confidenceProfessionalism, summary }[] }
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
    return NextResponse.json({ error: "Only the host can view the meeting analysis." }, { status: 403 });
  }

  const rows = await prisma.participantAnalysis.findMany({
    where: { meetingId: meeting.id },
    orderBy: { name: "asc" },
    select: {
      userId: true,
      name: true,
      communication: true,
      fluency: true,
      topicKnowledge: true,
      teamworkListening: true,
      leadershipInitiative: true,
      confidenceProfessionalism: true,
      summary: true,
    },
  });

  return NextResponse.json({ analysis: rows });
}
