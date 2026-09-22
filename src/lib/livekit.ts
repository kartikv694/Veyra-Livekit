/**
 * Mints short-lived LiveKit access tokens server-side. LIVEKIT_API_SECRET
 * never reaches the browser — the client only ever receives the signed
 * JWT this produces, not the key used to sign it.
 *
 * Requires three env vars, from a LiveKit Cloud project (Settings ->
 * API Keys) or a self-hosted server's config:
 *   LIVEKIT_URL          e.g. wss://your-project.livekit.cloud
 *   LIVEKIT_API_KEY
 *   LIVEKIT_API_SECRET
 *
 * The LiveKit room name is always the same as this app's existing
 * Meeting.token (the room code, e.g. "wah-j0u-mq4") — one fewer mapping
 * to keep in sync, and it means a LiveKit Agent (or the `lk` CLI, for
 * debugging) can join a meeting by that same familiar code.
 */
import { AccessToken, type VideoGrant } from "livekit-server-sdk";

export function getLiveKitUrl(): string {
  const url = process.env.LIVEKIT_URL;
  if (!url) throw new Error("LIVEKIT_URL is not configured.");
  return url;
}

export async function mintLiveKitToken(args: {
  roomName: string;
  /** Stable identity for this user within the room — the app's own user
   *  id, so reconnects (refresh, brief network drop) are recognized as
   *  the same participant rather than a new one. */
  identity: string;
  /** Display name shown to other participants — the same name already
   *  used everywhere else in the app (Participants.name equivalent). */
  name: string;
  /** False locks the participant to subscribe-only — used nowhere yet,
   *  but this is where a future "view only" style grant would hook in. */
  canPublish?: boolean;
}): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not configured.");
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: args.identity,
    name: args.name,
    // Generous but not infinite — a fresh token is minted on every join
    // (including a rejoin after a refresh), so this only needs to
    // outlive a single meeting session comfortably, not be permanent.
    ttl: "6h",
  });

  const grant: VideoGrant = {
    roomJoin: true,
    room: args.roomName,
    canPublish: args.canPublish ?? true,
    canSubscribe: true,
    canPublishData: true,
  };
  token.addGrant(grant);

  return token.toJwt();
}
