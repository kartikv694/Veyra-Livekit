"use client";

/**
 * One participant's tile in the meeting grid.
 *
 * The tile also measures the audio level of its MediaStream locally. This
 * gives every participant a live speaking indicator without sending audio
 * levels through Socket.IO.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AudioWaveform, Bot, Hand, MicOff } from "lucide-react";

interface VideoTileProps {
  name: string;
  isHost?: boolean;
  isMuted?: boolean;
  cameraOn?: boolean;
  /** Local camera stream or a remote peer's MediaStream. */
  stream?: MediaStream | null;
  /** True when this tile belongs to the current user. */
  isLocal?: boolean;
  /** Shows a raised-hand badge in the corner. */
  handRaised?: boolean;
  /** True for Veyra's own meeting-analysis agent, not a human participant
   *  — shows a bot icon and an "AI" label instead of initials, and never
   *  has a camera/mic to render regardless of cameraOn/stream. */
  isAgent?: boolean;
  /** Set false for full-bleed views (solo camera, presenting) to match
   *  Meet's edge-to-edge look. Defaults true for grid/thumbnail tiles. */
  rounded?: boolean;
  /** Mirrors the video horizontally — set true for your own camera (a
   *  natural mirror-image self-view, matching every video call app), but
   *  NEVER for a screen share (mirroring shared content backwards would
   *  make it unreadable) or a remote participant's camera (only correct
   *  from their own vantage point, not ours). */
  mirrored?: boolean;
  /** "cover" (default) fills the tile and crops overflow — right for a
   *  camera feed. "contain" fits the whole frame inside the tile without
   *  cropping — required for a screen share, since cropping shared
   *  content (e.g. a wide desktop into a narrow phone tile) hides part
   *  of what's actually being presented. */
  fit?: "cover" | "contain";
}

function initials(name: string): string {
  // The name passed in sometimes has a display suffix baked in (e.g.
  // "Tester (You)") — strip anything in parentheses before computing
  // initials, or a suffix word gets treated as its own "name" and
  // contributes a stray character (was producing "T(" for "Tester (You)").
  const base = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return base
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function SpeakingIndicator({ speaking }: { speaking: boolean }) {
  if (!speaking) return null;

  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent shadow-[0_0_14px_rgba(255,255,255,0.08)]"
      title="Speaking"
      aria-label="Speaking"
    >
      <AudioWaveform size={16} className="animate-pulse" />
    </span>
  );
}

