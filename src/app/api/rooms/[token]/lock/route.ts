/**
 * PATCH /api/rooms/[token]/lock
 *
 * Host-only. Sets whether the meeting is locked (SRS: "control meeting
 * access"). While locked, a brand-new participant can't join at all — see
 * the locked check in /api/rooms/join — regardless of whether the host is
 * present. It has no effect on anyone already in the meeting; they can
 * still leave and rejoin freely (same reasoning as the host-presence gate
 * that join route already implements).
 *
 * Request body:
 *   { "locked": boolean }
 *
 * Responses:
 *   200  { meeting: { id, token, locked } }
 *   400  { error, details }
 *   401  { error }
 *   403  { error }  — caller isn't the host
 *   404  { error }
 */

import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import z from "zod";

export const runtime = "nodejs";

const lockSchema = z.object({locked: z.boolean() }); 

export async function PATCH(
    req: NextRequest,
    { params }: {params: Promise<{token:string}>},
) {
    const auth = requireAuth(req);
    if(!auth) return unauthorized();

    const {token} = await params;
    const body = await req.json().catch(()=>null);
    const parsed = lockSchema.safeParse(body);
    if(!parsed.success) {
        return NextResponse.json(
            {error: "Invalid input", details: parsed.error.flatten()},
            {status: 400},
        );
    }
    const meeting = await prisma.meeting.findUnique({where: {token}});
    if(!meeting) {
        return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
    }
    if (meeting.hostId !== auth.sub) {
    return NextResponse.json({ error: "Only the host can change meeting access." }, { status: 403 });
    }

    const updated = await prisma.meeting.update
    ({
        where: {id: meeting.id},
        data: {locked:parsed.data.locked},
    });
    
    return NextResponse.json({
        meeting: { id: updated.id, token: updated.token, locked: updated.locked },
    });
}
