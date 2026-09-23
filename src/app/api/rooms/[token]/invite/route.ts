/**
 * Host-only. Adds one or more email addresses to a meeting's invite
 * list — anyone whose account email matches one of these gets let
 * straight into the meeting (see POST /api/rooms/join) instead of
 * having to wait in the lobby for the host to admit them.
 *
 * The invited person doesn't need an account yet at invite time — the
 * match happens by email when they actually try to join. Inviting the
 * same email twice for the same meeting is a no-op (unique constraint),
 * not an error.
 *
 * Request body:
 *   { "emails": string[] }
 *
 * Responses:
 *   200  { invited: string[] }
 *   400  { error, details }
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }  — no such meeting
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildRoomLink } from "@/lib/room-code";
import { sendMeetingInviteEmail } from "@/lib/mailer";

export const runtime = "nodejs";

const inviteSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(50),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token } = await params;
  const body = await req.json().catch(() => null);
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }
  if (meeting.hostId !== auth.sub) {
    return NextResponse.json({ error: "Only the host can invite people." }, { status: 403 });
  }

  const host = await prisma.users.findUnique({ where: { id: auth.sub }, select: { name: true, email: true } });
  const hostName = host?.name ?? host?.email ?? "Someone";

  const emails = [...new Set(parsed.data.emails.map((e) => e.trim().toLowerCase()))];
  await Promise.all(
    emails.map((email) =>
      prisma.invite.upsert({
        where: { meetingId_email: { meetingId: meeting.id, email } },
        update: {},
        create: { meetingId: meeting.id, email },
      }),
    ),
  );

  // Best-effort — a failed email shouldn't undo the invite records
  // themselves, since the person is still on the invite list and can
  // still be told about it another way (the link copied/shared
  // manually). Each send is independent, so one bad address doesn't
  // block the rest. But a silent failure here is indistinguishable from
  // "nobody got anything" — so every rejection gets logged loudly
  // server-side, and the response tells the caller which addresses (if
  // any) didn't actually go out, instead of unconditionally claiming
  // success.
  // Deliberately NOT passing scheduledAt/timeZone here — this route is for
  // inviting someone into a meeting that already exists (often already
  // under way), not the original scheduling action. The meeting's
  // scheduledAt could be hours in the past by the time a host reaches for
  // "Add others," so showing it here would read as "scheduled for
  // <stale time>" instead of the immediate "invited you to a meeting"
  // this actually is. The schedule route (POST /api/rooms/schedule) is
  // the one place that legitimately shows a future scheduled time.
  const meetingUrl = buildRoomLink(meeting.token);
  const results = await Promise.allSettled(
    emails.map((email) => sendMeetingInviteEmail({ to: email, hostName, hostEmail: host?.email, meetingUrl })),
  );
  const failedEmails: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      failedEmails.push(emails[i]);
      console.error(`Failed to send invite email to ${emails[i]}:`, result.reason);
    }
  });

  return NextResponse.json({
    invited: emails,
    emailsFailed: failedEmails.length > 0 ? failedEmails : undefined,
  });
}


/** Host-only. Returns the current email invite list for the meeting. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();
  const { token } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  if (meeting.hostId !== auth.sub) return NextResponse.json({ error: "Only the host can view invitations." }, { status: 403 });

  const invites = await prisma.invite.findMany({
    where: { meetingId: meeting.id },
    orderBy: { invitedAt: "asc" },
    select: { id: true, email: true, invitedAt: true },
  });
  return NextResponse.json({ invites });
}