function VideoTile({
  name,
  isHost = false,
  isMuted = false,
  cameraOn = false,
  stream = null,
  isLocal = false,
  handRaised = false,
  isAgent = false,
  rounded = true,
  mirrored = false,
  fit = "cover",
}: VideoTileProps) {
  const [speaking, setSpeaking] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const attachStream = useCallback((video: HTMLVideoElement | null, s: MediaStream | null, local: boolean) => {
    if (!video || !s) return;
    if (video.srcObject !== s) video.srcObject = s;
    if (!local) void video.play().catch(() => undefined);
  }, []);

  // A callback ref, not a plain useRef+effect: the <video> element only
  // exists in the DOM while `cameraOn && stream` is true (see the
  // conditional render below), so it can mount well AFTER `stream` and
  // `isLocal` were already stable — e.g. the camera finishes turning on
  // a moment after the stream itself was set. A useEffect gated on
  // [stream, isLocal] would have already run and bailed out (no element
  // yet) by that point, and never fire again since neither dep changed —
  // leaving srcObject unset and the tile permanently blank. A callback
  // ref instead fires on every single mount, regardless of whether any
  // prop "changed", which is exactly the guarantee needed here.
  const setVideoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      attachStream(el, stream, isLocal);
    },
    [attachStream, stream, isLocal],
  );

  // Covers the other half of this: a peer's MediaStream can exist — and
  // already be the same object reference — before its video track has
  // actually arrived (the audio track often connects first). When the
  // video track gets added to that SAME stream object afterward, the
  // reference never changes, so neither the callback ref above (which
  // only fires on mount/unmount) nor a plain identity check would notice.
  // Listening for the stream's own addtrack/removetrack events catches
  // exactly that case, re-attaching once the track is actually there.
  useEffect(() => {
    attachStream(videoRef.current, stream, isLocal);
    if (!stream) return;
    const handler = () => attachStream(videoRef.current, stream, isLocal);
    stream.addEventListener("addtrack", handler);
    stream.addEventListener("removetrack", handler);
    return () => {
      stream.removeEventListener("addtrack", handler);
      stream.removeEventListener("removetrack", handler);
    };
  }, [stream, isLocal, attachStream]);

  useEffect(() => {
    // No explicit setSpeaking(false) here for the "nothing to analyze"
    // case — it's provably redundant, not just omitted: speaking
    // already defaults to false on mount, and any transition INTO this
    // branch means a previous effect instance (with valid audio) is
    // tearing down, whose own cleanup below already resets it.
    if (!stream || isMuted || stream.getAudioTracks().length === 0) {
      return;
    }

    const AudioContextClass = window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextClass) return;

    const audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    // A smaller FFT and a slower sampling interval are enough for a
    // speaking indicator and substantially reduce CPU use when a room has
    // many tiles. The previous 512-bin / 90ms loop created a separate audio
    // analyser workload for every participant tile.
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let previousSpeaking = false;

    const detect = () => {
      analyser.getByteTimeDomainData(samples);

      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const normalized = (samples[i] - 128) / 128;
        sum += normalized * normalized;
      }

      const nextSpeaking = Math.sqrt(sum / samples.length) > 0.045;
      // Avoid a React render every sample when the speaking state hasn't
      // actually changed.
      if (nextSpeaking !== previousSpeaking) {
        previousSpeaking = nextSpeaking;
        setSpeaking(nextSpeaking);
      }
      frame = window.setTimeout(detect, 180);
    };

    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => undefined);
    }
    detect();

    return () => {
      window.clearTimeout(frame);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close().catch(() => undefined);
      setSpeaking(false);
    };
  }, [stream, isMuted]);

  return (
    <div
      className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden ring-2 transition-all duration-200 ${
        rounded ? "rounded-xl" : "rounded-none"
      } ${cameraOn && stream && !isAgent ? "bg-[#171A21]" : isAgent ? "bg-[#1E2A3A]" : "bg-[#2A2350]"} ${
        speaking ? "ring-accent shadow-[0_0_24px_rgba(255,255,255,0.08)]" : "ring-transparent"
      }`}
    >
      {cameraOn && stream && !isAgent ? (
        <video
          autoPlay
          muted={isLocal}
          playsInline
          ref={setVideoRef}
          className={`h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"} ${mirrored ? "-scale-x-100" : ""}`}
        />
      ) : isAgent ? (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Bot size={28} />
        </div>
      ) : (
        <div
          className={`flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-lg font-semibold text-white transition-transform duration-200 ${
            speaking ? "scale-105" : "scale-100"
          }`}
        >
          {initials(name)}
        </div>
      )}

      {handRaised && (
        <div
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-amber-400 text-[#202124] shadow-lg"
          title={`${name} raised their hand`}
        >
          <Hand size={16} />
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium text-white">
          {name}
          {isHost && <span className="ml-1.5 text-xs font-normal text-white/60">Host</span>}
          {isAgent && <span className="ml-1.5 text-xs font-normal text-accent">AI</span>}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {!isAgent && <SpeakingIndicator speaking={speaking} />}
          {!isAgent && isMuted && <MicOff size={14} className="shrink-0 text-white/80" />}
        </div>
      </div>
    </div>
  );
}

export const MemoizedVideoTile = memo(VideoTile);
export { MemoizedVideoTile as VideoTile } ;
export default MemoizedVideoTile;
