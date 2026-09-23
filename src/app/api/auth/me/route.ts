/**
 * 
 *
 * Verifies the caller's bearer token against the database (not just its
 * signature/expiry) and returns their current profile. This is what the
 * client calls to answer "am I actually still logged in?" before letting
 * someone through a gated action — a token merely existing in localStorage
 * isn't trustworthy on its own (expired, or the account could since have
 * been removed), so this is the one source of truth for that check.
 *
 * Responses:
 *   200  { user: { id, name, email, username, createdAt } }
 *   401  { error }  — missing/invalid/expired token, or the user no longer exists
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
// GET /api/auth/me
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (!auth) return unauthorized();

  const user = await prisma.users.findUnique({
    where: { id: auth.sub },
    select: { id: true, name: true, email: true, username: true, createdAt: true },
  });

  // Token was validly signed, but the account it points to is gone.
  if (!user) return unauthorized();

  return NextResponse.json({ user });
}
