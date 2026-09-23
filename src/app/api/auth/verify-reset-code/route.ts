/**
 * Middle step of the forgot-password flow. Checks that the 6-digit code
 * is correct and not expired — WITHOUT touching the password and WITHOUT
 * clearing the code, since the actual reset-password call still needs to
 * re-verify it. This just lets the frontend show "verification
 * successful" and reveal the new-password fields before asking for a new
 * password at all.
 *
 * Request body:
 *   { "email": string, "code": string }
 *
 * Responses:
 *   200  { message }
 *   400  { error }  — invalid input, wrong code, or expired code (all the
 *                     same generic message — this never confirms which
 *                     emails have an account, same reasoning as
 *                     forgot-password)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email("Enter a valid email.").transform((v) => v.trim().toLowerCase()),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const user = await prisma.users.findUnique({ where: { email: parsed.data.email } });
  if (!user || !user.resetCodeHash || !user.resetCodeExpiresAt) {
    return NextResponse.json({ error: "Invalid or expired code." }, { status: 400 });
  }
  if (user.resetCodeExpiresAt < new Date()) {
    return NextResponse.json({ error: "This code has expired — request a new one." }, { status: 400 });
  }

  const codeMatches = await verifyPassword(parsed.data.code, user.resetCodeHash);
  if (!codeMatches) {
    return NextResponse.json({ error: "Invalid or expired code." }, { status: 400 });
  }

  return NextResponse.json({ message: "Code verified." });
}
