"use client";

/**
 * Real-time layer for the meeting room. Two genuinely different jobs
 * depending on whether LiveKit is configured (the `establishMediaConnections`
 * argument, effectively `!livekitActive` from the room page):
 *
 * LiveKit configured (the normal case now): this hook's socket connection
 * is skipped entirely — see the early return at the top of the main
 * effect. Every real-time event it would otherwise carry (host-controls,
 * chat, reactions, hand-raise, join-request notifications, layout
 * settings) already has a LiveKit-primary path: REST routes push via
 * src/lib/livekit-emitters.ts (a direct server-to-server call to LiveKit
 * Cloud, e.g. mute/camera-off/remove/end), and client-to-client events
 * (reactions, hand-raise, layout-settings) go through
 * useLiveKitRoom's sendData. handleRealtimeEvent is the single dispatcher
 * either path calls into (lock the mic button, update a peer's tile,
 * leave the meeting, etc.) — this hook's own socket listeners exist only
 * for the mesh-fallback deployment (below), not as a live fallback
 * alongside LiveKit. handRaisedByUserId is tracked as its own map,
 * independent of the peers roster below, specifically so hand-raise
 * doesn't have a hidden dependency on the socket-only peer:joined having
 * created a roster entry first.
 *
 * LiveKit NOT configured (a deployment missing LIVEKIT_* env vars): this
 * hook falls all the way back to a full-mesh set of WebRTC peer
 * connections — one RTCPeerConnection per other participant, each
 * carrying local audio/video tracks and receiving theirs directly, no
 * media server involved. Mesh topology is the simplest approach and is
 * fine at small scale; it doesn't scale gracefully to large meetings
 * since each participant's upload bandwidth grows with the number of
 * others — LiveKit is the actual fix, this is what keeps a
 * misconfigured deployment from having no media transport at all rather
 * than a proper migration path.
 *
 * Mesh signaling handshake, mirroring socket-server/server.ts:
 *   1. On connect, the server tells us who's already in the room
 *      ("room:peers") — we create a PeerConnection for each and send them
 *      an offer, since we're the newcomer.
 *   2. Existing participants get told about us ("peer:joined") and wait for
 *      our offer.
 *   3. Whoever receives an offer creates their own PeerConnection, answers,
 *      and both sides then trade ICE candidates until connected.
 *   4. "peer:media-state" carries live mic/camera toggles (not persisted —
 *      see socket-server/server.ts). "peer:left" tears down that peer's connection.
 *
 * There used to also be a client-side emitHostControl fallback sending
 * host-control events directly over the socket — that existed
 * specifically because the old REST-route mechanism (an internal HTTP
 * call from Vercel to the Render-hosted socket server) could be
 * unreliable when that service was cold-starting. LiveKit's sendData()
 * doesn't share that failure mode, so the fallback's entire
 * justification went away with it; removed rather than carried forward
 * as unnecessary complexity.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { RoomEvent, type Room } from "livekit-client";
import { getToken, authHeaders } from "@/lib/auth-client";

export interface RemotePeer {
  socketId: string;
  userId: number;
  name: string;
  stream: MediaStream | null;
  /** A separate stream for their screen share, distinct from their
   *  camera — kept apart so the UI can render two tiles like Meet does,
   *  instead of the screen share replacing their camera feed. */
  screenStream: MediaStream | null;
  /** The MediaStreamTrack.id of whichever track we've identified as
   *  their camera. Tracked separately from the MediaStream wrapper's own
   *  .id, which is NOT reliably stable across renegotiation — Chrome can
   *  (and did, causing the black-tile bug) re-wrap the same underlying
   *  camera track in a brand-new MediaStream object when a connection
   *  renegotiates for an unrelated reason (e.g. someone starting a
   *  screen share, which renegotiates every peer connection to add that
   *  new track). Comparing stream .id treated that re-wrap as if it were
   *  a second, different stream — mis-filing the camera's own refire as
   *  a "screen share", which corrupted both slots. Track identity is
   *  what's actually stable here. */
  cameraTrackId: string | null;
  /** Same idea as cameraTrackId, but for audio: the track id of this
   *  peer's mic, established the first time we ever see an audio track
   *  from them. Needed once a screen share can carry its own "share tab
   *  audio" track (see startScreenShare) — without this, any second,
   *  genuinely different audio track (the tab's audio) would silently
   *  overwrite `stream` (their camera) instead of joining `screenStream`,
   *  which is what caused a participant's camera tile to show the
   *  presenter's shared screen. */
  cameraAudioTrackId: string | null;
  micOn: boolean;
  cameraOn: boolean;
  handRaised: boolean;
  isHost?: boolean;
  isMuted?: boolean;
  isCameraOff?: boolean;
}

