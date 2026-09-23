/**
 * 
 *
 * Creates a new user account and immediately logs them in (returns a token,
 * same as /api/auth/login would) so the client can go straight from signup
 * to the dashboard without a second request.
 *
 * Request body:
 *   { "name": string, "email": string, "password": string (min 8 chars), "username"?: string }
 *
 * Responses:
 *   201  { user: { id, name, email, username, createdAt }, token }
 *   400  { error, details }   — validation failed
 *   409  { error, reason: "already_registered" }   — email already registered
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, signAuthToken } from "@/lib/auth";
import { sendWelcomeEmail } from "@/lib/mailer";

// Prisma needs the Node.js runtime (not the Edge runtime).
export const runtime = "nodejs";

const signupSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Must be a valid email address").transform((v) => v.trim().toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters"),
  username: z.string().min(3).max(30).optional(),
});

// POST /api/auth/signup
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { name, email, password, username } = parsed.data;

  const existingUser = await prisma.users.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json(
      { error: "An account with this email already exists.", reason: "already_registered" },
      { status: 409 },
    );
  }

  const hashedPassword = await hashPassword(password);

  const user = await prisma.users.create({
    data: { name, email, password: hashedPassword, username },
    // Never return the password hash to the client.
    select: { id: true, name: true, email: true, username: true, createdAt: true },
  });

  const token = signAuthToken({ sub: user.id, email: user.email });

  // Awaited (unlike a true fire-and-forget) — on Vercel, an unawaited
  // async call can get killed mid-flight the moment the function
  // returns its response, before it actually finishes sending. Wrapped
  // in try/catch so a failed or slow email still doesn't break account
  // creation itself — same "best-effort, but logged" pattern as the
  // invite/reset emails elsewhere in this file.
  try {
    await sendWelcomeEmail({ to: user.email, name: user.name ?? user.email });
  } catch (err) {
    console.error(`Failed to send welcome email to ${user.email}:`, err);
  }

  return NextResponse.json({ user, token }, { status: 201 });
}
