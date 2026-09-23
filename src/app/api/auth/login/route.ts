/**
 *
 * Verifies email + password and returns a fresh auth token.
 *
 * Request body:
 *   { "email": string, "password": string }
*
* Responses:
*   200  { user: { id, name, email, username, createdAt }, token }
*   400  { error, details }                            — validation failed
*   404  { error, reason: "not_registered" }             — no account with that email
*   401  { error, reason: "invalid_password" }            — email exists, password is wrong
*   429  { error }                                          — too many attempts, try again later
*
* Note on `reason`: this deliberately distinguishes "no such account" from
* "wrong password" (a generic single message is more common practice, to
 * stop the endpoint being used to enumerate registered emails) so the
 * client can bounce a not-yet-registered visitor straight to /signup
 * instead of just showing a dead-end error. That's a product trade-off
 * made intentionally here, not an oversight.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword, signAuthToken } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** 10 attempts per 15 minutes per IP — generous enough for a real person
 *  fumbling their password a few times, tight enough to slow down
 *  automated guessing. */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().email("Must be a valid email address").transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1, "Password is required"),
});

// POST /api/auth/login
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!checkRateLimit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again in a few minutes." },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { email, password } = parsed.data;

  const user = await prisma.users.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json(
      { error: "No account found with that email.", reason: "not_registered" },
      { status: 404 },
    );
  }

  const passwordMatches = await verifyPassword(password, user.password);
  if (!passwordMatches) {
    return NextResponse.json(
      { error: "Incorrect password.", reason: "invalid_password" },
      { status: 401 },
    );
  }

  const token = signAuthToken({ sub: user.id, email: user.email });

  return NextResponse.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      createdAt: user.createdAt,
    },
    token,
  });
}
