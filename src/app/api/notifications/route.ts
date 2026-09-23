import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const notifications = await prisma.$queryRaw<Array<{
    id: number; title: string; message: string; link: string | null;
    readAt: Date | null; createdAt: Date;
  }>>`
    SELECT "id", "title", "message", "link", "readAt", "createdAt"
    FROM "Notification"
    WHERE "userId" = ${auth.sub}
    ORDER BY "createdAt" DESC
    LIMIT 20
  `;

  return NextResponse.json({
    notifications,
    unreadCount: notifications.filter((n) => !n.readAt).length,
  });
}

export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  await prisma.$executeRaw`
    UPDATE "Notification"
    SET "readAt" = COALESCE("readAt", NOW())
    WHERE "userId" = ${auth.sub} AND "readAt" IS NULL
  `;

  return NextResponse.json({ ok: true });
}
