/**
 * Step 1 of the forgot-password flow. Takes an email, and if an account
 * with that email exists, generates a random 6-digit code, hashes it (same
 * reasoning as password hashing — if the DB leaks, the code alone isn't
 * enough), stores the hash + an expiry (CODE_VALID_MINUTES, default 5) on
 * the user, and emails the plain code to them.
 *
 * Deliberately returns the SAME success message whether or not an account
 * exists for that email — otherwise this endpoint could be used to check
 * which emails are registered. If nothing was actually sent (no account),
 * that's silent from the caller's point of view.
 *
 * Request body:
 *   { "email": string }
 *
 * Responses:
 *   200  { message }         — always, regardless of whether the account exists
 *   400  { error, details }  — validation failed
 *   502  { error }           — account exists but the email genuinely failed to send
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { sendPasswordResetEmail } from "@/lib/mailer";

export const runtime = "nodejs";

const CODE_VALID_MINUTES = Number(process.env.CODE_VALID_MINUTES) || 5;

const schema = z.object({ email: z.string().email("Enter a valid email.").transform((v) => v.trim().toLowerCase()) });

function generateSixDigitCode(): string {
  // crypto.randomInt is uniform (unlike Math.random-based approaches) and
  // always produces a full 6 digits — no leading-zero edge cases.
  return crypto.randomInt(1, 10).toString() + crypto.randomInt(0, 100_000).toString().padStart(5, "0");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const user = await prisma.users.findUnique({ where: { email: parsed.data.email } });
  const genericMessage = { message: "If an account exists for that email, a code has been sent." };

  if (!user) {
    // Same response either way — see the doc comment above.
    return NextResponse.json(genericMessage);
  }

  const code = generateSixDigitCode();
  const resetCodeHash = await hashPassword(code);
  const resetCodeExpiresAt = new Date(Date.now() + CODE_VALID_MINUTES * 60 * 1000);

  await prisma.users.update({
    where: { id: user.id },
    data: { resetCodeHash, resetCodeExpiresAt },
  });

  try {
    await sendPasswordResetEmail({ to: user.email, code, validMinutes: CODE_VALID_MINUTES });
  } catch (err) {
    console.error("Failed to send password reset email:", err);
    return NextResponse.json({ error: "Couldn't send the reset email right now — please try again shortly." }, { status: 502 });
  }

  return NextResponse.json(genericMessage);
}
