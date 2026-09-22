"use client";

/**
 * The LiveKit-backed replacement for useMeetingRoom's media-transport
 * responsibilities (the RTCPeerConnection mesh, ICE/SDP signaling, track
 * classification). Everything else useMeetingRoom does — chat, reactions,
 * hand-raise, host-control signaling, the participant roster — stays on
 * the existing Socket.IO backend; this hook only owns audio/video/screen
 * share transport.
 *
 * LOCAL MEDIA IS NOT CAPTURED HERE. The room page already acquires the
 * camera/mic itself (getUserMedia in the lobby, so the preview works while
 * waiting to be admitted), applies the remembered mic/camera preference,
 * runs the virtual-background processor on it, and handles host
 * force-mute by disabling those tracks. This hook publishes those exact
 * tracks into the LiveKit room once connected, rather than letting
 * LiveKit open the camera a second time. One capture, no hand-off, so:
 *   - the waiting-room preview keeps working unchanged;
 *   - there's never a moment where two getUserMedia() calls fight over
 *     one webcam (a real NotReadableError source, see the room page);
 *   - background effects keep working through replaceCameraTrack.
 *
 * Design notes:
 *   - Each remote participant has two MediaStreams (camera+mic, and
 *     screen-share+its audio). A stream is REPLACED with a new
 *     MediaStream whenever its track set changes, never mutated. Browsers
 *     do not fire `addtrack`/`removetrack` when script calls
 *     MediaStream.addTrack()/removeTrack() (those events are for
 *     browser-initiated changes only), so a consumer holding one
 *     long-lived stream would never learn a track arrived. A new
 *     reference makes React re-render and VideoTile re-attach.
 *   - LiveKit tags every track with a Track.Source natively, which is
 *     what replaces the old cameraTrackId/cameraAudioTrackId heuristic.
 *     For tracks we publish ourselves we set `source` explicitly.
 *   - adaptiveStream is OFF. It decides which simulcast layer to receive
 *     (or whether to pause a track) from the size of elements attached
 *     through track.attach(); we hand raw MediaStreamTracks to our own
 *     <video> elements, so it would see zero attached elements and pause
 *     everyone's video.
 *   - Every mutation of the local publications goes through one promise
 *     queue, so publish / replace / mute can't interleave (React
 *     StrictMode's double effects, quick toggles, a background-effect
 *     switch landing mid-publish).
 *
 * API usage here (publishTrack with a MediaStreamTrack + explicit source,
 * unpublishTrack(track, stopOnUnpublish), LocalTrack.replaceTrack,
 * LocalTrackPublication.mute/unmute, Room.disconnect(stopTracks)) should
 * be confirmed by a typecheck against the installed livekit-client — it
 * was written without the package's .d.ts available.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Participant,
  type TrackPublication,
} from "livekit-client";

export interface LiveKitPeer {
  userId: number;
  name: string;
  /** Camera video + microphone audio. A new object whenever tracks change. */
  cameraStream: MediaStream;
  /** True once at least one camera-stream track (audio or video) exists. */
  cameraActive: boolean;
  /** Whether their microphone is actually unmuted right now — distinct
   *  from cameraActive, which only reflects whether a track is
   *  published at all. See PeerEntry's comment for why these differ. */
  micEnabled: boolean;
  /** Whether their camera is actually unmuted right now — same
   *  distinction as micEnabled above. */
  cameraEnabled: boolean;
  /** Screen-share video + its audio. A new object whenever tracks change. */
  screenStream: MediaStream;
  /** True while a screen-share VIDEO track is present. */
  screenActive: boolean;
}

interface PeerEntry {
  identity: string;
  userId: number;
  name: string;
  cameraStream: MediaStream;
  screenStream: MediaStream;
  // Actual mute state (LocalTrackPublication.mute()/unmute() on their
  // end), tracked via RoomEvent.TrackMuted/TrackUnmuted — distinct from
  // cameraActive/screenActive below, which only reflect whether a track
  // is PUBLISHED at all. This app mutes by calling .mute() rather than
  // unpublishing (see setLocalMuted), so a track stays published-but-
  // muted when someone turns their camera off — cameraActive would stay
  // true throughout, which is why that alone can't answer "is their
  // camera currently on".
  micEnabled: boolean;
  cameraEnabled: boolean;
}

function isScreenSource(source: Track.Source): boolean {
  return source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;
}

