/**
 * Room token generation.
 *
 * Meeting rooms are identified by a short, shareable code like
 * "7fk-2xa-plm" (matches the format already previewed in the dashboard UI).
 * The full join link is built from this token at request time
 * (`${APP_URL}/room/<token>`) rather than stored — one source of truth.
 */
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

/** Lowercase letters + digits — unambiguous, easy to read aloud or type. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generates one 3-character group using cryptographically strong randomness. */
function randomGroup(length = 3): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

/** Generates a room token in the "xxx-xxx-xxx" shape. Not guaranteed unique
 *  on its own — see `createUniqueRoomToken`. */
export function generateRoomToken(): string {
  return `${randomGroup()}-${randomGroup()}-${randomGroup()}`;
}

/**
 * Generates a room token and confirms it isn't already in use before
 * returning it. Collisions are astronomically unlikely (36^9 possible
 * tokens) but we check anyway rather than relying on the database's unique
 * constraint to fail loudly mid-request.
 */
export async function createUniqueRoomToken(): Promise<string> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = generateRoomToken();
    const existing = await prisma.meeting.findUnique({ where: { token } });
    if (!existing) return token;
  }
  throw new Error(`Could not generate a unique room token after ${MAX_ATTEMPTS} attempts.`);
}

/** Builds the full shareable join link from a room token. */
export function buildRoomLink(token: string): string {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  return `${base}/room/${token}`;
}
