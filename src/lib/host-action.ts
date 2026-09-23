/**
 * Shared setup for host-only actions on another participant (mute,
 * remove): looks up the meeting, confirms the caller is its host, and
 * confirms the target is a currently active participant who isn't the
 * host themself. Every route that acts on another participant runs
 * through this so the checks can't drift between them.
 */

import { NextResponse } from "next/server";
import { AuthTokenPayload } from "./auth";
import { prisma } from "./prisma";

interface HostActionOk {
    ok: true;
    meeting: {id: number; token: string; hostId: number} ;
    target: {id: number; userId: number} ;
}

interface HostActionErr {
    ok : false;
    response: NextResponse;
}

export async function resolveHostAction(
    auth: AuthTokenPayload,
    token: string,
    targetUserId: number,
): Promise< HostActionOk | HostActionErr> {
    const meeting = await prisma.meeting.findUnique({where:{token}});
    if(!meeting) {
        return {
            ok: false,
            response: NextResponse.json({error: "No meeting found with that room code. "} , {status: 404}),
        };
    }
    if(meeting.hostId !== auth.sub) {
        return {
            ok: false,
            response: NextResponse.json({error: "Only the host can do that. "} , {status:403}),
        };
    }
    if(targetUserId === auth.sub) {
        return {
            ok : false,
            response: NextResponse.json({error:"You can't do that to yourself."}, {status:400}),
        };
    }

    const target = await prisma.participants.findFirst({
        where: { meetingId: meeting.id , userId: targetUserId, leftAt:null },
    });
    if(!target){
        return {
            ok:false,
            response:NextResponse.json(
                {error:"That person isn't currently in this meeting."},
                {status: 404},
            ),
        };
    }
    return {
        ok:true,
        meeting: {id:meeting.id, token: meeting.token , hostId:meeting.hostId},
        target: {id:target.id, userId:target.userId},
    };
}   