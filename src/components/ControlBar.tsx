"use client";

/**
 * Bottom control bar for the meeting room: mic, camera, screen share,
 * reactions, captions, raise hand, participants panel toggle, and leave —
 * plus, host-only, lock/unlock meeting access, set/change passcode, and
 * end-meeting-for-everyone (those three live in the room page's own
 * "More options" menu, not here — see room/[token]/page.tsx).
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Captions,
  Hand,
  Mic,
  MicOff,
  MoreVertical,
  PhoneOff,
  ScreenShare,
  Smile,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "@/lib/toast";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "👏", "🎉"];

interface ControlBarProps {
  micOn: boolean;
  cameraOn: boolean;
  /** True while the host has force-muted/force-cammed-off this person and
   *  hasn't released it — disables the corresponding button entirely. */
  micLocked?: boolean;
  cameraLocked?: boolean;
  participantsOpen: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleParticipants: () => void;
  onScreenShareClick: () => void;
  /** Switches the shared source without a normal "stop then manually
   *  restart" — only relevant while already sharing. */
  onPresentSomethingElse?: () => void;
  /** Whether you're currently sharing your screen — highlights the button. */
  sharingScreen?: boolean;
  /** Whether your own hand is currently raised — highlights the button. */
  handRaised?: boolean;
  onToggleHandRaise?: () => void;
  /** Send a quick emoji reaction to everyone in the meeting. */
  onReact?: (emoji: string) => void;
  /** Whether live captions are currently on — highlights the button. */
  captionsOn?: boolean;
  onToggleCaptions?: () => void;
  onMoreClick?: () => void;
  onLeave: () => void;
  leaving?: boolean;
  onChat?: () => void;
  onTools?: () => void;
}

