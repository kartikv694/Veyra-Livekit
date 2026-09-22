/**
 *
 * Host-only. Removes another active participant from the meeting (SRS:
 * "Host can ... remove participants"). Sets their `Participant.leftAt`,
 * then notifies them directly (`meeting:removed`, via LiveKit's data
 * channel — see src/lib/livekit-emitters.ts) and disconnects them from
 * the LiveKit room server-side, so everyone else's tile for them
 * disappears the same way it would if they'd left on their own. No
 * separate "you were removed, tell everyone" event is needed for that
 * part — LiveKit's own ParticipantDisconnected fires for everyone still
 * in the room once they're gone.
 *
 * Known limitation, worth knowing rather than discovering by surprise:
 * this doesn't ban the person. Their `Participant` row already exists, so
 * a follow-up `POST /api/rooms/join` sees them as a *returning*
 * participant (see that route) and lets them straight back in — the
 * host-presence/lock checks there only apply to first-time joins. If a
 * removal needs to actually stick, lock the meeting (`PATCH
 * /api/rooms/[token]/lock`) at the same time; that at least stops anyone
 * *new* from joining, though it doesn't retroactively block a returning
 * removed participant either. A real "banned" state would need its own
 * field — not added here since it wasn't asked for, but flagged in case
 * it should be.
 *
 * Responses:
 *   200  { removed: <userId> }
 *   400  { error }  — invalid participant id, or targeting yourself
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }  — no such meeting, or target isn't currently in it
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, unauthorized } from "@/lib/auth";
import { resolveHostAction } from "@/lib/host-action";
import { emitToUser } from "@/lib/livekit-emitters";

export const runtime = "nodejs";

// POST /api/rooms/[token]/participants/[userId]/remove
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; userId: string }> },
) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token, userId } = await params;
  const targetUserId = Number(userId);
  if (!Number.isInteger(targetUserId)) {
    return NextResponse.json({ error: "Invalid participant id." }, { status: 400 });
  }

  const resolved = await resolveHostAction(auth, token, targetUserId);
  if (!resolved.ok) return resolved.response;

  await prisma.participants.update({
    where: { id: resolved.target.id },
    data: { leftAt: new Date() },
  });

  emitToUser(token, targetUserId, "meeting:removed", undefined, true);

  return NextResponse.json({ removed: targetUserId });
}
