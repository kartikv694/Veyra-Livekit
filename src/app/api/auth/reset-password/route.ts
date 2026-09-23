/**
 * Step 2 (final) of the forgot-password flow. Takes the email, the
 * 6-digit code that was emailed in step 1, and a new password. If the
 * code matches and hasn't expired, the password is updated and the code
 * is cleared so it can't be reused.
 *
 * Request body:
 *   { "email": string, "code": string, "newPassword": string }
 *
 * Responses:
 *   200  { message }
 *   400  { error }  — invalid input, wrong code, or expired code
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email("Enter a valid email.").transform((v) => v.trim().toLowerCase()),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
  newPassword: z.string().min(6, "Password must be at least 6 characters."),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
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

  const password = await hashPassword(parsed.data.newPassword);
  await prisma.users.update({
    where: { id: user.id },
    data: { password, resetCodeHash: null, resetCodeExpiresAt: null },
  });

  return NextResponse.json({ message: "Password updated — you can now log in." });
}