function ControlButton({
  onClick,
  label,
  active = false,
  danger = false,
  disabled = false,
  children,
}: {
  onClick: () => void;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex h-12 w-12 items-center justify-center rounded-full transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-white/30 disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "bg-[#ea4335] text-white hover:bg-[#d93025]"
          : active
            ? "bg-[#8ab4f8] text-[#202124] hover:bg-[#a8c7fa]"
            : "bg-[#3c4043] text-white hover:bg-[#4a4d50]"
      }`}
    >
      {children}
    </button>
  );
}

export function ControlBar({
  micOn,
  cameraOn,
  micLocked = false,
  cameraLocked = false,
  participantsOpen,
  onToggleMic,
  onToggleCamera,
  onToggleParticipants,
  onScreenShareClick,
  onPresentSomethingElse,
  sharingScreen = false,
  handRaised = false,
  onToggleHandRaise,
  onReact,
  captionsOn = false,
  onToggleCaptions,
  onMoreClick,
  onLeave,
  leaving = false,
  onChat,
  onTools,
}: ControlBarProps) {
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);

  return (
    <>
      {/* Google Meet-style bottom control strip */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-5">
        <div className="pointer-events-auto flex max-w-full items-center gap-1.5 overflow-x-auto rounded-full bg-[#202124]/95 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,.45)] backdrop-blur-xl sm:gap-2 sm:p-2">
          <div
            aria-label="Speaking activity"
            title="Speaking activity"
            className="hidden h-12 w-10 items-center justify-center rounded-full text-[#8ab4f8] sm:flex"
          >
            <AudioLines size={19} className="animate-pulse" />
          </div>

          <ControlButton
            onClick={onToggleMic}
            label={micLocked ? "Muted by host" : micOn ? "Turn off microphone" : "Turn on microphone"}
            active={micOn}
            disabled={micLocked}
          >
            {micOn ? <Mic size={21} /> : <MicOff size={21} />}
          </ControlButton>

          <ControlButton
            onClick={onToggleCamera}
            label={cameraLocked ? "Camera turned off by host" : cameraOn ? "Turn off camera" : "Turn on camera"}
            active={cameraOn}
            disabled={cameraLocked}
          >
            {cameraOn ? <Video size={21} /> : <VideoOff size={21} />}
          </ControlButton>

          <div className="relative">
            <ControlButton
              onClick={() => (sharingScreen ? setShareMenuOpen((v) => !v) : onScreenShareClick())}
              label={sharingScreen ? "Presenting options" : "Share screen"}
              active={sharingScreen}
            >
              <ScreenShare size={20} />
            </ControlButton>
            {shareMenuOpen && createPortal(
              <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-3 sm:bottom-24">
                <div className="pointer-events-auto flex min-w-[220px] flex-col overflow-hidden rounded-xl bg-[#2b2c30] py-1.5 shadow-2xl ring-1 ring-white/10">
                  <button
                    onClick={() => {
                      setShareMenuOpen(false);
                      onPresentSomethingElse?.();
                    }}
                    className="flex items-center gap-3 px-4 py-2.5 text-left text-sm text-white hover:bg-white/10"
                  >
                    <ScreenShare size={16} className="shrink-0 text-white/70" />
                    Present something else
                  </button>
                  <button
                    onClick={() => {
                      setShareMenuOpen(false);
                      onScreenShareClick();
                    }}
                    className="flex items-center gap-3 px-4 py-2.5 text-left text-sm text-red-400 hover:bg-white/10"
                  >
                    <ScreenShare size={16} className="shrink-0 text-red-400" />
                    Stop sharing
                  </button>
                </div>
              </div>,
              document.body,
            )}
          </div>

          <div className="relative">
            <ControlButton onClick={() => setReactionsOpen((v) => !v)} label="Reactions" active={reactionsOpen}>
              <Smile size={21} />
            </ControlButton>
            {reactionsOpen && createPortal(
              <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-3 sm:bottom-24">
                <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-[#202124] p-1.5 shadow-2xl ring-1 ring-white/10">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        onReact?.(emoji);
                        setReactionsOpen(false);
                      }}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-lg transition-transform hover:scale-125 hover:bg-white/10"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>,
              document.body,
            )}
          </div>

          <div className="hidden sm:contents">
            <ControlButton
              onClick={onToggleCaptions ?? (() => toast.info("Captions aren't available right now."))}
              label={captionsOn ? "Turn off captions" : "Turn on captions"}
              active={captionsOn}
            >
              <Captions size={20} />
            </ControlButton>
          </div>

          <div className="hidden sm:contents">
            <ControlButton
              onClick={onToggleHandRaise ?? (() => undefined)}
              label={handRaised ? "Lower hand" : "Raise hand"}
              active={handRaised}
            >
              <Hand size={20} />
            </ControlButton>
          </div>

          {/* People moved into the main pill, unlike chat/tools below —
              this is the one of the three utility buttons genuinely core
              to using the room (seeing who's here, host actions on
              them), so unlike chat/tools it shouldn't disappear below md
              just because that separate utility strip is desktop-only. */}
          <ControlButton onClick={onToggleParticipants} label="People" active={participantsOpen}>
            <Users size={20} />
          </ControlButton>

          <ControlButton onClick={onMoreClick ?? (() => undefined)} label="More options">
            <MoreVertical size={21} />
          </ControlButton>

          <button
            onClick={onLeave}
            disabled={leaving}
            aria-label="Leave meeting"
            title="Leave meeting"
            className="ml-1 flex h-12 min-w-16 items-center justify-center rounded-full bg-[#ea4335] px-5 text-white transition hover:bg-[#d93025] disabled:cursor-wait disabled:opacity-60 sm:min-w-20"
          >
            <PhoneOff size={21} />
          </button>
        </div>
      </div>

      {/* Meet-style utility buttons on the lower-right */}
      <div className="absolute bottom-5 right-4 z-30 hidden items-center gap-1 rounded-full bg-[#202124]/90 p-1.5 shadow-xl ring-1 ring-white/5 md:flex">
        <button onClick={onChat ?? (() => undefined)} aria-label="Chat" title="Chat" className="flex h-11 w-11 items-center justify-center rounded-full text-white/90 hover:bg-white/10">
          <span className="text-[18px]">▤</span>
        </button>
        <button onClick={onTools ?? (() => undefined)} aria-label="Meeting tools" title="Meeting tools" className="flex h-11 w-11 items-center justify-center rounded-full text-white/90 hover:bg-white/10">
          <span className="grid grid-cols-3 gap-1">
            {Array.from({ length: 9 }).map((_, i) => <span key={i} className="h-1.5 w-1.5 rounded-sm bg-current" />)}
          </span>
        </button>
      </div>
    </>
  );
}
