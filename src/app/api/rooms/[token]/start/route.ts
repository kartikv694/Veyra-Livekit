import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorized } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const { token } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { token } });
  if (!meeting) return NextResponse.json({ error: "No meeting found with that room code." }, { status: 404 });
  if (meeting.hostId !== auth.sub) return NextResponse.json({ error: "Only the host can start this meeting." }, { status: 403 });
  if (meeting.endAt) return NextResponse.json({ error: "This meeting has already ended." }, { status: 410 });

  const rows = await prisma.$queryRaw<Array<{ scheduledAt: Date | null; startedAt: Date | null }>>`
    SELECT "scheduledAt", "startedAt" FROM "Meeting" WHERE "id" = ${meeting.id}
  `;
  const current = rows[0];
  if (current?.startedAt) return NextResponse.json({ ok: true, startedAt: current.startedAt });

  if (current?.scheduledAt && current.scheduledAt.getTime() > Date.now()) {
    return NextResponse.json(
      { error: `You can start this meeting at ${current.scheduledAt.toLocaleString()}.` },
      { status: 403 },
    );
  }

  const startedAt = new Date();
  await prisma.$executeRaw`
    UPDATE "Meeting" SET "startedAt" = ${startedAt}, "updatedAt" = NOW() WHERE "id" = ${meeting.id}
  `;

  return NextResponse.json({ ok: true, startedAt });
}
