/**
 * Host-only. Ends the meeting for everyone (SRS: "Host can ... end the
 * meeting"). Sets `Meeting.endAt` and immediately pushes a `meeting:ended`
 * event to every connected client in the room, so participants leave right
 * away instead of waiting for their next roster poll to notice.
*
* Responses:
*   200  { meeting: { id, token, endAt } }
*   401  { error }  — missing/invalid auth token
*   403  { error }  — caller isn't the host
*   404  { error }  — no meeting with that token
*   409  { error }  — meeting has already ended
*/

import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitToMeeting } from "@/lib/livekit-emitters";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// POST /api/rooms/[token]/end
export async function POST(
    req: NextRequest,
    {params} : {params: Promise<{ token: string }> },
) {
    const auth = requireAuth(req);
    if (!auth) return unauthorized();

    const { token } = await params;
    const meeting = await prisma.meeting.findUnique({where: {token}});
    if(!meeting) {
        return NextResponse.json({error: "No meeting with that room code. "}, {status: 404});
    }

    if(meeting.hostId !== auth.sub) {
        return NextResponse.json({error: "Only the host can end this meeting." }, {status:403})
    }

    if(meeting.endAt){
        return NextResponse.json({error: "This meeting has Already ended"}, {status: 409});
    }

    const ended = await prisma.$transaction(async (tx) => {
        const endAt = new Date();

        const updatedMeeting = await tx.meeting.update({
            where: { id: meeting.id },
            data: { endAt },
        });

        // Explicitly ending for everyone also closes every currently-active
        // participant session. A normal Leave action does NOT end the room.
        await tx.participants.updateMany({
            where: { meetingId: meeting.id, leftAt: null },
            data: { leftAt: endAt },
        });

        // Chat is "live only, not saved anywhere" by design — recoverable
        // on a refresh during the meeting (see GET .../chat), but not a
        // permanent record once the meeting itself is over.
        await tx.chatMessage.deleteMany({ where: { meetingId: meeting.id } });

        return updatedMeeting;
    });

    // The database is authoritative. The socket event is a best-effort
    // immediate notification; clients also detect endAt through roster polling.
    emitToMeeting(token, "meeting:ended");

    return NextResponse.json({
        meeting: { id: ended.id, token: ended.token, endAt: ended.endAt },
    });
}