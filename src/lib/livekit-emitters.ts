/**
 * Drop-in replacement for socket-emitters.ts's emitToMeeting/emitToUser —
 * same function signatures and same event/payload shapes, so every route
 * that used to import from "@/lib/socket-emitters" only needs its import
 * changed, not its logic. What changes is the transport underneath: this
 * pushes messages via LiveKit's RoomServiceClient.sendData() instead of
 * an internal HTTP call to the separate Socket.IO backend, so a host
 * action no longer depends on that service being up (or awake — see the
 * Render cold-start notes elsewhere in this codebase).
 *
 * The receiving side is symmetric: useMeetingRoom listens for
 * RoomEvent.DataReceived on the LiveKit room (alongside its existing
 * socket listeners, for now) and dispatches to the exact same callback
 * functions it already had for the socket versions of these events — see
 * that file's handleHostEvent.
 *
 * Payload wire format: every message is JSON `{ event: string, payload?:
 * unknown }`, UTF-8 encoded. This wrapper (rather than relying on
 * LiveKit's own `topic` field for the event name) keeps the payload
 * shape identical to what useMeetingRoom's socket handlers already parse
 * — `topic` was considered, but the two data points (event name +
 * payload) belong together as one parsed unit either way, and this
 * avoids a second, parallel place event names have to match.
 *
 * Requires the same LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
 * env vars as src/lib/livekit.ts (token minting) — this is the same
 * LiveKit project, just a different part of its server SDK.
 */
import { RoomServiceClient, DataPacket_Kind } from "livekit-server-sdk";

let client: RoomServiceClient | null = null;

function getClient(): RoomServiceClient {
  if (client) return client;
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new Error("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set.");
  }
  // RoomServiceClient takes an https:// host, not the wss:// URL used for
  // client connections/token grants — same project, different protocol
  // for server-to-server REST calls vs. a browser's realtime connection.
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  client = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  return client;
}

function encode(event: string, payload?: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ event, payload }));
}

/**
 * Pushes an event to every participant currently in a meeting's LiveKit
 * room. Best-effort, like its socket-emitters predecessor: the caller's
 * database mutation has already succeeded by the time this runs, so a
 * delivery failure here just means a missed real-time push, not a lost
 * state change — the affected client picks it up on its next poll/reload.
 */
export async function emitToMeeting(roomToken: string, event: string, payload?: unknown): Promise<boolean> {
  try {
    await getClient().sendData(roomToken, encode(event, payload), DataPacket_Kind.RELIABLE, {});
    return true;
  } catch (err) {
    console.error(`livekit-emitters: emitToMeeting(${event}) failed`, err);
    return false;
  }
}

/**
 * Pushes an event to one participant's LiveKit connection specifically —
 * identity is always String(userId), matching how src/lib/livekit.ts
 * mints tokens. `disconnect` additionally removes them from the LiveKit
 * room server-side (belt-and-suspenders alongside the data message: the
 * client's own reaction to the message already leaves gracefully, this
 * just guarantees it even if that handler somehow doesn't run).
 */
export async function emitToUser(
  roomToken: string,
  userId: number,
  event: string,
  payload?: unknown,
  disconnect?: boolean,
): Promise<boolean> {
  const identity = String(userId);
  try {
    await getClient().sendData(roomToken, encode(event, payload), DataPacket_Kind.RELIABLE, {
      destinationIdentities: [identity],
    });
  } catch (err) {
    console.error(`livekit-emitters: emitToUser(${event}) failed`, err);
    return false;
  }
  if (disconnect) {
    try {
      await getClient().removeParticipant(roomToken, identity);
    } catch (err) {
      // Not fatal — they were already sent the data message above and
      // their own client-side handler (onRemoved) leaves the room
      // itself. This is only the belt-and-suspenders half failing, e.g.
      // if they'd already disconnected on their own by this point.
      console.error(`livekit-emitters: removeParticipant failed for ${identity}`, err);
    }
  }
  return true;
}
