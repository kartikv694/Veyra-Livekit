/**
 * Bridge from REST route handlers to the standalone Socket.IO signaling
 * server (see ../../../socket-server — a sibling project, NOT part of this
 * Next.js app). This is how a host's mute/remove/end-meeting REST call
 * reaches the affected participant's browser immediately.
 *
 * This used to reach an in-process `io` instance directly, back when
 * server.ts wrapped both Next and Socket.IO in one Node process. That
 * process split (see socket-server/README.md for why), so route handlers
 * now push events over a small internal HTTP API instead — same effect,
 * different transport.
 *
 * Requires two env vars on this app:
 *   SOCKET_SERVER_URL             — base URL of the socket server, e.g.
 *                                    http://localhost:4000 in dev.
 *   SOCKET_SERVER_INTERNAL_SECRET — must match INTERNAL_EMIT_SECRET in the
 *                                    socket server's own .env.
 */

function getConfig(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.SOCKET_SERVER_URL;
  const secret = process.env.SOCKET_SERVER_INTERNAL_SECRET;
  if (!baseUrl || !secret) {
    throw new Error(
      "SOCKET_SERVER_URL and SOCKET_SERVER_INTERNAL_SECRET must be set — see socket-server/README.md.",
    );
  }
  return { baseUrl, secret };
}

async function postInternal(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    // Deliberately inside the try block, not before it — getConfig()
    // throws if the env vars aren't set, and since every call site
    // fires this off without awaiting it (on purpose — a real-time push
    // is best-effort, the DB mutation it follows has already succeeded
    // and shouldn't wait on this), an unhandled throw here becomes an
    // unhandled promise rejection. In a serverless environment (Vercel),
    // that can crash the function outright — which is what was actually
    // producing 503s specifically on every route that calls this, not a
    // slow backend.
    const { baseUrl, secret } = getConfig();
    // 5s timeout — this is a best-effort real-time push, not something
    // worth waiting a long time for. Without this, a slow or
    // cold-starting backend could leave this fetch hanging far longer
    // than necessary before Node/Vercel eventually gives up on it.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) {
      console.error(`socket-emitters: ${path} responded ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Best-effort: a REST mutation (mute/remove/end) has already succeeded
    // in the database by the time this runs. If the socket server is
    // unreachable, the affected client just won't get the instant push —
    // it'll pick the change up on its next poll instead of losing it.
    console.error("socket-emitters: failed to reach socket server", err);
    return false;
  }
}

/** Pushes an event to every socket in a meeting. */
export function emitToMeeting(roomToken: string, event: string, payload?: unknown): Promise<boolean> {
  return postInternal("/internal/emit-room", { roomToken, event, payload });
}

/**
 * Pushes an event to one user's socket(s) within a meeting, optionally
 * disconnecting them right after (used when removing a participant).
 */
export function emitToUser(
  roomToken: string,
  userId: number,
  event: string,
  payload?: unknown,
  disconnect?: boolean,
): Promise<boolean> {
  return postInternal("/internal/emit-user", { roomToken, userId, event, payload, disconnect });
}
