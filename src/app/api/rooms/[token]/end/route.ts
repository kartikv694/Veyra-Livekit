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
import { endMeetingInDb } from "@/lib/end-meeting";
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

    const ended = await endMeetingInDb(meeting.id);

    // The database is authoritative. The socket event is a best-effort
    // immediate notification; clients also detect endAt through roster polling.
    emitToMeeting(token, "meeting:ended");

    return NextResponse.json({
        meeting: { id: ended.id, token: ended.token, endAt: ended.endAt },
    });
}