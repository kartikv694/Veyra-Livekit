/**
 * PATCH /api/rooms/[token]/passcode
 *
 * Host-only. Sets or clears the meeting's passcode (SRS: "Meeting
 * Security"). A meeting's token is already unguessable, but a link can be
 * forwarded on without the sender intending to grant access — a passcode
 * is a second, out-of-band-shared secret for meetings that need it. Only
 * gates first-time joins (see /api/rooms/join), same as `locked`.
 *
 * Request body:
 *   { "passcode": string | null }   — null (or omit/empty string) clears it
 *
 * Responses:
 *   200  { meeting: { id, token, passcodeSet: boolean } }
 *   400  { error, details }
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";

const passcodeSchema = z.object({
  passcode: z
    .string()
    .trim()
    .min(4, "Passcode must be at least 4 characters")
    .max(64)
    .nullable(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token } = await params;
  const body = await req.json().catch(() => null);
  // Treat an empty string the same as null — "clear the passcode".
  const normalized = body && typeof body === "object" && body.passcode === "" ? { passcode: null } : body;
  const parsed = passcodeSchema.safeParse(normalized);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) {
    return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  }
  if (meeting.hostId !== auth.sub) {
    return NextResponse.json({ error: "Only the host can change the meeting passcode." }, { status: 403 });
  }

  const updated = await prisma.meeting.update({
    where: { id: meeting.id },
    data: { passcode: parsed.data.passcode },
  });

  return NextResponse.json({
    meeting: { id: updated.id, token: updated.token, passcodeSet: updated.passcode !== null },
  });
}
