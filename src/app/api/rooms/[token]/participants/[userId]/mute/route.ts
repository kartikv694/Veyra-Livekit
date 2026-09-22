/**
 *
 *
 * Host-only. Force-mutes another active participant. Covers two related
 * SRS items with one mechanism: "Host can mute participants" and
 * "allow/disable participant speaking" — disabling someone's mic is how
 * both are implemented here.
 *
 * Sets `Participant.isMuted` and pushes a real-time
 * `participant:force-muted` event so the muted person's own client
 * disables its microphone track immediately, and everyone else's tile for
 * them updates too — not just a database flag nobody sees until their next
 * poll.
 *
 * Deliberately one-directional: the host can force someone *muted*, but
 * can't force them *unmuted* — only that person's own control can turn
 * their mic back on, matching how most meeting apps handle it (a host
 * shouldn't be able to unmute someone without their action).
 *
 * Responses:
 *   200  { muted: <userId> }
 *   400  { error }  — invalid participant id, or targeting yourself
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }  — no such meeting, or target isn't currently in it
 */

import { requireAuth, unauthorized } from "@/lib/auth";
import { resolveHostAction } from "@/lib/host-action";
import { prisma } from "@/lib/prisma";
import { emitToMeeting } from "@/lib/livekit-emitters";
import { NextRequest, NextResponse } from "next/server";


export const runtime = "nodejs";
//  POST /api/rooms/[token]/participants/[userId]/mute
export async function POST(
    req: NextRequest,
    {params}: {params: Promise<{token:string; userId: string}> },
) {
    const auth = requireAuth(req);
    if(!auth) return unauthorized();

    const { token, userId } = await params;
    const targetUserId = Number(userId);
    if(!Number.isInteger(targetUserId)) {
        return NextResponse.json({error: "Invalid participant id."} , {status: 400});
    }
    const resolved = await resolveHostAction(auth , token, targetUserId);
    if(!resolved.ok) return resolved.response;

    const current = await prisma.participants.findUnique({
        where: { id: resolved.target.id },
        select: { isMuted: true },
    });
    if (!current) {
        return NextResponse.json({ error: "That person isn't currently in this meeting." }, { status: 404 });
    }
    const muted = !current.isMuted;
    await prisma.participants.update({
        where: { id: resolved.target.id },
        data: { isMuted: muted },
    });

    emitToMeeting(token, muted ? "participant:force-muted" : "participant:force-unmuted", { userId: targetUserId });

    return NextResponse.json({ userId: targetUserId, muted });
}