function withTrack(stream: MediaStream, track: MediaStreamTrack): MediaStream {
  const tracks = stream.getTracks();
  return tracks.includes(track) ? stream : new MediaStream([...tracks, track]);
}

function withoutTrack(stream: MediaStream, track: MediaStreamTrack): MediaStream {
  const tracks = stream.getTracks();
  return tracks.includes(track) ? new MediaStream(tracks.filter((t) => t !== track)) : stream;
}

export function useLiveKitRoom(livekitUrl: string | null, livekitToken: string | null) {
  const roomRef = useRef<Room | null>(null);
  // Remote participants' stream bookkeeping. A ref (not state) because the
  // Map is mutated from event handlers; peers[] below is what React sees.
  const peerEntriesRef = useRef<Map<string, PeerEntry>>(new Map());
  // Local MediaStreamTracks currently published (or mid-publish), so the
  // same track is never published twice.
  const publishedRef = useRef<Set<MediaStreamTrack>>(new Set());
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [peers, setPeers] = useState<LiveKitPeer[]>([]);
  // Mirrors roomRef.current for consumers (useMeetingRoom's DataReceived
  // listener) that need it in their own effect deps. Returning
  // roomRef.current directly from this hook is a real React rules
  // violation (accessing a ref's value during render isn't guaranteed to
  // produce a re-render when it changes) — state is what gives it an
  // actual, guaranteed render trigger.
  const [roomInstance, setRoomInstance] = useState<Room | null>(null);

  /** Runs `task` after every previously queued local-media task finishes. */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const getOrCreateEntry = useCallback((participant: Participant): PeerEntry => {
    const identity = participant.identity;
    let entry = peerEntriesRef.current.get(identity);
    if (!entry) {
      entry = {
        identity,
        userId: Number(identity) || 0,
        name: participant.name || "Participant",
        cameraStream: new MediaStream(),
        screenStream: new MediaStream(),
        // Starts true (unmuted) — matches a freshly-published track's
        // real starting state; corrected immediately if seeding from an
        // already-muted participant finds otherwise (see the seed loop
        // in the connect effect, and the isMicrophoneEnabled/
        // isCameraEnabled getters it reads from there).
        micEnabled: true,
        cameraEnabled: true,
      };
      peerEntriesRef.current.set(identity, entry);
    }
    // A display name can change after the entry is first created.
    entry.name = participant.name || entry.name;
    return entry;
  }, []);

  // Rebuilds the peers[] React state from the entry map. Called after any
  // change worth re-rendering for (a track arriving/leaving, someone
  // joining/leaving).
  const syncPeersState = useCallback(() => {
    const next: LiveKitPeer[] = [];
    for (const entry of peerEntriesRef.current.values()) {
      next.push({
        userId: entry.userId,
        name: entry.name,
        cameraStream: entry.cameraStream,
        cameraActive: entry.cameraStream.getTracks().length > 0,
        micEnabled: entry.micEnabled,
        cameraEnabled: entry.cameraEnabled,
        screenStream: entry.screenStream,
        screenActive: entry.screenStream.getVideoTracks().length > 0,
      });
    }
    setPeers(next);
  }, []);

  useEffect(() => {
    if (!livekitUrl || !livekitToken) return;
    let cancelled = false;
    const publishedTracks = publishedRef.current;
    const peerEntries = peerEntriesRef.current;
    const room = new Room({
      // See the file comment: adaptiveStream would pause tracks that are
      // not attached via track.attach().
      adaptiveStream: false,
      // Publisher-side: stop sending simulcast layers nobody subscribes to.
      dynacast: true,
    });
    roomRef.current = room;

    const addRemoteTrack = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      const entry = getOrCreateEntry(participant);
      if (isScreenSource(publication.source)) {
        entry.screenStream = withTrack(entry.screenStream, track.mediaStreamTrack);
      } else {
        entry.cameraStream = withTrack(entry.cameraStream, track.mediaStreamTrack);
      }
    };

    const handleTrackSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      addRemoteTrack(track, publication, participant);
      syncPeersState();
    };
    const handleTrackUnsubscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      const entry = peerEntries.get(participant.identity);
      if (!entry) return;
      if (isScreenSource(publication.source)) {
        entry.screenStream = withoutTrack(entry.screenStream, track.mediaStreamTrack);
      } else {
        entry.cameraStream = withoutTrack(entry.cameraStream, track.mediaStreamTrack);
      }
      syncPeersState();
    };
    const handleParticipantConnected = (participant: RemoteParticipant) => {
      getOrCreateEntry(participant);
      syncPeersState();
    };
    const handleParticipantDisconnected = (participant: RemoteParticipant) => {
      peerEntries.delete(participant.identity);
      syncPeersState();
    };
    const setMuteState = (publication: TrackPublication, participant: Participant, enabled: boolean) => {
      // Plain .get(), not getOrCreateEntry — this fires for the local
      // participant too (a room-level event covers everyone), and the
      // local participant was never added to peerEntries in the first
      // place, so there's nothing to update; .get() just misses
      // harmlessly instead of creating a spurious entry for ourselves.
      const entry = peerEntries.get(participant.identity);
      if (!entry) return;
      if (publication.source === Track.Source.Microphone) entry.micEnabled = enabled;
      else if (publication.source === Track.Source.Camera) entry.cameraEnabled = enabled;
      else return; // screen-share mute isn't tracked here — no UI depends on it
      syncPeersState();
    };
    const handleTrackMuted = (publication: TrackPublication, participant: Participant) => setMuteState(publication, participant, false);
    const handleTrackUnmuted = (publication: TrackPublication, participant: Participant) => setMuteState(publication, participant, true);

    room
      .on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
      .on(RoomEvent.ParticipantConnected, handleParticipantConnected)
      .on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected)
      .on(RoomEvent.TrackMuted, handleTrackMuted)
      .on(RoomEvent.TrackUnmuted, handleTrackUnmuted)
      .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        setConnected(state === ConnectionState.Connected);
      })
      .on(RoomEvent.Disconnected, () => setConnected(false));

    (async () => {
      try {
        await room.connect(livekitUrl, livekitToken);
        if (cancelled) {
          await room.disconnect(false);
          return;
        }
        setConnectError(null);
        setRoomInstance(room);
        // Seed with anyone already in the room: the events above only
        // fire for changes AFTER this point.
        room.remoteParticipants.forEach((participant) => {
          const entry = getOrCreateEntry(participant);
          entry.micEnabled = participant.isMicrophoneEnabled;
          entry.cameraEnabled = participant.isCameraEnabled;
          participant.trackPublications.forEach((publication) => {
            if (publication.track) {
              addRemoteTrack(publication.track as RemoteTrack, publication as RemoteTrackPublication, participant);
            }
          });
        });
        syncPeersState();
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to connect to LiveKit room:", err);
        setConnectError(err instanceof Error ? err.message : "Couldn't connect to the media server.");
      }
    })();

    return () => {
      cancelled = true;
      // stopTracks=false: the local tracks belong to the room page (it
      // stops them when leaving); LiveKit must not stop them behind its
      // back, which would blank the local preview.
      void room.disconnect(false);
      roomRef.current = null;
      setRoomInstance(null);
      publishedTracks.clear();
      peerEntries.clear();
      queueRef.current = Promise.resolve();
      setConnected(false);
    };
  }, [livekitUrl, livekitToken, getOrCreateEntry, syncPeersState]);

  /**
   * Publishes the page's own mic and camera tracks. Safe to call
   * repeatedly (an already-published track is skipped). A track that is
   * currently muted in the UI is published and immediately muted, so
   * remote participants never see a camera-on frame for someone who joined
   * with the camera off.
   */
  const publishLocalStream = useCallback(
    (stream: MediaStream, initiallyMuted: { audio: boolean; video: boolean }) =>
      enqueue(async () => {
        const room = roomRef.current;
        if (!room || room.state !== ConnectionState.Connected) return;
        const items: { track: MediaStreamTrack | undefined; source: Track.Source; muted: boolean }[] = [
          { track: stream.getAudioTracks()[0], source: Track.Source.Microphone, muted: initiallyMuted.audio },
          { track: stream.getVideoTracks()[0], source: Track.Source.Camera, muted: initiallyMuted.video },
        ];
        for (const { track, source, muted } of items) {
          if (!track || track.readyState === "ended" || publishedRef.current.has(track)) continue;
          publishedRef.current.add(track);
          try {
            const publication = await room.localParticipant.publishTrack(track, { source, name: source });
            if (muted) await publication.mute();
          } catch (err) {
            publishedRef.current.delete(track);
            console.error(`Failed to publish local ${source} track:`, err);
          }
        }
      }),
    [enqueue],
  );

  /** Mirrors the page's mic/camera on-off state onto the LiveKit publication. */
  const setLocalMuted = useCallback(
    (kind: "audio" | "video", muted: boolean) =>
      enqueue(async () => {
        const room = roomRef.current;
        if (!room) return;
        const publication = room.localParticipant.getTrackPublication(
          kind === "audio" ? Track.Source.Microphone : Track.Source.Camera,
        );
        if (!publication || publication.isMuted === muted) return;
        if (muted) await publication.mute();
        else await publication.unmute();
      }).catch((err) => console.error("Failed to update LiveKit mute state:", err)),
    [enqueue],
  );

  /**
   * Swaps the published camera track's content — e.g. to/from the
   * processed canvas track of the virtual-background feature — without
   * unpublishing. LiveKit is an SFU, so this is one call and every
   * subscriber follows; no per-peer loop like the old mesh needed.
   */
  const replaceCameraTrack = useCallback(
    (newTrack: MediaStreamTrack) =>
      enqueue(async () => {
        const room = roomRef.current;
        if (!room) return;
        const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
        const localTrack = publication?.track;
        if (!localTrack || !("replaceTrack" in localTrack)) return;
        const previous = localTrack.mediaStreamTrack;
        await (localTrack as unknown as { replaceTrack: (t: MediaStreamTrack, userProvided?: boolean) => Promise<unknown> }).replaceTrack(newTrack, true);
        publishedRef.current.delete(previous);
        publishedRef.current.add(newTrack);
      }).catch((err) => console.error("Failed to swap LiveKit camera track:", err)),
    [enqueue],
  );

  /** Publishes a getDisplayMedia() stream as its own screen-share tracks. */
  const publishScreenShare = useCallback(
    (stream: MediaStream) =>
      enqueue(async () => {
        const room = roomRef.current;
        if (!room || room.state !== ConnectionState.Connected) return;
        const items: { track: MediaStreamTrack | undefined; source: Track.Source }[] = [
          { track: stream.getVideoTracks()[0], source: Track.Source.ScreenShare },
          { track: stream.getAudioTracks()[0], source: Track.Source.ScreenShareAudio },
        ];
        for (const { track, source } of items) {
          if (!track || publishedRef.current.has(track)) continue;
          publishedRef.current.add(track);
          try {
            await room.localParticipant.publishTrack(track, { source, name: source });
          } catch (err) {
            publishedRef.current.delete(track);
            console.error(`Failed to publish ${source}:`, err);
          }
        }
      }),
    [enqueue],
  );

  /** Unpublishes (without stopping — the page does that) a screen share. */
  const unpublishScreenShare = useCallback(
    (stream: MediaStream) =>
      enqueue(async () => {
        const room = roomRef.current;
        if (!room) return;
        for (const track of stream.getTracks()) {
          if (!publishedRef.current.has(track)) continue;
          publishedRef.current.delete(track);
          try {
            await room.localParticipant.unpublishTrack(track, false);
          } catch {
            // Already gone — LiveKit unpublishes a screen-share track by
            // itself when the browser ends it (e.g. "Stop sharing").
          }
        }
      }),
    [enqueue],
  );

  /**
   * Broadcasts an ephemeral event directly to every other participant —
   * no server round-trip, unlike chat (which needs one anyway for
   * persistence) or host-control events (which originate server-side in
   * the first place). Same `{event, payload}` JSON wire format as
   * src/lib/livekit-emitters.ts, so the receiving side's dispatcher
   * doesn't need to care which path a given event arrived by. Not
   * queued through `enqueue` like the publish/mute functions above —
   * those serialize local-track mutations specifically because
   * publishing, replacing, and unpublishing the same track concurrently
   * would race; a fire-and-forget data message has no such conflict to
   * avoid.
   */
  const sendData = useCallback((event: string, payload?: unknown, options?: { reliable?: boolean }) => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) {
      console.warn(`[Veyra] sendData(${event}) dropped — room not connected (state: ${room?.state ?? "no room"})`);
      return;
    }
    const data = new TextEncoder().encode(JSON.stringify({ event, payload }));
    room.localParticipant.publishData(data, { reliable: options?.reliable ?? true }).catch((err) => {
      console.error(`Failed to send LiveKit data message (${event}):`, err);
    });
  }, []);

  return {
    connected,
    connectError,
    peers,
    publishLocalStream,
    setLocalMuted,
    replaceCameraTrack,
    publishScreenShare,
    unpublishScreenShare,
    sendData,
    // For useMeetingRoom to attach a RoomEvent.DataReceived listener —
    // see src/lib/livekit-emitters.ts.
    room: roomInstance,
  };
}