export interface MeetingRoomCallbacks {
  /** The host force-muted *you* specifically (not just any peer). */
  onForceMuted?: () => void;
  /** The host allowed your microphone to be turned back on. */
  onForceUnmuted?: () => void;
  /** The host force-turned-off *your* camera specifically. */
  onForceCameraOff?: () => void;
  /** The host allowed your camera to be turned back on. */
  onForceCameraOn?: () => void;
  /** The host removed *you* from the meeting. */
  onRemoved?: () => void;
  /** The host ended the meeting for everyone. */
  onMeetingEnded?: () => void;
  /** Someone (including yourself, echoed back) sent a quick reaction. */
  onReaction?: (emoji: string, fromName: string) => void;
  /** A chat message arrived (including your own, echoed back — see server.ts). */
  onChatMessage?: (message: { text: string; fromName: string; fromUserId: number; at: number }) => void;
  /** Someone is asking to join — only ever fires for the host, since
   *  that's the only person the server pushes this to. */
  onJoinRequest?: (request: { requestId: number; userId: number; name: string }) => void;
  onPeerJoined?: (peer: { socketId: string; userId: number; name: string; isHost?: boolean; isMuted?: boolean; isCameraOff?: boolean }) => void;
  onPeerLeft?: (peer: { socketId: string; userId: number }) => void;
  /** The host changed the shared "tiles per screen" setting — applies to
   *  everyone, including the host's own other tabs/devices. */
  onLayoutSettings?: (maxVisibleTiles: number) => void;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** Keep the full-mesh topology usable on normal laptops. Each participant
 * uploads one camera stream to every other participant, so an uncapped
 * 720p sender can consume a surprising amount of CPU and upstream bandwidth.
 * These are browser-side hints; WebRTC may choose a lower bitrate when the
 * network is constrained.
 */
function tuneSender(sender: RTCRtpSender, kind: "audio" | "video", screen = false): void {
  try {
    const parameters = sender.getParameters();
    const encoding = parameters.encodings?.[0] ?? {};
    if (kind === "video") {
      encoding.maxBitrate = screen ? 1_500_000 : 850_000;
      encoding.maxFramerate = screen ? 15 : 24;
      parameters.encodings = [encoding];
      parameters.degradationPreference = "balanced";
    } else {
      encoding.maxBitrate = 64_000;
      parameters.encodings = [encoding];
    }
    void sender.setParameters(parameters).catch(() => undefined);
  } catch {
    // Older browsers may not expose sender parameter tuning. The call still
    // works; the browser simply uses its normal WebRTC bitrate controller.
  }
}

export function useMeetingRoom(
  roomToken: string,
  localStream: MediaStream | null,
  myUserId: number | null,
  callbacks: MeetingRoomCallbacks = {},
  enabled: boolean = true,
  establishMediaConnections: boolean = true,
  /**
   * The connected LiveKit Room instance (from useLiveKitRoom), if any.
   * Host-control events (mute/remove/camera-off, single or bulk, plus
   * meeting:ended) are pushed via LiveKit's data channel — see
   * src/lib/livekit-emitters.ts on the sending side — and dispatched
   * through the exact same handleRealtimeEvent function the socket listeners
   * below use, so the reaction logic (lock the mic button, update a
   * peer's tile, etc.) is identical regardless of which transport
   * delivered it. Chat/reactions/hand-raise/join-requests are NOT part of
   * this yet — those still only arrive over the socket.
   */
  livekitRoom: Room | null = null,
) {
  const [peers, setPeers] = useState<Record<string, RemotePeer>>({});
  // Decoupled from `peers` deliberately — hand-raise is the one signal
  // that isn't natively tracked by LiveKit, but keying it off `peers`
  // would make it silently depend on peer:joined having already created
  // an entry there first, which is a socket-only mechanism. This map is
  // keyed directly by userId and updated independently, so hand-raise
  // works correctly even in a future where the socket connection itself
  // goes away entirely.
  const [handRaisedByUserId, setHandRaisedByUserId] = useState<Record<number, boolean>>({});
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const pcsRef = useRef<Record<string, RTCPeerConnection>>({});
  // Tracks whether we're mid-createOffer for a given peer — needed to
  // detect and resolve "glare" (both sides trying to renegotiate at the
  // same time), see the offer handler below.
  const makingOfferRef = useRef<Record<string, boolean>>({});
  // Set synchronously the instant we start handling someone's incoming
  // offer, before any `await` — this closes a race that checking
  // pc.signalingState alone doesn't fully cover: onnegotiationneeded is
  // queued from the addTrack calls made moments earlier and can fire
  // while we're still mid-way through processing their offer (state not
  // yet transitioned), tries to send its own offer, and corrupts the
  // negotiation on our (answering) side specifically — which is what was
  // actually breaking video/screen-share for the receiving participant.
  const processingOfferRef = useRef<Record<string, boolean>>({});
  const pendingIceRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const peerUsersRef = useRef<Record<string, number>>({});
  const localStreamRef = useRef<MediaStream | null>(localStream);
  // Read at socket-event time (the socket effect below only re-runs when
  // roomToken/enabled change), so it needs to be a ref, same as the
  // callbacks. Kept current in an effect rather than during render.
  const establishMediaRef = useRef(establishMediaConnections);
  // Ref so the socket effect (which intentionally only re-runs on
  // roomToken changing) always calls the latest callbacks, not stale ones
  // captured when the socket was first created.
  const callbacksRef = useRef(callbacks);
  // Same reasoning: myUserId is often still null on first render (auth
  // check hasn't resolved yet) by the time this effect first fires, and
  // without a ref that null would be captured forever.
  const myUserIdRef = useRef(myUserId);
  // Updating a ref directly during render (as callbacksRef/myUserIdRef
  // used to do here) is a React rules-of-hooks violation — refs are only
  // safe to write outside of render (effects, event handlers). Merged
  // into the same no-dependency-array effect as establishMediaRef above
  // rather than a separate one, since all three exist for the identical
  // reason (keep a ref current for the socket effect's closures).
  useEffect(() => {
    establishMediaRef.current = establishMediaConnections;
    callbacksRef.current = callbacks;
    myUserIdRef.current = myUserId;
  });

  // Keep the ref current, and attach the local stream's tracks to any peer
  // connections that were created before the camera/mic finished loading.
  useEffect(() => {
    localStreamRef.current = localStream;
    if (!localStream) return;
    Object.values(pcsRef.current).forEach((pc) => {
      const alreadySending = new Set(pc.getSenders().map((s) => s.track));
      localStream.getTracks().forEach((track) => {
        if (!alreadySending.has(track)) {
          const sender = pc.addTrack(track, localStream);
          tuneSender(sender, track.kind === "video" ? "video" : "audio");
        }
      });
    });
  }, [localStream]);

  const removePeer = useCallback((socketId: string) => {
    pcsRef.current[socketId]?.close();
    delete pcsRef.current[socketId];
    delete pendingIceRef.current[socketId];
    delete makingOfferRef.current[socketId];
    delete processingOfferRef.current[socketId];
    delete peerUsersRef.current[socketId];
    setPeers((prev) => {
      if (!(socketId in prev)) return prev;
      const next = { ...prev };
      delete next[socketId];
      return next;
    });
  }, []);

  /**
   * Single source of truth for every host-control event's reaction logic
   * (lock the mic button, update a peer's tile, leave the meeting, etc.),
   * regardless of which transport delivered it. The socket listeners
   * below call this directly with each event's already-parsed payload;
   * the LiveKit data-channel listener (further down) parses its raw
   * `{event, payload}` JSON and calls the exact same function. Keeping
   * this as one function rather than duplicating the logic per-transport
   * is what guarantees the two paths can't silently drift apart.
   */
  const handleRealtimeEvent = useCallback((event: string, payload: unknown) => {
    switch (event) {
      case "participant:force-muted": {
        const { userId: mutedUserId } = payload as { userId: number };
        // Update that person's tile for everyone watching...
        setPeers((prev) => {
          const entry = Object.entries(prev).find(([, p]) => p.userId === mutedUserId);
          if (!entry) return prev;
          const [socketId, peer] = entry;
          return { ...prev, [socketId]: { ...peer, micOn: false } };
        });
        // ...and if it was *me*, tell the room page to actually disable my track.
        if (mutedUserId === myUserIdRef.current) {
          callbacksRef.current.onForceMuted?.();
        }
        break;
      }
      case "participant:force-unmuted": {
        const { userId: targetUserId } = payload as { userId: number };
        // Deliberately does NOT set micOn: true here. Releasing the lock
        // isn't the same as the mic actually being on — the participant
        // still has to click their own mic button (see onForceUnmuted in
        // the room page, which only clears the lock, not the track). If
        // this set micOn: true optimistically, everyone else's view
        // would show them as "on" — rendering their audio/video tile as
        // live — while the actual track stays disabled, which is
        // exactly what produced the black camera tile bug. The real
        // on/off state only ever comes from their own peer:media-state
        // broadcast (or, under LiveKit, the actual track state), once
        // they actually toggle it themselves.
        if (targetUserId === myUserIdRef.current) callbacksRef.current.onForceUnmuted?.();
        break;
      }
      case "participant:force-camera-off": {
        const { userId: targetUserId } = payload as { userId: number };
        setPeers((prev) => {
          const entry = Object.entries(prev).find(([, p]) => p.userId === targetUserId);
          if (!entry) return prev;
          const [socketId, peer] = entry;
          return { ...prev, [socketId]: { ...peer, cameraOn: false } };
        });
        if (targetUserId === myUserIdRef.current) {
          callbacksRef.current.onForceCameraOff?.();
        }
        break;
      }
      case "participant:force-camera-on": {
        const { userId: targetUserId } = payload as { userId: number };
        // Deliberately does NOT set cameraOn: true here — see the
        // comment on participant:force-unmuted above, same reasoning
        // exactly. This was the actual bug: setting cameraOn: true
        // optimistically here made every viewer's tile for this person
        // render the <video> element (cameraOn && stream both true)
        // while their real track was still disabled — producing a black
        // tile instead of the avatar, right after the host released a
        // lock and before the participant had actually turned their
        // camera back on.
        if (targetUserId === myUserIdRef.current) callbacksRef.current.onForceCameraOn?.();
        break;
      }
      case "meeting:mute-all": {
        const { userIds } = payload as { userIds: number[] };
        const targetSet = new Set(userIds);
        setPeers((prev) => {
          const next = { ...prev };
          for (const [socketId, peer] of Object.entries(prev)) {
            if (targetSet.has(peer.userId)) next[socketId] = { ...peer, micOn: false };
          }
          return next;
        });
        if (myUserIdRef.current !== null && targetSet.has(myUserIdRef.current)) {
          callbacksRef.current.onForceMuted?.();
        }
        break;
      }
      case "meeting:unmute-all": {
        // See the comment on participant:force-unmuted above — this is
        // the bulk version of the exact same fix. isMuted (DB-facing
        // display state, e.g. for the People panel) is fine to update
        // here since that's just "did the host release the lock", not
        // "is their mic actually on" — but cameraOn/micOn (which gate
        // whether a tile renders live video) must not be touched until
        // they actually toggle it themselves.
        const { userIds } = payload as { userIds: number[] };
        const targetSet = new Set(userIds);
        setPeers((prev) => {
          const next = { ...prev };
          for (const [socketId, peer] of Object.entries(prev)) {
            if (targetSet.has(peer.userId)) next[socketId] = { ...peer, isMuted: false };
          }
          return next;
        });
        if (myUserIdRef.current !== null && targetSet.has(myUserIdRef.current)) callbacksRef.current.onForceUnmuted?.();
        break;
      }
      case "meeting:camera-off-all": {
        const { userIds } = payload as { userIds: number[] };
        const targetSet = new Set(userIds);
        setPeers((prev) => {
          const next = { ...prev };
          for (const [socketId, peer] of Object.entries(prev)) {
            if (targetSet.has(peer.userId)) next[socketId] = { ...peer, cameraOn: false };
          }
          return next;
        });
        if (myUserIdRef.current !== null && targetSet.has(myUserIdRef.current)) {
          callbacksRef.current.onForceCameraOff?.();
        }
        break;
      }
      case "meeting:camera-on-all": {
        // See the comment on participant:force-camera-on and
        // meeting:unmute-all above — same fix, same reasoning.
        const { userIds } = payload as { userIds: number[] };
        const targetSet = new Set(userIds);
        setPeers((prev) => {
          const next = { ...prev };
          for (const [socketId, peer] of Object.entries(prev)) {
            if (targetSet.has(peer.userId)) next[socketId] = { ...peer, isCameraOff: false };
          }
          return next;
        });
        if (myUserIdRef.current !== null && targetSet.has(myUserIdRef.current)) callbacksRef.current.onForceCameraOn?.();
        break;
      }
      case "meeting:removed": {
        callbacksRef.current.onRemoved?.();
        break;
      }
      case "meeting:ended": {
        callbacksRef.current.onMeetingEnded?.();
        break;
      }
      case "peer:hand-raised": {
        // Always userId-keyed regardless of transport — see the socket
        // listener below, which translates its raw socketId-keyed
        // payload before calling this, so this one lookup works the
        // same for both paths and doesn't need to know which one it was.
        const { userId: targetUserId, raised } = payload as { userId: number; raised: boolean };
        setHandRaisedByUserId((prev) => (prev[targetUserId] === raised ? prev : { ...prev, [targetUserId]: raised }));
        // Also kept in sync on socketPeers, for the mesh-fallback path,
        // which still reads handRaised from there.
        setPeers((prev) => {
          const entry = Object.entries(prev).find(([, p]) => p.userId === targetUserId);
          if (!entry) return prev;
          const [socketId, peer] = entry;
          return { ...prev, [socketId]: { ...peer, handRaised: raised } };
        });
        break;
      }
      case "peer:reaction": {
        const { emoji, name } = payload as { emoji: string; name: string };
        callbacksRef.current.onReaction?.(emoji, name);
        break;
      }
      case "peer:chat-message": {
        const { text, name, userId: fromUserId, at } = payload as { text: string; name: string; userId: number; at: number };
        callbacksRef.current.onChatMessage?.({ text, fromName: name, fromUserId, at });
        break;
      }
      case "join-request:new": {
        callbacksRef.current.onJoinRequest?.(payload as { requestId: number; userId: number; name: string });
        break;
      }
      case "meeting:layout-settings": {
        const { maxVisibleTiles } = payload as { maxVisibleTiles: number };
        callbacksRef.current.onLayoutSettings?.(maxVisibleTiles);
        break;
      }
    }
  }, []);

  const flushPendingIce = useCallback(async (socketId: string, pc: RTCPeerConnection) => {
    const queued = pendingIceRef.current[socketId];
    if (!queued?.length || !pc.remoteDescription) return;
    delete pendingIceRef.current[socketId];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore candidates that became invalid after a renegotiation.
      }
    }
  }, []);

  /**
   * Adds a peer to the roster without opening a WebRTC connection — the
   * same entry createPeerConnection registers, minus the RTCPeerConnection.
   * Used when media is carried by LiveKit instead of the mesh.
   */
  const registerPeer = useCallback(
    (socketId: string, userId: number, name: string, meta: { isHost?: boolean; isMuted?: boolean; isCameraOff?: boolean } = {}) => {
      peerUsersRef.current[socketId] = userId;
      setPeers((prev) => ({
        ...prev,
        [socketId]: prev[socketId] ?? { socketId, userId, name, stream: null, screenStream: null, cameraTrackId: null, cameraAudioTrackId: null, micOn: true, cameraOn: true, handRaised: false, isHost: Boolean(meta.isHost), isMuted: Boolean(meta.isMuted), isCameraOff: Boolean(meta.isCameraOff) },
      }));
    },
    [],
  );

  const createPeerConnection = useCallback(
    (socketId: string, userId: number, name: string, meta: { isHost?: boolean; isMuted?: boolean; isCameraOff?: boolean } = {}): RTCPeerConnection => {
      const existing = pcsRef.current[socketId];
      if (existing) return existing;

      const pc = new RTCPeerConnection(ICE_SERVERS);

      localStreamRef.current?.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStreamRef.current!);
        tuneSender(sender, track.kind === "video" ? "video" : "audio");
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit("webrtc:ice-candidate", { to: socketId, candidate: event.candidate });
        }
      };

      /**
       * This is the piece that was missing entirely before: without it,
       * RTCRtpSender.replaceTrack() works fine (no renegotiation needed),
       * but pc.addTrack() — used whenever a connection didn't already have
       * a video sender (camera was off when the connection formed, then
       * turned on later; or screen share falling back to addTrack) —
       * silently never reaches the other side. The track gets added
       * locally, getSenders() shows it, but the remote peer's SDP was
       * never updated, so their ontrack never fires for it. That's what
       * was causing "screen share only visible to me" and the host's
       * video not showing up for other participants in some sequences.
       */
      pc.onnegotiationneeded = async () => {
        // Critical guard: if we're not in a stable state, a negotiation
        // is already in progress via a different path — most commonly,
        // we're in the middle of processing someone else's incoming
        // offer (setRemoteDescription moves the connection to
        // "have-remote-offer", not "stable"). Without this check,
        // onnegotiationneeded (queued from the addTrack calls above,
        // which fires as a microtask shortly after) can try to create
        // ITS OWN offer while we're simultaneously trying to answer
        // theirs — an invalid state transition that silently corrupts
        // the connection. This was the actual reason a participant could
        // connect but never receive the host's video/screen share: the
        // negotiation got stuck on their (answering) side specifically.
        if (pc.signalingState !== "stable" || processingOfferRef.current[socketId]) return;
        try {
          makingOfferRef.current[socketId] = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socketRef.current?.emit("webrtc:offer", { to: socketId, sdp: offer });
        } catch {
          // Benign — can race with an incoming offer; the glare handling
          // in the webrtc:offer listener below resolves that case.
        } finally {
          makingOfferRef.current[socketId] = false;
        }
      };

      pc.ontrack = (event) => {
        const incomingStream = event.streams[0] ?? null;
        const incomingTrackId = event.track.id;
        const isVideo = event.track.kind === "video";
        setPeers((prev) => {
          const existing =
            prev[socketId] ??
            ({
              socketId,
              userId,
              name,
              stream: null,
              screenStream: null,
              cameraTrackId: null,
              cameraAudioTrackId: null,
              micOn: true,
              cameraOn: true,
              handRaised: false,
            } satisfies RemotePeer);

          // Same identity-based classification as the video branch below,
          // now applied to audio too: a screen share can carry its own
          // "share tab audio" track (see startScreenShare), so a second,
          // genuinely different audio track id is that tab audio, not a
          // second microphone — route it to screenStream instead of
          // overwriting the camera's audio in `stream`.
          if (!isVideo) {
            if (!existing.cameraAudioTrackId || incomingTrackId === existing.cameraAudioTrackId) {
              return { ...prev, [socketId]: { ...existing, stream: incomingStream, cameraAudioTrackId: incomingTrackId } };
            }
            return { ...prev, [socketId]: { ...existing, screenStream: incomingStream } };
          }

          // The first VIDEO track we ever see for a peer is their camera
          // (added when the connection was first created) — remember its
          // track id specifically, not the MediaStream wrapper's id. Any
          // later ontrack firing for that SAME track id just means the
          // browser re-wrapped it in a new MediaStream object during
          // renegotiation (which starting/stopping a screen share
          // triggers for every peer connection) — update `stream` to the
          // fresh wrapper, but it's still the camera, not a new share.
          // Only a genuinely different video track id is the screen share.
          if (!existing.cameraTrackId || incomingTrackId === existing.cameraTrackId) {
            return { ...prev, [socketId]: { ...existing, stream: incomingStream, cameraTrackId: incomingTrackId } };
          }
          return { ...prev, [socketId]: { ...existing, screenStream: incomingStream } };
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          removePeer(socketId);
        }
      };

      pcsRef.current[socketId] = pc;
      peerUsersRef.current[socketId] = userId;
      setPeers((prev) => ({
        ...prev,
        [socketId]: prev[socketId] ?? { socketId, userId, name, stream: null, screenStream: null, cameraTrackId: null, cameraAudioTrackId: null, micOn: true, cameraOn: true, handRaised: false, isHost: Boolean(meta.isHost), isMuted: Boolean(meta.isMuted), isCameraOff: Boolean(meta.isCameraOff) },
      }));
      return pc;
    },
    [removePeer],
  );

  useEffect(() => {
    const token = getToken();
    if (!enabled || !token || !roomToken) return;
    if (!establishMediaConnections) {
      // LiveKit is active — every real-time event this socket would
      // carry (host-controls, chat, reactions, hand-raise, join-request
      // notifications, layout-settings) already has a LiveKit-primary
      // path (see handleRealtimeEvent and the DataReceived listener
      // below), and the mesh itself is what establishMediaConnections
      // already gates off. The only things this socket would otherwise
      // still be doing are the roster's peer:joined/peer:left "instant"
      // notification (refreshRoster's own 5s poll already covers the
      // same ground, just slightly slower) and acting as a fallback
      // transport for everything above. Skipping the connection
      // entirely — not just leaving it idle — is what actually removes
      // the dependency on that separate service being up at all.
      return;
    }

    // Set true the moment cleanup starts (see the return below) — guards
    // the handlers below from logging a connection failure that was
    // already in flight when we left the page. socket.disconnect()
    // stops future reconnection attempts, but an attempt that had
    // already been dispatched can still have its error callback fire a
    // moment after unmount begins, which was producing a "connection
    // failed" console.error after the person had already navigated away
    // from the meeting entirely — harmless, but noisy (and in dev,
    // Next.js turns any console.error into a blocking overlay).
    let cancelled = false;

    // Connects directly to the standalone socket server (see
    // ../../../socket-server — a separate project/deployment, not this
    // Next.js app), since Socket.IO needs a persistent process this app's
    // environment doesn't provide. Falls back to same-origin only if the
    // env var isn't set, which only works in a local dev setup where both
    // happen to run on the same host.
    const configuredUrl = process.env.NEXT_PUBLIC_SOCKET_URL?.trim();
    const socketUrl = configuredUrl || undefined;
    const socket = io(socketUrl, {
      path: "/api/socket",
      auth: { token, roomToken },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      // 20s, not the original 10s — a free-tier backend host waking from
      // sleep (cold start) can easily take longer than 10s to respond,
      // and a real timeout error here (vs. just waiting a bit longer)
      // was firing more often than the connection was actually failing.
      timeout: 20000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      // A reconnect gets a new socket id. Close old peer connections so a
      // stale socket cannot keep the roster/WebRTC state split between two
      // generations of the same participant. The server immediately sends
      // a fresh room:peers snapshot for the new socket.
      Object.values(pcsRef.current).forEach((pc) => pc.close());
      pcsRef.current = {};
      pendingIceRef.current = {};
      makingOfferRef.current = {};
      processingOfferRef.current = {};
      peerUsersRef.current = {};
      setPeers({});
      setConnected(true);
      console.info("[Veyra] Socket connected", socket.id, "via", socket.io.engine.transport.name);
    });
    socket.on("connect_error", (error) => {
      if (cancelled) return;
      setConnected(false);
      const socketError = error as Error & { description?: string };
      console.error("[Veyra] Socket connection failed", {
        url: socketUrl ?? window.location.origin,
        message: socketError.message,
        description: socketError.description,
      });
    });
    socket.on("disconnect", (reason) => {
      setConnected(false);
      console.warn("[Veyra] Socket disconnected", reason);
    });

    socket.on(
      "room:peers",
      (existingPeers: { socketId: string; userId: number; name: string; isHost?: boolean; isMuted?: boolean; isCameraOff?: boolean }[]) => {
        // Just create the connections — adding the local tracks inside
        // createPeerConnection triggers onnegotiationneeded automatically,
        // which sends the actual offer. Calling createOffer() explicitly
        // here too would race with that and send a duplicate/conflicting
        // offer (glare) on the very first connection attempt.
        for (const peer of existingPeers) {
          if (establishMediaRef.current) {
            createPeerConnection(peer.socketId, peer.userId, peer.name, peer);
          } else {
            // Media goes over LiveKit — just put them on the roster.
            registerPeer(peer.socketId, peer.userId, peer.name, peer);
          }
        }
      },
    );

    socket.on("peer:joined", ({ socketId, userId, name, isHost, isMuted, isCameraOff }: { socketId: string; userId: number; name: string; isHost?: boolean; isMuted?: boolean; isCameraOff?: boolean }) => {
      // Just register their presence now; they'll receive our offer once
      // *they* get this room's peer list — no, wait: we are already here,
      // so per the handshake it's the newcomer who initiates. We simply
      // wait for their "webrtc:offer" and answer it below.
      peerUsersRef.current[socketId] = userId;
      setPeers((prev) => ({
        ...prev,
        [socketId]: prev[socketId] ?? { socketId, userId, name, stream: null, screenStream: null, cameraTrackId: null, cameraAudioTrackId: null, micOn: true, cameraOn: true, handRaised: false, isHost: Boolean(isHost), isMuted: Boolean(isMuted), isCameraOff: Boolean(isCameraOff) },
      }));
      callbacksRef.current.onPeerJoined?.({ socketId, userId, name, isHost, isMuted, isCameraOff });
    });

    socket.on(
      "webrtc:offer",
      async ({
        from,
        fromUserId,
        name,
        sdp,
      }: {
        from: string;
        fromUserId: number;
        name: string;
        sdp: RTCSessionDescriptionInit;
      }) => {
        // With LiveKit carrying media there is no mesh to answer into. A
        // stray offer (e.g. from a tab still running an older build) is
        // ignored rather than half-building a connection nobody uses.
        if (!establishMediaRef.current) return;
        const pc = createPeerConnection(from, fromUserId, name);
        // Set synchronously, before any await below — see the ref's own
        // comment for why the timing here matters.
        processingOfferRef.current[from] = true;

        try {
          // Glare: both sides can now initiate a renegotiation (see
          // onnegotiationneeded above), so it's possible we're already
          // mid-createOffer to this same peer when their offer arrives.
          // Standard resolution: designate whichever side has the lower
          // userId as "polite" — the polite side rolls back its own
          // in-flight offer and accepts theirs; the impolite side ignores
          // the incoming offer and lets its own proceed. Both peers
          // compute this the same way independently, so they always
          // agree on who backs off.
          const offerCollision =
            makingOfferRef.current[from] === true || pc.signalingState !== "stable";
          const polite = (myUserIdRef.current ?? 0) < fromUserId;
          const ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) return;

          if (offerCollision) {
            await Promise.all([
              pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit),
              pc.setRemoteDescription(new RTCSessionDescription(sdp)),
            ]);
          } else {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          }
          await flushPendingIce(from, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("webrtc:answer", { to: from, sdp: answer });
        } finally {
          processingOfferRef.current[from] = false;
        }
      },
    );

    socket.on("webrtc:answer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = pcsRef.current[from];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await flushPendingIce(from, pc);
      }
    });

    socket.on(
      "webrtc:ice-candidate",
      async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
        const pc = pcsRef.current[from];
        if (!pc || !pc.remoteDescription) {
          (pendingIceRef.current[from] ??= []).push(candidate);
          return;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch {
          // A candidate can become stale across a fast renegotiation.
        }
      },
    );

    socket.on(
      "peer:media-state",
      ({ socketId, micOn, cameraOn }: { socketId: string; micOn: boolean; cameraOn: boolean }) => {
        setPeers((prev) => (prev[socketId] ? { ...prev, [socketId]: { ...prev[socketId], micOn, cameraOn } } : prev));
      },
    );

    socket.on(
      "peer:hand-raised",
      ({ socketId, raised }: { socketId: string; raised: boolean }) => {
        const raisedUserId = peerUsersRef.current[socketId];
        if (raisedUserId === undefined) return;
        handleRealtimeEvent("peer:hand-raised", { userId: raisedUserId, raised });
      },
    );

    // Explicit signal for screen-share starting/stopping — the actual
    // video shows up via the normal WebRTC track/ontrack flow above, but
    // relying on track-removal events alone to know when a share has
    // *stopped* is unreliable across browsers and can leave a frozen
    // last-frame tile behind. This gives an immediate, clean signal to
    // remove that tile the instant sharing actually stops.
    socket.on(
      "peer:screen-share-state",
      ({ socketId, sharing }: { socketId: string; sharing: boolean }) => {
        setPeers((prev) =>
          prev[socketId]
            ? { ...prev, [socketId]: { ...prev[socketId], screenStream: sharing ? prev[socketId].screenStream : null } }
            : prev,
        );
      },
    );

    socket.on("peer:reaction", (payload: { emoji: string; name: string }) => handleRealtimeEvent("peer:reaction", payload));

    socket.on("meeting:layout-settings", (payload: { maxVisibleTiles: number }) => handleRealtimeEvent("meeting:layout-settings", payload));

    socket.on(
      "peer:chat-message",
      (payload: { text: string; name: string; userId: number; at: number }) => handleRealtimeEvent("peer:chat-message", payload),
    );

    socket.on("peer:left", ({ socketId, userId: leftUserId }: { socketId: string; userId: number }) => {
      removePeer(socketId);
      const anotherSocket = Object.entries(peerUsersRef.current).some(
        ([id, uid]) => id !== socketId && uid === leftUserId,
      );
      if (!anotherSocket) callbacksRef.current.onPeerLeft?.({ socketId, userId: leftUserId });
    });

    // Thin delegations to handleRealtimeEvent (defined above) — the actual
    // reaction logic lives there once, shared with the LiveKit
    // data-channel listener further down.
    socket.on("participant:force-muted", (payload: { userId: number }) => handleRealtimeEvent("participant:force-muted", payload));
    socket.on("participant:force-unmuted", (payload: { userId: number }) => handleRealtimeEvent("participant:force-unmuted", payload));
    socket.on("participant:force-camera-off", (payload: { userId: number }) => handleRealtimeEvent("participant:force-camera-off", payload));
    socket.on("participant:force-camera-on", (payload: { userId: number }) => handleRealtimeEvent("participant:force-camera-on", payload));
    socket.on("meeting:mute-all", (payload: { userIds: number[] }) => handleRealtimeEvent("meeting:mute-all", payload));
    socket.on("meeting:unmute-all", (payload: { userIds: number[] }) => handleRealtimeEvent("meeting:unmute-all", payload));
    socket.on("meeting:camera-off-all", (payload: { userIds: number[] }) => handleRealtimeEvent("meeting:camera-off-all", payload));
    socket.on("meeting:camera-on-all", (payload: { userIds: number[] }) => handleRealtimeEvent("meeting:camera-on-all", payload));

    socket.on("join-request:new", (payload: { requestId: number; userId: number; name: string }) => handleRealtimeEvent("join-request:new", payload));

    socket.on("meeting:removed", () => handleRealtimeEvent("meeting:removed", undefined));
    socket.on("meeting:ended", () => handleRealtimeEvent("meeting:ended", undefined));

    return () => {
      cancelled = true;
      Object.keys(pcsRef.current).forEach(removePeer);
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomToken, enabled, establishMediaConnections]);

  // Host-control events also arrive via LiveKit's data channel (see
  // src/lib/livekit-emitters.ts on the sending side) once a LiveKit room
  // is connected, dispatched through the exact same handleRealtimeEvent
  // function the socket listeners above use. A separate effect from the
  // socket connection above — this room's lifecycle is entirely owned by
  // useLiveKitRoom and can become available (or go away, on disconnect)
  // at a different time than the socket connects.
  useEffect(() => {
    if (!livekitRoom) return;
    const handleDataReceived = (payload: Uint8Array, participant?: { identity: string }) => {
      // Server-sent messages (host-control events, chat) have no
      // participant — always processed. Client-to-client messages
      // (reactions, hand-raise) do have one; if it's ourselves, skip —
      // the sender already updated its own UI directly when it sent
      // (see the room page), specifically so this never depends on
      // whether LiveKit's publishData happens to loop a message back to
      // its own sender or not. Either behavior is handled correctly:
      // if it does loop back, this skip avoids a double update; if it
      // doesn't, there was nothing to skip anyway.
      if (participant && participant.identity === livekitRoom.localParticipant.identity) {
        return;
      }
      try {
        const decoded = new TextDecoder().decode(payload);
        const parsed = JSON.parse(decoded) as { event: string; payload?: unknown };
        handleRealtimeEvent(parsed.event, parsed.payload);
      } catch (err) {
        console.error("[Veyra] Failed to parse LiveKit data message", err);
      }
    };
    livekitRoom.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      livekitRoom.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [livekitRoom, handleRealtimeEvent]);

  const broadcastMediaState = useCallback((micOn: boolean, cameraOn: boolean) => {
    socketRef.current?.emit("peer:media-state", { micOn, cameraOn });
  }, []);

  const broadcastHandRaise = useCallback((raised: boolean) => {
    socketRef.current?.emit("peer:hand-raised", { raised });
  }, []);

  /** Fire-and-forget emoji reaction, broadcast to everyone else in the
   *  room — purely ephemeral, not persisted anywhere. */
  const sendReaction = useCallback((emoji: string) => {
    socketRef.current?.emit("peer:reaction", { emoji });
  }, []);

  /**
   * Swaps the outgoing video track on every current peer connection —
   * what screen sharing is built on. Rather than opening a second video
   * stream alongside the camera, sharing *replaces* the one outgoing video
   * track everyone already receives, via RTCRtpSender.replaceTrack. That
   * keeps the "one video feed per participant" model this app already has
   * (VideoTile only ever renders one stream per tile); the trade-off is
   * you can't show your camera and your screen at the same time — sharing
   * takes over the video slot until you stop.
   *
   * Falls back to addTrack for a peer connection that has no video sender
   * yet (e.g. camera permission was denied so no video track was ever
   * attached) — otherwise replaceTrack on a connection with no video
   * sender at all would silently do nothing.
   */
  /**
   * Persists and broadcasts a chat message via
   * POST /api/rooms/[token]/chat (see that route — it does both halves:
   * the DB write, and the real-time push via LiveKit's data channel).
   * Fire-and-forget from the caller's perspective, matching this hook's
   * other send functions — a failure is logged here rather than
   * surfaced as a UI error, consistent with how those already behave.
   */
  const sendChatMessage = useCallback(async (text: string) => {
    try {
      const res = await fetch(`/api/rooms/${roomToken}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("Failed to send chat message:", data.error ?? res.status);
      }
    } catch (err) {
      console.error("Failed to send chat message:", err);
    }
  }, [roomToken]);

  /**
   * Adds the screen-share track as a NEW, separate sender on every peer
   * connection — the camera's sender is untouched. This is what makes
   * the screen show up as its own tile on the receiving end (matching
   * Meet) instead of replacing the camera feed. Triggers
   * onnegotiationneeded automatically (see createPeerConnection above),
   * which is what actually gets it to the other side.
   */
  const addScreenShareTrack = useCallback((track: MediaStreamTrack, stream: MediaStream) => {
    Object.values(pcsRef.current).forEach((pc) => {
      const sender = pc.addTrack(track, stream);
      tuneSender(sender, track.kind === "audio" ? "audio" : "video", true);
    });
  }, []);

  /**
   * Removes the screen-share sender from every peer connection (found by
   * matching the track itself, since it's a distinct sender from the
   * camera one). Also triggers renegotiation.
   */
  const removeScreenShareTrack = useCallback((track: MediaStreamTrack) => {
    Object.values(pcsRef.current).forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) {
        pc.removeTrack(sender);
      }
    });
  }, []);

  const broadcastScreenShareState = useCallback((sharing: boolean) => {
    socketRef.current?.emit("peer:screen-share-state", { sharing });
  }, []);

  /**
   * Swaps the outgoing camera video track on every current peer
   * connection via RTCRtpSender.replaceTrack — no renegotiation, no
   * ontrack firing again on the receiving end, just different content
   * flowing through the same already-established video subscription.
   * This is what the virtual background feature (blur/templates) is
   * built on: the processed canvas track replaces the raw camera track
   * as the sender's content, matched by finding whichever sender's
   * *current* track is the one being replaced (not just "the video
   * sender," since a screen share can add a second video sender —
   * matching by track reference is what keeps this from accidentally
   * touching that one).
   */
  const replaceLocalVideoTrack = useCallback((oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack) => {
    Object.values(pcsRef.current).forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track === oldTrack);
      if (sender) void sender.replaceTrack(newTrack);
    });
  }, []);

  /** Host-only in practice (the server drops it from anyone else) —
   *  pushes the chosen "tiles per screen" setting to everyone in the
   *  room, including the host's own other tabs/devices. */
  const broadcastLayoutSettings = useCallback((maxVisibleTiles: number) => {
    socketRef.current?.emit("host:layout-settings", { maxVisibleTiles });
  }, []);

  return {
    peers: Object.values(peers),
    handRaisedByUserId,
    connected,
    broadcastMediaState,
    addScreenShareTrack,
    removeScreenShareTrack,
    broadcastScreenShareState,
    broadcastHandRaise,
    sendReaction,
    sendChatMessage,
    broadcastLayoutSettings,
    replaceLocalVideoTrack,
  };
}
