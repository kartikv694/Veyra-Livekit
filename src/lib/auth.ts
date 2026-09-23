/**
 * Authentication utilities.
 *
 * Auth strategy: stateless JWTs (per the SRS's "NextAuth.js / JWT" option —
 * we use plain JWT here so every endpoint is directly testable in Postman
 * without a browser session/cookie flow).
 *
 * Flow:
 *   1. POST /api/auth/signup or /api/auth/login returns a signed token.
 *   2. The client stores it and sends it back as `Authorization: Bearer <token>`
 *      on every request to a protected route.
 *   3. `requireAuth(req)` verifies the token and returns the caller's identity,
 *      or `null` if the request isn't authenticated.
 */
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

/** Number of bcrypt salt rounds. 10 is a reasonable cost for this scale. */
const SALT_ROUNDS = 10;

/** How long an issued token stays valid before the user must log in again. */
const TOKEN_TTL = "7d";

/** Shape of the data encoded inside every auth token this app issues. */
export interface AuthTokenPayload {
  /** The authenticated user's id (JWT "subject"). */
  sub: number;
  /** Included for convenience so callers don't need a DB lookup just to
   *  display who's logged in. */
  email: string;
}

/**
 * Hashes a plain-text password for storage. Never store or log the raw
 * password — only this hash is persisted to `User.password`.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compares a plain-text password (from a login request) against the stored
 * hash. Returns true only on an exact match.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Reads JWT_SECRET from the environment, failing loudly if it's missing
 *  rather than silently signing tokens with `undefined`. */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set — add it to your .env file.");
  }
  return secret;
}

/** Issues a signed JWT for a newly authenticated user (signup or login). */
export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

/**
 * Verifies a token's signature and expiry.
 * Returns the decoded payload if valid, or `null` if the token is missing,
 * malformed, expired, or signed with a different secret.
 */
export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as unknown as AuthTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Extracts the bearer token from a request's `Authorization` header.
 * Expects the standard `Authorization: Bearer <token>` format.
 */
export function getBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

/**
 * Route-handler guard: verifies the request's bearer token and returns the
 * caller's identity, or `null` if it's missing/invalid. Callers should
 * respond with `unauthorized()` when this returns `null`.
 *
 * Example:
 *   const auth = requireAuth(req);
 *   if (!auth) return unauthorized();
 *   // auth.sub is the authenticated user's id
 */
export function requireAuth(req: Request): AuthTokenPayload | null {
  const token = getBearerToken(req);
  if (!token) return null;
  return verifyAuthToken(token);
}

/** Standard 401 response for a missing/invalid auth token. */
export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Missing or invalid authorization token." },
    { status: 401 },
  );
}
