"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Ban,
  Bot,
  Captions,
  Check,
  Copy,
  Droplets,
  Grid3X3,
  KeyRound,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  LayoutGrid,
  Hand,
  Search,
  Send,
  Timer,
  UserPlus,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { BrandLink } from "@/components/BrandLink";
import { BACKGROUND_TEMPLATES, backgroundEffectsEqual, type BackgroundEffect } from "@/lib/backgroundEffectTypes";
import type { VirtualBackgroundProcessor } from "@/lib/virtualBackground";
import { toast, confirmToast, promptToast } from "@/lib/toast";
import { VideoTile } from "@/components/VideoTile";
import { ControlBar } from "@/components/ControlBar";
import { ParticipantList, type ParticipantRow } from "@/components/ParticipantList";
import { LoadingScreen } from "@/components/LoadingScreen";
import { checkAuth, authHeaders, type SessionUser } from "@/lib/auth-client";
import { useMeetingRoom, type RemotePeer } from "@/hooks/useMeetingRoom";
import { useLiveKitRoom } from "@/hooks/useLiveKitRoom";

/**
 * The Web Speech API's SpeechRecognition isn't part of TypeScript's
 * default DOM lib (it's non-standard, Chrome/Edge-only), so a minimal
 * shape is declared here rather than reaching for `any` everywhere
 * captions logic touches it.
 */
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: { resultIndex: number; results: { [i: number]: { [j: number]: { transcript: string } } } & { length: number } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type Panel = "people" | "chat" | "tools" | null;

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Meet caps how many tiles it renders at once and keeps everyone past
 *  that cap connected in the background (audio/video still flowing,
 *  just not drawn as a tile) rather than cramming an unreadable number
 *  of boxes onto one screen. */
/** Presets the host can pick from in Meeting tools — fewer, bigger tiles
 *  vs. more, smaller ones, same trade-off Meet's own tile-count control
 *  offers. The grid still falls back to whatever fits when the actual
 *  participant count is lower than the chosen cap. */
const TILE_COUNT_OPTIONS = [4, 9, 16, 25] as const;
const DEFAULT_MAX_VISIBLE_TILES = 9;

/**
 * Column count for a given number of visible tiles, matching Meet's own
 * tiled-view breakpoints. This is a fixed lookup, not an aspect-ratio
 * calculation — Meet fills each cell full-bleed with object-cover
 * (cropping the camera to fit) rather than shrinking tiles to avoid
 * cropping, which is what actually produces its edge-to-edge look.
 */
function meetGridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  if (count === 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  // Beyond Meet's exact small-count breakpoints (which only really apply
  // up to a 3x3 grid), fall back to a near-square grid — same principle,
  // just generalized so the larger tile-count presets (16, 25) still lay
  // out sensibly.
  return Math.ceil(Math.sqrt(count));
}

/**
 * Mobile gets its own column count instead of just capping meetGridColumns
 * at 2. The desktop 2-column case (side by side) is fine on a wide
 * screen, but on a tall narrow phone screen, 2 full-height side-by-side
 * columns makes each cell extremely tall and narrow — object-cover then
 * has to crop most of a 16:9 camera feed's top and bottom to fill that
 * shape, cutting off foreheads/chins. Stacking 2 people in a single
 * column (2 full-width rows) keeps each cell much closer to a normal
 * landscape shape instead.
 */
function mobileGridColumns(count: number): number {
  if (count <= 2) return 1;
  return 2;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function ReadyMeetingCard({
  token, inviteInput, setInviteInput, inviting, handleInvite, linkCopied, setLinkCopied, onClose,
}: {
  token: string; inviteInput: string; setInviteInput: (value: string) => void; inviting: boolean;
  handleInvite: () => Promise<void>; linkCopied: boolean; setLinkCopied: (value: boolean) => void; onClose: () => void;
}) {
  const link = typeof window !== "undefined" ? `${window.location.origin}/room/${token}` : `/room/${token}`;
  const copyLink = async () => {
    await navigator.clipboard.writeText(link); setLinkCopied(true); toast.success("Link copied.");
    window.setTimeout(() => setLinkCopied(false), 1500);
  };

  const [showContacts, setShowContacts] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contacts, setContacts] = useState<{ id: number; name: string | null; email: string }[]>([]);
  const [contactQuery, setContactQuery] = useState("");
  // The actual, persisted invite list — separate from inviteEmails (the
  // text box's current contents), because handleInvite clears the box
  // right after a successful send. Without this, the checkmark on a
  // contact you just invited would disappear the instant the box clears,
  // even though they're genuinely still on the invite list.
  const [alreadyInvitedEmails, setAlreadyInvitedEmails] = useState<Set<string>>(new Set());

  const inviteEmails = inviteInput.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

  const filteredContacts = (() => {
    const q = contactQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (contact) => contact.email.toLowerCase().includes(q) || (contact.name ?? "").toLowerCase().includes(q),
    );
  })();

  const loadInvitedEmails = async () => {
    try {
      const res = await fetch(`/api/rooms/${token}/invite`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.invites)) {
        setAlreadyInvitedEmails(new Set(data.invites.map((i: { email: string }) => i.email.toLowerCase())));
      }
    } catch {
      // Non-critical — the checkmark just won't reflect past invites
      // until the next successful open; inviting itself still works.
    }
  };

  const toggleContacts = async () => {
    const next = !showContacts;
    setShowContacts(next);
    if (!next) return;
    setContactQuery("");
    setLoadingContacts(true);
    try {
      const [contactsRes] = await Promise.all([
        fetch("/api/contacts", { headers: authHeaders() }),
        loadInvitedEmails(),
      ]);
      const data = await contactsRes.json().catch(() => ({}));
      if (contactsRes.ok) setContacts(data.contacts ?? []);
    } catch {
      // Non-critical — the manual "Invite by email" field below still works.
    } finally {
      setLoadingContacts(false);
    }
  };

  // Re-checks the persisted list right after a send succeeds, so a
  // contact you just invited immediately shows the checkmark instead of
  // waiting for the dropdown to be closed and reopened.
  const handleInviteAndRefresh = async () => {
    await handleInvite();
    if (showContacts) void loadInvitedEmails();
  };

  const addContactEmail = (email: string) => {
    const lower = email.trim().toLowerCase();
    if (inviteEmails.includes(lower)) return;
    setInviteInput(inviteEmails.length ? `${inviteInput.replace(/[,\s]+$/, "")}, ${lower}` : lower);
  };

  return (
    <div className="fixed left-4 top-16 z-[70] w-[calc(100%-2rem)] max-w-sm rounded-2xl bg-[#202124] p-5 text-white shadow-2xl sm:left-6 sm:top-20">
      <div className="flex items-start justify-between"><h2 className="text-lg font-medium">Your meeting&apos;s ready</h2>
        <button onClick={onClose} aria-label="Close" className="rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white"><X size={18} /></button></div>
      <p className="mt-2 text-sm text-white/60">Add people to your meeting or share the link. People on the invite list can join directly.</p>
      <button onClick={() => void toggleContacts()} className="mt-4 flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"><UserPlus size={16} /> Add others</button>

      {showContacts && (
        <div className="mt-2 rounded-lg bg-white/5">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
            <Search size={14} className="shrink-0 text-white/40" />
            <input
              autoFocus
              value={contactQuery}
              onChange={(e) => setContactQuery(e.target.value)}
              placeholder="Search by name or email"
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {loadingContacts ? (
              <p className="p-3 text-xs text-white/45">Loading people you&apos;ve met with before…</p>
            ) : contacts.length === 0 ? (
              <p className="p-3 text-xs text-white/45">No past meeting contacts yet — invite someone below and they&apos;ll show up here next time.</p>
            ) : filteredContacts.length === 0 ? (
              <p className="p-3 text-xs text-white/45">No one matches &quot;{contactQuery}&quot;.</p>
            ) : (
              filteredContacts.map((contact) => {
                const added = alreadyInvitedEmails.has(contact.email.toLowerCase()) || inviteEmails.includes(contact.email.toLowerCase());
                return (
                  <button
                    key={contact.id}
                    onClick={() => addContactEmail(contact.email)}
                    disabled={added}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-white/85 hover:bg-white/5 disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate">
                      <span className="block truncate font-medium">{contact.name ?? contact.email}</span>
                      {contact.name && <span className="block truncate text-xs text-white/45">{contact.email}</span>}
                    </span>
                    {added ? <Check size={14} className="shrink-0 text-white/50" /> : <UserPlus size={14} className="shrink-0 text-white/40" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2.5"><span className="truncate text-sm text-white/85">{typeof window !== "undefined" ? window.location.host : "localhost:3000"}/room/{token}</span><button onClick={() => void copyLink()} aria-label="Copy link" className="shrink-0 text-white/60 hover:text-white">{linkCopied ? <Check size={16} /> : <Copy size={16} />}</button></div>
      <p className="mt-4 flex items-start gap-2 text-xs text-white/45"><Lock size={13} className="mt-0.5 shrink-0" />People who use the link must be admitted unless their email is on the meeting invite list.</p>
      <div className="mt-4 border-t border-white/10 pt-4"><p className="text-xs font-semibold uppercase tracking-wider text-white/35">Invite by email</p><p className="mt-1 text-xs text-white/45">Add one or more email addresses. They can join directly once they sign in with that email.</p>
        <div className="mt-2 flex gap-2"><input value={inviteInput} onChange={e => setInviteInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void handleInviteAndRefresh(); } }} placeholder="name@example.com, another@example.com" className="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30" /><button onClick={() => void handleInviteAndRefresh()} disabled={inviting || !inviteInput.trim()} className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">{inviting ? "..." : "Invite"}</button></div>
      </div>
    </div>
  );
}

function MeetingPanel({
  panel,
  token,
  participants,
  viewerIsHost,
  onClose,
  onMute,
  onCameraOff,
  onRemove,
  onMuteAll,
  onUnmuteAll,
  onCameraOffAll,
  onCameraOnAll,
  pendingRequests,
  onAdmit,
  onDeny,
  inviteInput,
  setInviteInput,
  inviting,
  handleInvite,
  message,
  setMessage,
  layoutMode,
  onCycleLayout,
  maxVisibleTiles,
  onChangeMaxVisibleTiles,
  timerRemaining,
  onStartTimer,
  onStopTimer,
  chatMessages,
  onSendChat,
  myUserId,
  backgroundEffect,
  onChangeBackgroundEffect,
}: {
  panel: Panel;
  token: string;
  participants: ParticipantRow[];
  viewerIsHost: boolean;
  onClose: () => void;
  onMute: (userId: number) => void;
  onCameraOff: (userId: number) => void;
  onRemove: (userId: number) => void;
  onMuteAll: () => void;
  onUnmuteAll: () => void;
  onCameraOffAll: () => void;
  onCameraOnAll: () => void;
  pendingRequests: { id: number; userId: number; name: string; requestedAt: string }[];
  onAdmit: (requestId: number) => void;
  onDeny: (requestId: number) => void;
  inviteInput: string;
  setInviteInput: (value: string) => void;
  inviting: boolean;
  handleInvite: () => Promise<void>;
  message: string;
  setMessage: (value: string) => void;
  layoutMode: "auto" | "spotlight";
  onCycleLayout: () => void;
  maxVisibleTiles: number;
  onChangeMaxVisibleTiles: (value: number) => void;
  timerRemaining: number | null;
  onStartTimer: () => void;
  onStopTimer: () => void;
  chatMessages: { id: string; text: string; fromName: string; fromUserId: number; at: number }[];
  onSendChat: (text: string) => void;
  myUserId: number | null;
  backgroundEffect: BackgroundEffect;
  onChangeBackgroundEffect: (effect: BackgroundEffect) => void;
}) {
  if (!panel) return null;

  return (
    <aside className="absolute inset-x-0 top-0 bottom-24 z-30 flex flex-col overflow-hidden bg-[#202124] shadow-2xl ring-1 ring-white/10 sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-24 sm:w-[min(360px,calc(100vw-16px))] sm:rounded-2xl">
      {panel === "people" && (
        <ParticipantList
          open
          token={token}
          participants={participants}
          onClose={onClose}
          viewerIsHost={viewerIsHost}
          onMute={onMute}
          onCameraOff={onCameraOff}
          onRemove={onRemove}
          onMuteAll={onMuteAll}
          onUnmuteAll={onUnmuteAll}
          onCameraOffAll={onCameraOffAll}
          onCameraOnAll={onCameraOnAll}
          pendingRequests={pendingRequests}
          onAdmit={onAdmit}
          onDeny={onDeny}
          inviteInput={inviteInput}
          setInviteInput={setInviteInput}
          inviting={inviting}
          onInvite={() => void handleInvite()}
        />
      )}

      {panel === "chat" && (
        <div className="flex h-full flex-col text-white">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <h2 className="text-xl font-medium">In-call messages</h2>
            <button onClick={onClose} className="rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Close chat">
              <X size={20} />
            </button>
          </div>
          <div className="flex flex-1 flex-col justify-end gap-3 overflow-y-auto p-4">
            {chatMessages.length === 0 ? (
              <div className="rounded-xl bg-[#2b2c30] p-4 text-sm text-white/75">
                <div className="mb-2 flex items-center gap-2 font-medium text-white">
                  <MessageSquare size={16} />
                  Meeting chat
                </div>
                <p className="leading-6 text-white/55">
                  Messages here are live only — sent to everyone currently in the meeting, not saved anywhere.
                </p>
              </div>
            ) : (
              chatMessages.map((msg) => {
                const isMine = msg.fromUserId === myUserId;
                return (
                  <div key={msg.id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
                    <span className="mb-1 px-1 text-xs text-white/40">
                      {isMine ? "You" : msg.fromName} · {formatTime(new Date(msg.at))}
                    </span>
                    <span
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${isMine ? "bg-accent text-white" : "bg-[#2b2c30] text-white/90"
                        }`}
                    >
                      {msg.text}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-white/10 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="rounded-full border border-white/15 bg-[#1a1b1e] px-4 py-2">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const trimmed = message.trim();
                  if (!trimmed) return;
                  onSendChat(trimmed);
                  setMessage("");
                }}
                className="flex items-center gap-2"
              >
                <input
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Send a message"
                  className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
                />
                <button type="submit" aria-label="Send message" disabled={!message.trim()} className="rounded-full p-1.5 text-white/50 hover:text-white disabled:opacity-40">
                  <Send size={18} />
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {panel === "tools" && (
        <div className="flex h-full flex-col text-white">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <h2 className="text-xl font-medium">Meeting tools</h2>
            <button onClick={onClose} className="rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Close tools">
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="space-y-3">
              <button
                onClick={timerRemaining !== null ? onStopTimer : onStartTimer}
                className="flex w-full items-center gap-4 rounded-2xl bg-[#2b2c30] p-4 text-left transition hover:bg-[#34353a]"
              >
                <Timer className="text-purple-300" size={21} />
                <span className="flex-1">
                  <strong className="block text-sm font-medium">Timer</strong>
                  <small className="text-white/45">
                    {timerRemaining !== null
                      ? `${Math.floor(timerRemaining / 60)}:${String(timerRemaining % 60).padStart(2, "0")} remaining — tap to stop`
                      : "Show a countdown timer"}
                  </small>
                </span>
                <span className="text-white/35">›</span>
              </button>

              <div className="pt-4 text-xs font-semibold uppercase tracking-wider text-white/35">Background</div>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => onChangeBackgroundEffect({ type: "none" })}
                  aria-label="No background effect"
                  title="None"
                  className={`flex h-11 w-11 items-center justify-center rounded-full border-2 bg-[#2b2c30] text-white/60 transition ${backgroundEffect.type === "none" ? "border-accent" : "border-transparent hover:border-white/20"
                    }`}
                >
                  <Ban size={18} />
                </button>
                <button
                  onClick={() => onChangeBackgroundEffect({ type: "blur" })}
                  aria-label="Blur background"
                  title="Blur"
                  className={`flex h-11 w-11 items-center justify-center rounded-full border-2 bg-[#2b2c30] text-white/70 transition ${backgroundEffect.type === "blur" ? "border-accent" : "border-transparent hover:border-white/20"
                    }`}
                >
                  <Droplets size={18} />
                </button>
                {BACKGROUND_TEMPLATES.map((tpl) => {
                  const active = backgroundEffect.type === "gradient" && backgroundEffectsEqual(backgroundEffect, { type: "gradient", colors: tpl.colors });
                  return (
                    <button
                      key={tpl.id}
                      onClick={() => onChangeBackgroundEffect({ type: "gradient", colors: tpl.colors })}
                      aria-label={tpl.label}
                      title={tpl.label}
                      className={`h-11 w-11 rounded-full border-2 transition ${active ? "border-accent" : "border-transparent hover:border-white/20"}`}
                      style={{ background: `linear-gradient(135deg, ${tpl.colors[0]}, ${tpl.colors[1]})` }}
                    />
                  );
                })}
              </div>
              <p className="text-xs text-white/45">Blurs or replaces what&apos;s behind you — just for your own camera, everyone still sees you normally otherwise.</p>

              <div className="pt-4 text-xs font-semibold uppercase tracking-wider text-white/35">More tools</div>
              <button
                onClick={onCycleLayout}
                className="flex w-full items-center gap-4 rounded-2xl border border-white/10 p-4 text-left text-white/55 transition hover:bg-white/5"
              >
                <Grid3X3 size={19} />
                <span className="text-sm">Layout: {layoutMode === "auto" ? "Auto" : "Spotlight"}</span>
              </button>
              {layoutMode === "auto" && (
                <div className="pt-1">
                  <p className="text-xs text-white/45">
                    {viewerIsHost
                      ? "Tiles per screen — fewer, bigger tiles or more, smaller ones. Anyone past this count stays connected, just off-screen. Applies to everyone."
                      : "Tiles per screen — set by the host for everyone."}
                  </p>
                  <div className="mt-2 flex gap-2">
                    {TILE_COUNT_OPTIONS.map((count) => (
                      <button
                        key={count}
                        onClick={() => viewerIsHost && onChangeMaxVisibleTiles(count)}
                        disabled={!viewerIsHost}
                        className={`flex-1 rounded-lg border py-2 text-sm font-medium transition ${maxVisibleTiles === count
                          ? "border-accent bg-accent/10 text-white"
                          : "border-white/10 text-white/55 hover:bg-white/5"
                          } ${viewerIsHost ? "" : "cursor-default opacity-60 hover:bg-transparent"}`}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostCheckDone, setHostCheckDone] = useState(false);
  const [joining, setJoiningRoom] = useState(false);
  const [waitingForAdmission, setWaitingForAdmission] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<
    { id: number; userId: number; name: string; requestedAt: string }[]
  >([]);
  const [inviteInput, setInviteInput] = useState("");
  const [inviting, setInviting] = useState(false);
  const [me, setMe] = useState<SessionUser | null>(null);
  const [participants, setParticipants] = useState<ParticipantRow[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  // Returned by the join endpoint (null if LiveKit isn't configured on the
  // server, in which case media falls back to the legacy WebRTC mesh).
  // Only ever set together with `joined`, so nothing publishes into the
  // LiveKit room while still in the lobby / waiting to be admitted.
  const [livekitUrl, setLivekitUrl] = useState<string | null>(null);
  const [livekitToken, setLivekitToken] = useState<string | null>(null);
  // Remembers the last mic/camera toggle across a refresh — without this,
  // reloading the page always re-acquires the camera/mic as "on" by
  // default (that's just what getUserMedia gives you), ignoring that the
  // person had deliberately turned them off a moment ago. This is a
  // per-browser preference, not meeting state, so localStorage (not the
  // server) is the right place for it.
  const [micOn, setMicOn] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("veyra:mic-pref") !== "off";
  });
  const [cameraOn, setCameraOn] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("veyra:camera-pref") !== "off";
  });
  // True while the host has force-muted/force-cammed-off this participant
  // and hasn't released it yet — while true, this person's own mic/camera
  // buttons are disabled entirely, not just toggled off, so they can't
  // just click themselves back on. Only clears when the host explicitly
  // releases it (see onForceUnmuted/onForceCameraOn below).
  const [micLocked, setMicLocked] = useState(false);
  const [cameraLocked, setCameraLocked] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [ending, setEnding] = useState(false);
  const [locked, setLocked] = useState(false);
  const [passcodeSet, setPasscodeSet] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);
  // autoEndAt is computed once (scheduledAt ?? createdAt + durationMinutes)
  // rather than recomputed from raw fields on every render — see the
  // duration-check effect further down, which is the only thing that
  // reads it.
  const [autoEndAt, setAutoEndAt] = useState<Date | null>(null);
  const [autoEndTriggered, setAutoEndTriggered] = useState(false);
  const [durationWarningShown, setDurationWarningShown] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [showShareWarning, setShowShareWarning] = useState(false);
  // Lazy initializer runs synchronously during the very first render, on
  // the client — reading window.location.search here (rather than in a
  // useEffect that runs after mount) removes any timing gap where a
  // stale/not-yet-updated URL could be read relative to Next's
  // client-side navigation finishing.
  // The ready card is enabled only after the server confirms that the
  // authenticated user is the meeting host. A `fresh=1` URL alone must
  // never put a participant into the host UI.
  const [showReadyCard, setShowReadyCard] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const [layoutMode, setLayoutMode] = useState<"auto" | "spotlight">("auto");
  // Meet's own column breakpoints (meetGridColumns) are tuned for desktop
  // — e.g. 3 columns for 3 people. Applied on a narrow phone screen that
  // crams each tile into a sliver. Below the sm breakpoint, cap columns
  // at 2 instead so tiles stay a usable size and rows wrap normally.
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  useEffect(() => {
    const check = () => setIsNarrowViewport(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  const [maxVisibleTiles, setMaxVisibleTiles] = useState(DEFAULT_MAX_VISIBLE_TILES);

  const [timerRemaining, setTimerRemaining] = useState<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [reactions, setReactions] = useState<{ id: string; emoji: string; fromName: string }[]>([]);
  const [chatMessages, setChatMessages] = useState<
    { id: string; text: string; fromName: string; fromUserId: number; at: number }[]
  >([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const streamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // The raw camera track never changes once getUserMedia resolves;
  // activeVideoTrackRef is whichever track (raw, or the background
  // processor's composited one) is currently in localStream and being
  // sent to peers — see applyBackgroundEffect.
  const rawCameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const activeVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const bgProcessorRef = useRef<VirtualBackgroundProcessor | null>(null);
  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>({ type: "none" });

  const exitMeeting = useCallback(
    (reason: "left" | "removed" | "ended") => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      bgProcessorRef.current?.stop();
      router.push(`/meeting-ended/${token}?reason=${reason}`);
    },
    [router, token],
  );

  // Reconciles the participants roster against the database (the actual
  // source of truth, where leftAt gets correctly cleared the moment
  // someone rejoins) — both on a 5s poll AND, more importantly, called
  // directly the instant a peer:joined/peer:left socket event fires (see
  // the callbacks passed to useMeetingRoom below). That immediate call is
  // what actually fixes a refresh incorrectly showing someone as "left":
  // when a participant refreshes, their old socket disconnects
  // (broadcasting peer:left) before their new page finishes reconnecting
  // (broadcasting peer:joined back). Waiting for the next 5s poll tick to
  // self-correct that gap was visibly slow; fetching right away on either
  // event shrinks it to about as fast as the round trip allows.
  const refreshRoster = useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${token}`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (data.meeting?.endAt) {
        exitMeeting("ended");
        return;
      }
      if (Array.isArray(data.participants)) setParticipants(data.participants);
    } catch {
      // Transient network hiccup — the next poll tick (or the next
      // peer:joined/peer:left event) retries.
    }
  }, [token, exitMeeting]);

  useEffect(() => {
    if (!joined) return;
    const id = setInterval(() => void refreshRoster(), 5000);
    return () => clearInterval(id);
  }, [joined, refreshRoster]);

  // Fallback for join requests reaching the host: join-request:new is the
  // fast path (near-instant when the signaling connection is healthy),
  // but same reasoning as above — if the backend is slow to relay it,
  // the host had no way to find out short of refreshing the page
  // themselves, despite this endpoint's own comment claiming the socket
  // push made a re-fetch unnecessary. Polling every 3s (matching the
  // waiting-room side's own poll interval) keeps this to a few seconds
  // at most, regardless of the socket's timing, without needing a
  // manual refresh — merges by id so an eventually-arriving socket event
  // for the same request doesn't create a duplicate.
  useEffect(() => {
    if (!joined || !isHost) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/rooms/${token}/join-requests`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.requests)) return;
        setPendingRequests((prev) => {
          const known = new Set(prev.map((r) => r.id));
          const fresh = data.requests.filter((r: { id: number }) => !known.has(r.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      } catch {
        // Transient network hiccup — the next tick retries.
      }
    };
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [joined, isHost, token]);

  // Recovers chat history on join/refresh — without this, chatMessages
  // always started empty regardless of what was actually said earlier in
  // the meeting, since messages only ever arrived live over the socket
  // and nothing populated the initial state from what's already been
  // sent. Runs once per join, not on every render — chatMessages itself
  // isn't a dependency here on purpose, since new live messages append
  // to it locally and shouldn't re-trigger a full re-fetch.
  useEffect(() => {
    if (!joined) return;
    console.info("[Veyra] Fetching chat history for", token);
    (async () => {
      try {
        const res = await fetch(`/api/rooms/${token}/chat`, { headers: authHeaders() });
        console.info("[Veyra] Chat history response status:", res.status);
        if (!res.ok) {
          console.error(`[Veyra] Failed to load chat history: ${res.status}`, await res.json().catch(() => null));
          return;
        }
        const data = await res.json();
        console.info("[Veyra] Chat history payload:", data);
        if (Array.isArray(data.messages)) {
          console.info(`[Veyra] Loaded ${data.messages.length} chat message(s) from history`);
          setChatMessages(
            data.messages.map((m: { id: number; userId: number; fromName: string; text: string; at: number }) => ({
              id: `history-${m.id}`,
              text: m.text,
              fromName: m.fromName,
              fromUserId: m.userId,
              at: m.at,
            })),
          );
        } else {
          console.error("[Veyra] Chat history payload had no messages array:", data);
        }
      } catch (err) {
        // Chat still works live even if history fails to load — this
        // just means starting from an empty history — but logged
        // rather than silently swallowed, since a previous version of
        // this catch had no visibility into failures at all.
        console.error("[Veyra] Failed to load chat history", err);
      }
    })();
  }, [joined, token]);

  const livekitActive = Boolean(livekitUrl && livekitToken);
  const {
    connected: livekitConnected,
    connectError: livekitError,
    peers: livekitPeers,
    publishLocalStream,
    setLocalMuted,
    replaceCameraTrack,
    publishScreenShare,
    unpublishScreenShare,
    sendData: livekitSendData,
    room: livekitRoomInstance,
  } = useLiveKitRoom(livekitUrl, livekitToken);

  const {
    peers: socketPeers,
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
  } = useMeetingRoom(
    token,
    localStream,
    me?.id ?? null,
    {
      onForceMuted: () => {
        streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = false));
        setMicOn(false);
        setMicLocked(true);
        toast.info("The host muted you. You can't unmute yourself until the host allows it.");
      },
      onForceUnmuted: () => {
        // Only unlocks the button — does NOT turn the mic on for them.
        // Track stays disabled and micOn stays false until the
        // participant clicks their own mic button themselves.
        setMicLocked(false);
        toast.info("The host allowed your microphone — click the mic button to turn it on.");
      },
      onForceCameraOff: () => {
        streamRef.current?.getVideoTracks().forEach((track) => (track.enabled = false));
        setCameraOn(false);
        setCameraLocked(true);
        toast.info("The host turned off your camera. You can't turn it back on until the host allows it.");
      },
      onForceCameraOn: () => {
        // Only unlocks the button — does NOT turn the camera on for
        // them. Same reasoning as onForceUnmuted above.
        setCameraLocked(false);
        toast.info("The host allowed your camera — click the camera button to turn it on.");
      },
      onJoinRequest: (request) => {
        setPendingRequests((prev) =>
          prev.some((r) => r.id === request.requestId)
            ? prev
            : [...prev, { id: request.requestId, userId: request.userId, name: request.name, requestedAt: new Date().toISOString() }],
        );
        toast.info(`${request.name} is asking to join.`);
      },
      onPeerJoined: (peer) => {
        setParticipants((prev) => {
          const existing = prev.find((p) => p.userId === peer.userId);
          if (existing) {
            return prev.map((p) => p.userId === peer.userId ? { ...p, name: peer.name, isHost: Boolean(peer.isHost), isMuted: peer.isMuted ?? p.isMuted, isCameraOff: peer.isCameraOff ?? p.isCameraOff, leftAt: null } : p);
          }
          return [...prev, {
            userId: peer.userId,
            name: peer.name,
            isHost: Boolean(peer.isHost),
            isMuted: Boolean(peer.isMuted),
            isCameraOff: Boolean(peer.isCameraOff),
            joinedAt: new Date().toISOString(),
            leftAt: null,
          }];
        });
        // Belt-and-suspenders against a stale peer:left arriving out of
        // order after this — see refreshRoster's comment above.
        void refreshRoster();
      },
      onPeerLeft: ({ userId }) => {
        setParticipants((prev) => prev.map((p) => p.userId === userId ? { ...p, leftAt: new Date().toISOString() } : p));
        // If this "left" was actually just a refresh's old socket closing
        // (the new one may already be reconnecting), don't wait up to 5s
        // for the poll to notice they're still here — check right away.
        void refreshRoster();
      },
      onRemoved: () => {
        exitMeeting("removed");
      },
      onMeetingEnded: () => {
        exitMeeting("ended");
      },
      onReaction: (emoji, fromName) => {
        setReactions((prev) => [...prev, { id: Math.random().toString(36).slice(2), emoji, fromName }]);
      },
      onChatMessage: (msg) => {
        setChatMessages((prev) => [...prev, { id: `${msg.at}-${msg.fromUserId}-${Math.random()}`, ...msg }]);
      },
      onLayoutSettings: (value) => {
        setMaxVisibleTiles(value);
      },
    },
    joined,
    // Media rides on LiveKit whenever the server gave us a token; the
    // mesh is only the fallback for a deployment without LiveKit set up.
    !livekitActive,
    // Host-control events (mute/remove/camera-off, single or bulk, plus
    // meeting:ended) now ride LiveKit's data channel instead of the
    // socket when it's connected — see handleHostEvent in
    // useMeetingRoom.ts. Passing this even while !livekitConnected is
    // fine: the effect that attaches the listener just no-ops until it's
    // non-null.
    livekitRoomInstance,
  );

  // What the tiles consume: the socket roster (mic/camera/hand-raise/host
  // state) with each person's streams taken from LiveKit when it's in
  // charge of media. Same RemotePeer shape as before, so nothing
  // downstream had to change.
  const peers = useMemo<RemotePeer[]>(() => {
    if (!livekitActive) return socketPeers;
    // Structure (who exists, mic/camera on/off, streams) now comes from
    // LiveKit's own native participant + mute tracking, not the socket's
    // room:peers/peer:joined/peer:left/peer:media-state — those events
    // update socketPeers just as before, but socketPeers is no longer
    // the base here. handRaisedByUserId is genuinely decoupled from
    // socketPeers' own population (see its own comment in
    // useMeetingRoom.ts) — this doesn't depend on peer:joined having
    // created an entry there first.
    const participantsByUserId = new Map(participants.map((p) => [p.userId, p]));
    return livekitPeers.map((media) => {
      const dbInfo = participantsByUserId.get(media.userId);
      // media.userId resolves to 0 (see useLiveKitRoom's getOrCreateEntry,
      // Number(identity) || 0) specifically when the LiveKit identity
      // isn't a real userId at all — which is exactly what the analysis
      // agent's own, framework-assigned identity looks like, since it was
      // never minted through this app's own token flow. No real Veyra
      // user ever has userId 0 (Prisma's autoincrement starts at 1), so
      // this is an unambiguous, reliable way to detect it here — without
      // needing the agent to coordinate on a specific identity string.
      const isAgent = media.userId === 0;
      if (isAgent) {
        return {
          socketId: `lk-agent-${media.name || "veyra-ai"}`,
          userId: 0,
          name: "Veyra AI",
          stream: null,
          screenStream: null,
          cameraTrackId: null,
          cameraAudioTrackId: null,
          micOn: false,
          cameraOn: false,
          handRaised: false,
          isAgent: true,
        };
      }
      return {
        socketId: `lk-${media.userId}`,
        userId: media.userId,
        name: dbInfo?.name ?? media.name,
        stream: media.cameraActive ? media.cameraStream : null,
        screenStream: media.screenActive ? media.screenStream : null,
        cameraTrackId: null,
        cameraAudioTrackId: null,
        micOn: media.micEnabled,
        cameraOn: media.cameraEnabled,
        handRaised: handRaisedByUserId[media.userId] ?? false,
        isHost: dbInfo?.isHost ?? false,
        isMuted: dbInfo?.isMuted ?? false,
        isCameraOff: dbInfo?.isCameraOff ?? false,
      };
    });
  }, [livekitActive, socketPeers, livekitPeers, participants, handRaisedByUserId]);

  // Publish the lobby's own camera/mic tracks into the LiveKit room once
  // connected. micOn/cameraOn are read only for the INITIAL muted state
  // (so someone who joins with the camera off never flashes a frame);
  // later toggles are mirrored by the effect below.
  useEffect(() => {
    if (!livekitActive || !livekitConnected || !localStream) return;
    void publishLocalStream(localStream, { audio: !micOn, video: !cameraOn });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livekitActive, livekitConnected, localStream, publishLocalStream]);

  // Every mic/camera change — the user's own toggle, a host force-mute,
  // a remembered "off" preference — already lands in micOn/cameraOn, so
  // this one effect keeps LiveKit's muted state in step with all of them.
  useEffect(() => {
    if (!livekitActive || !livekitConnected) return;
    void setLocalMuted("audio", !micOn);
    void setLocalMuted("video", !cameraOn);
  }, [livekitActive, livekitConnected, micOn, cameraOn, setLocalMuted]);

  useEffect(() => {
    if (livekitError) {
      toast.error("Couldn't connect to the video server. Others may not see or hear you — try refreshing the page.");
    }
  }, [livekitError]);

  /**
   * What the lobby's "Join now" button actually does: calls the real join
   * endpoint (auto-rejoin logic — see that route's docs for why this is
   * safe to call even for a returning participant), and only flips
   * `joined` to true on success. `useMeetingRoom` doesn't connect its
   * socket until `joined` is true (see the `enabled` arg on that hook
   * call below), so nothing about the live call — WebRTC, roster
   * polling, the other participants seeing you — starts until this
   * succeeds. Before this point you're only ever previewing your own
   * camera locally; nobody else knows you're here yet.
   */
  const handleJoinFromLobby = async (hostUserId?: number) => {
    setJoiningRoom(true);
    try {
      const joinRes = await fetch("/api/rooms/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ token }),
      });
      const data = await joinRes.json().catch(() => ({}));

      if (joinRes.status === 202) {
        // Not pre-approved — the host has to admit us. Show the waiting
        // screen; the polling effect below takes it from here.
        setWaitingForAdmission(true);
        return;
      }
      if (!joinRes.ok) {
        if (joinRes.status === 410) {
          // Expired or already ended — the backend has already closed it
          // out (see /api/rooms/join's own comment). A toast here would
          // leave the person stuck looking at what's visually the full
          // meeting room UI (camera preview, controls) despite never
          // having actually joined anything — confusing, since nothing
          // in it would actually work. Send them to the same screen
          // anyone leaving a real, live-ended meeting sees instead.
          exitMeeting("ended");
          return;
        }
        toast.error(data.error ?? "Couldn't join this meeting.");
        return;
      }
      if (Array.isArray(data.participants)) setParticipants(data.participants);
      setMicLocked(Boolean(data.participant?.isMuted));
      setCameraLocked(Boolean(data.participant?.isCameraOff));
      if (data.participant?.isMuted) {
        streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = false));
        setMicOn(false);
      }
      if (data.participant?.isCameraOff) {
        streamRef.current?.getVideoTracks().forEach((track) => (track.enabled = false));
        setCameraOn(false);
      }
      if (data.meeting) {
        setLocked(Boolean(data.meeting.locked));
        setPasscodeSet(Boolean(data.meeting.passcodeSet));
        setMeetingTitle(data.meeting.title ?? null);
        if (data.meeting.durationMinutes) {
          const startedAt = new Date(data.meeting.scheduledAt ?? data.meeting.createdAt);
          setAutoEndAt(new Date(startedAt.getTime() + data.meeting.durationMinutes * 60_000));
        }
      }
      const fresh = new URLSearchParams(window.location.search).get("fresh") === "1";
      if (fresh && data.meeting?.hostId === (hostUserId ?? me?.id)) {
        setShowReadyCard(true);
        window.history.replaceState({}, "", window.location.pathname);
      }
      setLivekitUrl(typeof data.livekitUrl === "string" ? data.livekitUrl : null);
      setLivekitToken(typeof data.livekitToken === "string" ? data.livekitToken : null);
      setJoined(true);
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setJoiningRoom(false);
    }
  };

  // While waiting to be admitted, poll for a decision. This can't use
  // the meeting socket — that only accepts connections from people who
  // are already active participants, which we aren't yet — so a simple
  // poll is the reliable way to find out once the host decides.
  useEffect(() => {
    if (!waitingForAdmission) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/rooms/${token}/join-requests/mine`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "ADMITTED") {
          setWaitingForAdmission(false);
          const joinRes = await fetch("/api/rooms/join", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ token }),
          });
          if (joinRes.ok) {
            const joinedData = await joinRes.json().catch(() => ({}));
            if (Array.isArray(joinedData.participants)) setParticipants(joinedData.participants);
            setMicLocked(Boolean(joinedData.participant?.isMuted));
            setCameraLocked(Boolean(joinedData.participant?.isCameraOff));
            if (joinedData.participant?.isMuted) {
              streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = false));
              setMicOn(false);
            }
            if (joinedData.participant?.isCameraOff) {
              streamRef.current?.getVideoTracks().forEach((track) => (track.enabled = false));
              setCameraOn(false);
            }
            if (joinedData.meeting) {
              setLocked(Boolean(joinedData.meeting.locked));
              setPasscodeSet(Boolean(joinedData.meeting.passcodeSet));
            }
            setLivekitUrl(typeof joinedData.livekitUrl === "string" ? joinedData.livekitUrl : null);
            setLivekitToken(typeof joinedData.livekitToken === "string" ? joinedData.livekitToken : null);
            setJoined(true);
          }
        } else if (data.status === "DENIED") {
          setWaitingForAdmission(false);
          toast.error("The host didn't admit you to this meeting.");
          router.push("/dashboard");
        }
      } catch {
        // Transient network hiccup — the next poll tick retries.
      }
    };
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [waitingForAdmission, token, router]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const user = await checkAuth();
      if (cancelled) return;
      if (!user) {
        toast.error("Please sign in to continue.");
        router.push(`/login?next=${encodeURIComponent(`/room/${token}`)}`);
        return;
      }

      setMe(user);
      setCheckingAuth(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // 960x540 is a good local preview target for a mesh call: the
          // browser still adapts to the display, while camera capture and
          // encoding start with less CPU pressure than a 1280x720 request.
          video: { aspectRatio: { ideal: 16 / 9 }, width: { ideal: 960 }, height: { ideal: 540 } },
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        // getUserMedia always hands back enabled tracks — apply whatever
        // was remembered from before the refresh, using the state
        // variables above (already initialized from localStorage) rather
        // than re-reading it, so this stays in sync with what the rest
        // of the component believes micOn/cameraOn to be.
        stream.getAudioTracks().forEach((track) => (track.enabled = micOn));
        stream.getVideoTracks().forEach((track) => (track.enabled = cameraOn));
        streamRef.current = stream;
        setLocalStream(stream);
        const videoTrack = stream.getVideoTracks()[0] ?? null;
        rawCameraTrackRef.current = videoTrack;
        activeVideoTrackRef.current = videoTrack;
      } catch (err) {
        setCameraOn(false);
        setMicOn(false);
        const name = err instanceof Error ? err.name : "";
        if (name === "NotReadableError" || name === "TrackStartError") {
          // This is what actually happens when testing two participants
          // on the same machine with one physical webcam: the OS/browser
          // only lets one tab (or app) use a given camera at a time. This
          // isn't a bug to fix in code — it's a real hardware limit. The
          // second tab genuinely cannot get the camera while the first
          // tab holds it open, on any video-calling app, not just this
          // one. Testing multiple real cameras needs separate physical
          // devices (a phone + a computer, or two computers).
          toast.warning(
            "Your camera is already in use by another tab or app — only one can use it at a time. You can still join with camera off, or close the other tab using it.",
          );
        } else if (name === "NotFoundError") {
          toast.warning("No camera or microphone was found on this device. You can still join.");
        } else if (name === "NotAllowedError") {
          toast.warning("Camera/microphone permission was denied. You can still join with them off.");
        } else {
          toast.warning("Camera or microphone access was unavailable. You can still join the meeting.");
        }
      }

      // The host bypasses the participant lobby. This small access lookup
      // also avoids the old sequence of GET room -> POST join -> GET room:
      // once we know the host, the join response is used to populate the
      // roster directly.
      try {
        const res = await fetch(`/api/rooms/${token}`, {
          headers: authHeaders(),
          cache: "no-store",
        });

        if (cancelled) return;

        if (res.ok) {
          const data = await res.json();

          const userIsHost = data.meeting?.hostId === user.id;

          setIsHost(userIsHost);
          setHostCheckDone(true);

          if (userIsHost) {
            if (Array.isArray(data.participants)) {
              setParticipants(data.participants);
            }

            setLocked(Boolean(data.meeting?.locked));
            setPasscodeSet(Boolean(data.meeting?.passcodeSet));

            // Hosts bypass the participant lobby completely.
            // Pass the authenticated user's id directly so the fresh=1
            // ready-card check does not depend on asynchronous React state.
            void handleJoinFromLobby(user.id);
          }
        } else if (res.status === 404) {
          toast.error("That meeting doesn't exist.");
          router.push("/dashboard");
          return;
        } else {
          setHostCheckDone(true);
        }
      } catch {
        // Network hiccup — allow the normal participant flow to continue.
        setHostCheckDone(true);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      bgProcessorRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!joined) return;
    // The route itself 403s for a non-host caller, so this is safe to
    // fire unconditionally — it just quietly does nothing for everyone
    // else instead of needing to know our own host status this early.
    fetch(`/api/rooms/${token}/join-requests`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.requests) setPendingRequests(data.requests);
      })
      .catch(() => undefined);
  }, [joined, token]);

  const toggleMic = () => {
    if (micLocked) {
      toast.info("The host muted you — only the host can turn your mic back on.");
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;
    const next = !micOn;
    stream.getAudioTracks().forEach((track) => (track.enabled = next));
    setMicOn(next);
    window.localStorage.setItem("veyra:mic-pref", next ? "on" : "off");
    // LiveKit's own TrackMuted/TrackUnmuted already carries this to
    // everyone natively (see setLocalMuted below and useLiveKitRoom's
    // mute-state tracking) — this broadcast is only needed as the mesh
    // fallback's own signal now.
    if (!livekitActive) broadcastMediaState(next, cameraOn);
  };

  const toggleCamera = () => {
    if (cameraLocked) {
      toast.info("The host turned off your camera — only the host can turn it back on.");
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;
    const next = !cameraOn;
    stream.getVideoTracks().forEach((track) => (track.enabled = next));
    setCameraOn(next);
    window.localStorage.setItem("veyra:camera-pref", next ? "on" : "off");
    if (!livekitActive) broadcastMediaState(micOn, next);
  };

  // Sends the new camera track to everyone: one LiveKit replaceTrack when
  // LiveKit carries media, otherwise the mesh's per-connection swap.
  // Resolves once the swap has actually happened, so the processor being
  // replaced is only stopped after that (see the "none" branch below).
  const swapOutgoingCameraTrack = (oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack): Promise<unknown> => {
    if (livekitActive) return replaceCameraTrack(newTrack);
    replaceLocalVideoTrack(oldTrack, newTrack);
    return Promise.resolve();
  };

  /**
   * Switches the active background effect (none/blur/a gradient
   * template). "none" reverts to the raw camera track and tears the
   * processor down; anything else lazily creates the processor on first
   * use and reuses it after that (switching between two non-none effects
   * doesn't need a new track — see VirtualBackgroundProcessor.start).
   *
   * Every switch that actually changes which track is live updates three
   * things together: localStream itself (so the local preview picks it
   * up — VideoTile's addtrack listener handles the rest), every current
   * outgoing track (swapOutgoingCameraTrack — LiveKit, or every mesh peer
   * connection as the fallback), and activeVideoTrackRef (so
   * the next switch knows what it's replacing).
   */
  const applyBackgroundEffect = async (effect: BackgroundEffect) => {
    const stream = streamRef.current;
    const rawTrack = rawCameraTrackRef.current;
    const currentTrack = activeVideoTrackRef.current;
    if (!stream || !rawTrack || !currentTrack) return;

    if (effect.type === "none") {
      // Order matters here: swap every peer connection off the
      // processed track FIRST, stop it only AFTER. Stopping it first
      // (the previous order) risked the RTP sender's outgoing pipeline
      // stalling on a track that had already ended before replaceTrack
      // got a chance to hand it a live one — which is what froze a
      // remote participant's view on the last blurred frame instead of
      // it reverting to the live camera when blur was turned back off.
      let swapped: Promise<unknown> = Promise.resolve();
      if (currentTrack !== rawTrack) {
        stream.removeTrack(currentTrack);
        stream.addTrack(rawTrack);
        swapped = swapOutgoingCameraTrack(currentTrack, rawTrack);
        rawTrack.enabled = cameraOn;
        activeVideoTrackRef.current = rawTrack;
      }
      const retiring = bgProcessorRef.current;
      bgProcessorRef.current = null;
      void swapped.finally(() => retiring?.stop());
      setBackgroundEffect(effect);
      return;
    }

    try {
      if (!bgProcessorRef.current) {
        // Dynamic import, not a static one at the top of the file — this
        // is what keeps @mediapipe/tasks-vision out of the room page's
        // normal build-time module graph, only pulled in (as its own
        // chunk, at runtime) the first time someone actually opens a
        // background effect, not just because the room page exists.
        const { VirtualBackgroundProcessor } = await import("@/lib/virtualBackground");
        bgProcessorRef.current = new VirtualBackgroundProcessor(rawTrack);
      }
      const processedTrack = await bgProcessorRef.current.start(effect);
      if (currentTrack !== processedTrack) {
        stream.removeTrack(currentTrack);
        stream.addTrack(processedTrack);
        void swapOutgoingCameraTrack(currentTrack, processedTrack);
        processedTrack.enabled = cameraOn;
        activeVideoTrackRef.current = processedTrack;
      }
      setBackgroundEffect(effect);
    } catch (err) {
      console.error("Failed to start background effect:", err);
      toast.error("Couldn't start that background effect — your camera keeps working normally.");
    }
  };

  const handleToggleHandRaise = () => {
    const next = !handRaised;
    setHandRaised(next);
    // Own hand-raise state (above) is already a direct local update
    // regardless of transport, so this only needs to broadcast it to
    // everyone else — no separate "update my own UI" step needed here
    // the way handleReact below needs one.
    if (livekitActive && me) {
      livekitSendData("peer:hand-raised", { userId: me.id, raised: next });
    } else {
      broadcastHandRaise(next);
    }
    toast.info(next ? "You raised your hand." : "You lowered your hand.");
  };

  /**
   * Live captions of your OWN speech via the browser's built-in
   * SpeechRecognition (Web Speech API) — Chrome/Edge only, no external
   * service required, which is also its limit: it only captions the
   * local mic, not other participants' audio (captioning remote WebRTC
   * audio streams would need a server-side transcription service this
   * app doesn't have configured).
   */
  const toggleCaptions = () => {
    if (captionsOn) {
      const recognition = recognitionRef.current;
      recognitionRef.current = null; // clear first so onend below doesn't auto-restart
      recognition?.stop();
      setCaptionsOn(false);
      setCaptionText("");
      return;
    }

    const SpeechRecognitionCtor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionInstance }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionInstance }).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      toast.error("Captions need Chrome or Edge — not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let consecutiveFailures = 0;

    recognition.onresult = (event) => {
      consecutiveFailures = 0; // a real result came back — recognition is working
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setCaptionText(transcript);
    };
    recognition.onerror = (event) => {
      // "no-speech"/"aborted" are normal transient hiccups — onend below
      // restarts recognition automatically while captions are still on.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast.error("Captions need microphone access — check your browser's site permissions.");
        recognitionRef.current = null;
        setCaptionsOn(false);
        return;
      }
      if (event.error === "network") {
        // Chrome's built-in recognition is cloud-based — it needs a live
        // connection to Google's speech service even though it's
        // captioning local audio. This is the most common real-world
        // failure and was previously swallowed silently (captions stayed
        // "on" forever with nothing appearing) — now it's surfaced.
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          toast.error("Captions can't reach the speech service — check your internet connection.");
          recognitionRef.current = null;
          setCaptionsOn(false);
        }
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current) {
        try {
          recognition.start();
        } catch {
          // Already running, or the browser refused to restart it — stop
          // trying rather than loop silently forever.
          recognitionRef.current = null;
          setCaptionsOn(false);
        }
      }
    };
    try {
      recognition.start();
    } catch {
      toast.error("Couldn't start captions — try toggling them off and on again.");
      return;
    }
    recognitionRef.current = recognition;
    setCaptionsOn(true);
    toast.success("Captions on — captioning your own speech.");
  };

  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition?.stop();
    };
  }, []);

  const cycleLayout = () => {
    const next = layoutMode === "auto" ? "spotlight" : "auto";
    setLayoutMode(next);
    toast.info(next === "spotlight" ? "Layout: Spotlight" : "Layout: Auto");
  };

  const startTimer = async () => {
    const input = await promptToast("Countdown length in minutes:", "5");
    if (input === null) return;
    const minutes = Number(input);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      toast.error("Enter a whole number of minutes greater than 0.");
      return;
    }
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    setTimerRemaining(Math.round(minutes * 60));
    timerIntervalRef.current = setInterval(() => {
      setTimerRemaining((prev) => {
        if (prev === null || prev <= 1) {
          if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
          toast.info("Timer's up.");
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    toast.success(`Timer started for ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  };

  const stopTimer = () => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = null;
    setTimerRemaining(null);
  };

  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const handleChangeLayoutSettings = (value: number) => {
    // Updates locally directly, not via the broadcast echoing back —
    // unlike reactions/hand-raise, this setting previously had NO other
    // path to update the host's own UI at all (setMaxVisibleTiles was
    // only ever called from the received-broadcast callback), so
    // self-filtering a LiveKit-sent copy the way reactions does would
    // have left the host's own tile-count change never actually apply.
    setMaxVisibleTiles(value);
    if (livekitActive) {
      livekitSendData("meeting:layout-settings", { maxVisibleTiles: value });
    } else {
      broadcastLayoutSettings(value);
    }
  };

  const handleReact = (emoji: string) => {
    if (livekitActive && me) {
      // Unlike the socket path (which relies on the server echoing the
      // reaction back to everyone including the sender — see
      // server.ts), LiveKit's client-to-client publishData path can't
      // assume that, so this adds it locally directly. The receiving
      // listener (useMeetingRoom's handleRealtimeEvent dispatch) filters
      // out self-originated messages specifically so this can't ever
      // become a double-add, regardless of whether LiveKit actually
      // loops a sender's own message back to them or not.
      const fromName = me.name ?? "Someone";
      livekitSendData("peer:reaction", { emoji, name: fromName }, { reliable: false });
      setReactions((prev) => [...prev, { id: Math.random().toString(36).slice(2), emoji, fromName }]);
      return;
    }
    // The server echoes reactions back to everyone including the sender
    // (see server.ts), so this alone is enough — no need to also add it
    // locally here, which would show your own reaction twice.
    sendReaction(emoji);
  };

  // Each reaction bubble clears itself after a few seconds.
  useEffect(() => {
    if (reactions.length === 0) return;
    const timer = setTimeout(() => setReactions((prev) => prev.slice(1)), 3000);
    return () => clearTimeout(timer);
  }, [reactions]);

  const peerCount = peers.length;
  useEffect(() => {
    // Deliberately includes micOn/cameraOn in the dependency array (no
    // eslint-disable here) — leaving them out was a real bug: this
    // effect could fire (e.g. right as a new peer connects, which
    // happens a lot during the renegotiation activity screen-sharing
    // triggers) using a stale closure over an older cameraOn/micOn
    // value, re-broadcasting "camera on" moments after a correct
    // "camera off" had already gone out. Receivers would then show the
    // video element (since their copy of cameraOn said true again)
    // while the actual track stayed disabled — producing a black tile
    // instead of the avatar fallback.
    if (!livekitActive && connected) broadcastMediaState(micOn, cameraOn);
  }, [peerCount, connected, micOn, cameraOn, broadcastMediaState, livekitActive]);

  const stopScreenShare = useCallback(() => {
    const display = screenStreamRef.current;
    const tracks = display?.getTracks() ?? [];
    if (livekitActive) {
      if (display) void unpublishScreenShare(display);
    } else {
      tracks.forEach((t) => removeScreenShareTrack(t));
      broadcastScreenShareState(false);
    }
    tracks.forEach((t) => t.stop());
    screenStreamRef.current = null;
    setSharingScreen(false);
    setScreenStream(null);
  }, [livekitActive, unpublishScreenShare, removeScreenShareTrack, broadcastScreenShareState]);

  const startScreenShare = async () => {
    setShowShareWarning(false);
    try {
      // selfBrowserSurface: "exclude" removes THIS tab from the browser's
      // own share picker (supported in current Chrome/Edge) — this is
      // what actually prevents the recursive mirror, not just warns about
      // it: if the tab running this meeting isn't offered as an option,
      // it can't be selected. Ignored harmlessly on browsers that don't
      // support the option, which is why the warning dialog before this
      // call still exists as a fallback for those.
      //
      // audio: true is what makes Chrome/Edge offer the "Share tab audio"
      // checkbox at all when the person picks a Chrome Tab in the native
      // picker — without requesting it here, that option never appears.
      // It's ignored (no audio track comes back) for Window/Entire Screen
      // sources, which is a browser limitation, not something this app
      // controls.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        selfBrowserSurface: "exclude",
      } as DisplayMediaStreamOptions);
      const screenTrack = display.getVideoTracks()[0];
      const screenAudioTrack = display.getAudioTracks()[0] ?? null;
      screenStreamRef.current = display;
      setSharingScreen(true);
      setScreenStream(display);
      // Published as its own screen-share track(s), not a replacement for
      // the camera track — this is what makes the screen show up as its
      // own tile for everyone else (matching Meet), with your camera
      // still showing normally alongside it, instead of your screen
      // taking over your camera's slot.
      if (livekitActive) {
        void publishScreenShare(display);
      } else {
        addScreenShareTrack(screenTrack, display);
        if (screenAudioTrack) addScreenShareTrack(screenAudioTrack, display);
        broadcastScreenShareState(true);
      }
      // The browser's own native "Stop sharing" control also needs to revert us.
      screenTrack.onended = stopScreenShare;
      toast.success(screenAudioTrack ? "Sharing your screen, with audio." : "Sharing your screen.");
    } catch {
      // Picker cancelled, or permission denied — not worth an error toast.
    }
  };

  // "Present something else" from the control bar's presenting menu —
  // cleanly tears down the current share and immediately reopens the
  // picker for a new source, instead of the person having to stop, close
  // the menu, and click Share screen again themselves.
  const presentSomethingElse = () => {
    stopScreenShare();
    void startScreenShare();
  };

  const handleScreenShareClick = () => {
    if (sharingScreen) {
      stopScreenShare();
      toast.info("Stopped sharing your screen.");
      return;
    }
    if (livekitActive && !livekitConnected) {
      toast.info("Still connecting to the video server — try again in a moment.");
      return;
    }
    // Don't jump straight to the OS picker — warn first. Sharing this
    // browser's own tab/window creates a recursive "infinite mirror"
    // (the shared video showing itself, showing itself...), which is
    // confusing and expensive to render. The picker itself can't be
    // restricted from here, so this is a heads-up, not a hard block.
    setShowShareWarning(true);
  };

  const handleLeave = async () => {
    if (leaving) return; // guards against a rapid double-click firing before the disabled state re-renders
    setLeaving(true);
    try {
      const res = await fetch("/api/rooms/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't leave the meeting.");
        return;
      }
      toast.success("You left the meeting.");
      exitMeeting("left");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLeaving(false);
    }
  };

  const handleMuteParticipant = async (userId: number) => {
    try {
      const res = await fetch(`/api/rooms/${token}/participants/${userId}/mute`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't mute that participant.");
      setParticipants((prev) => prev.map((p) => p.userId === data.userId ? { ...p, isMuted: Boolean(data.muted) } : p));
      toast.success(data.muted ? "Participant muted." : "Participant unmuted.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleCameraOffParticipant = async (userId: number) => {
    try {
      const res = await fetch(`/api/rooms/${token}/participants/${userId}/camera-off`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't turn off that participant's camera.");
      setParticipants((prev) => prev.map((p) => p.userId === data.userId ? { ...p, isCameraOff: Boolean(data.cameraOff) } : p));
      toast.success(data.cameraOff ? "Camera turned off." : "Camera turned on.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleMuteAll = async () => {
    try {
      const res = await fetch(`/api/rooms/${token}/mute-all`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't mute everyone.");
      setParticipants((prev) => prev.map((p) => p.isHost ? p : { ...p, isMuted: true }));
      toast.success("Muted everyone.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleUnmuteAll = async () => {
    try {
      const res = await fetch(`/api/rooms/${token}/unmute-all`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't unmute everyone.");
      setParticipants((prev) => prev.map((p) => p.isHost ? p : { ...p, isMuted: false }));
      toast.success("Allowed microphones for everyone.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleCameraOffAll = async () => {
    try {
      const res = await fetch(`/api/rooms/${token}/camera-off-all`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't turn off everyone's camera.");
      setParticipants((prev) => prev.map((p) => p.isHost ? p : { ...p, isCameraOff: true }));
      toast.success("Turned off everyone's camera.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleCameraOnAll = async () => {
    try {
      const res = await fetch(`/api/rooms/${token}/camera-on-all`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't turn on everyone's camera.");
      setParticipants((prev) => prev.map((p) => p.isHost ? p : { ...p, isCameraOff: false }));
      toast.success("Allowed cameras for everyone.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleAdmit = async (requestId: number) => {
    // Deliberately NOT removed from local state until the request
    // actually succeeds — removing it optimistically meant that any
    // failed admit call left the card gone locally while the request
    // was still PENDING in the database, and the join-request polling
    // fallback (see the effect above) would then re-discover it as a
    // "new" request a few seconds later, reappearing indefinitely
    // even though nothing had actually changed. Keeping the card
    // visible until success is confirmed means a failure just shows an
    // error and lets the host retry, instead of a confusing
    // disappear-then-reappear loop.
    try {
      const res = await fetch(`/api/rooms/${token}/join-requests/${requestId}/admit`, { method: "POST", headers: authHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Couldn't admit that person.");
        return;
      }
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleDeny = async (requestId: number) => {
    // Same reasoning as handleAdmit above.
    try {
      const res = await fetch(`/api/rooms/${token}/join-requests/${requestId}/deny`, { method: "POST", headers: authHeaders() });
      if (!res.ok) {
        toast.error("Couldn't deny that request. Check your connection and try again.");
        return;
      }
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleInvite = async () => {
    const emails = inviteInput
      .split(/[,\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length === 0) return;
    setInviting(true);
    try {
      const res = await fetch(`/api/rooms/${token}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ emails }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't send that invite.");
        return;
      }
      if (data.emailsFailed?.length) {
        toast.warning(
          `Added to the invite list, but the email didn't send for: ${data.emailsFailed.join(", ")}. Check the backend terminal for the SMTP error, or share the link with them directly.`,
        );
      } else {
        toast.success(emails.length === 1 ? "Invited." : `Invited ${emails.length} people.`);
      }
      setInviteInput("");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveParticipant = async (userId: number) => {
    const target = participants.find((participant) => participant.userId === userId);
    if (!(await confirmToast(`Remove ${target?.name ?? "this participant"} from the meeting?`, "Remove"))) return;
    try {
      const res = await fetch(`/api/rooms/${token}/participants/${userId}/remove`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't remove that participant.");
      toast.success("Participant removed.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleToggleLock = async () => {
    const next = !locked;
    try {
      const res = await fetch(`/api/rooms/${token}/lock`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ locked: next }),
      });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't change meeting access.");
      setLocked(next);
      toast.success(next ? "Meeting locked — new participants can't join." : "Meeting unlocked.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleSetPasscode = async () => {
    const input = await promptToast(
      passcodeSet
        ? "Change the meeting passcode (leave blank to remove it):"
        : "Set a meeting passcode (at least 4 characters):",
    );
    if (input === null) return; // cancelled
    try {
      const res = await fetch(`/api/rooms/${token}/passcode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ passcode: input.trim() === "" ? null : input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't update the passcode.");
      setPasscodeSet(data.meeting.passcodeSet);
      toast.success(data.meeting.passcodeSet ? "Passcode set." : "Passcode removed.");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const handleEndMeeting = async () => {
    if (!(await confirmToast("End this meeting for everyone?", "End for everyone"))) return;
    setEnding(true);
    try {
      const res = await fetch(`/api/rooms/${token}/end`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return toast.error(data.error ?? "Couldn't end the meeting.");
      toast.success("Meeting ended for everyone.");
      exitMeeting("ended");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setEnding(false);
    }
  };

  const setActivePanel = (next: Panel) => setPanel((current) => (current === next ? null : next));

  const myRow = participants.find((participant) => participant.userId === me?.id);

  // Auto-ends the meeting once its duration limit (if any) is reached.
  // Host-only — every participant computes the same autoEndAt locally,
  // but only the host is allowed to actually call the end endpoint (the
  // API itself also enforces this; gating here just avoids every other
  // participant firing a request that's going to 403 anyway). A single
  // precisely-timed setTimeout rather than polling: the deadline is a
  // known fixed point the moment autoEndAt is set, so there's nothing to
  // repeatedly check against — just wait exactly that long.
  useEffect(() => {
    if (!autoEndAt || !joined || autoEndTriggered || !myRow?.isHost) return;
    const remaining = autoEndAt.getTime() - Date.now();
    const id = window.setTimeout(
      () => {
        setAutoEndTriggered(true);
        (async () => {
          try {
            const res = await fetch(`/api/rooms/${token}/end`, { method: "POST", headers: authHeaders() });
            if (res.ok) {
              toast.info("This meeting's time limit was reached — ending for everyone.");
              exitMeeting("ended");
            }
          } catch {
            // Transient failure — the meeting just keeps running; nothing
            // else here depends on this succeeding on the first try, and
            // the host can still end it manually if it didn't go through.
          }
        })();
      },
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(id);
  }, [autoEndAt, joined, autoEndTriggered, myRow?.isHost, token, exitMeeting]);

  // Warns the host 5 minutes before the duration limit ends the meeting
  // — host-only, same reasoning as the auto-end effect above (every
  // participant computes the same autoEndAt, but only the host needs
  // the heads-up, since only the host's screen is where the countdown
  // actually matters). If there's already less than 5 minutes left by
  // the time this schedules (e.g. the host reconnects close to the
  // deadline), skip the warning entirely rather than firing it
  // immediately right before the meeting ends anyway — the end itself
  // still happens on schedule regardless.
  useEffect(() => {
    if (!autoEndAt || !joined || durationWarningShown || !myRow?.isHost) return;
    const warnAt = autoEndAt.getTime() - 5 * 60_000;
    const remaining = warnAt - Date.now();
    if (remaining <= 0) return;
    const id = window.setTimeout(() => {
      setDurationWarningShown(true);
      // Longer than the default toast duration (3.5s) — this is worth
      // actually noticing, not something to catch out of the corner of
      // an eye and miss.
      toast.warning("This meeting will end automatically in 5 minutes (time limit reached).", 10000);
    }, remaining);
    return () => window.clearTimeout(id);
  }, [autoEndAt, joined, durationWarningShown, myRow?.isHost]);

  const others = participants.filter((participant) => participant.userId !== me?.id && !participant.leftAt);
  // The AI agent is deliberately NOT part of the video grid at all — see
  // the small header badge further down instead (agentPeer, used there).
  // A full participant-sized tile for something that never has a camera
  // or mic reads as a broken/empty tile more than a helpful presence
  // indicator — the badge is the Google Meet "Gemini" pattern this is
  // modeled on: a small, unobtrusive marker, not a seat in the grid.
  const agentPeer = peers.find((p) => p.isAgent);
  const liveByUserId = useMemo(() => new Map(peers.map((peer) => [peer.userId, peer])), [peers]);
  // Deliberately NOT the same as `others` — a participant's DB row only
  // ever gets leftAt set by an explicit action (clicking Leave, the host
  // ending the meeting, a fresh roster poll eventually catching up).
  // Someone who just closes their tab or loses their connection leaves
  // no such signal behind, so their row can sit there looking "active"
  // indefinitely even though they're not actually connected to anything
  // anymore. Every visible/counted use of "who's here" below is filtered
  // through this — an entry only counts if it ALSO has a live LiveKit
  // peer — specifically to stop a stale DB row from rendering a tile, or
  // counting toward the participant badge, for someone who's actually
  // long gone.
  const liveOthers = others.filter((p) => liveByUserId.has(p.userId));
  const totalTiles = liveOthers.length + 1;
  const spotlightFeatured = liveOthers.find((p) => p.isHost) ?? liveOthers[0] ?? null;
  // Whoever's screen should be the big tile right now — either mine, or
  // the first other participant currently sharing theirs. Meet only ever
  // shows one screen share at a time in practice, so "first" is fine.
  const remotePresenter = others.find(
    (participant) => liveByUserId.get(participant.userId)?.screenStream,
  );
  const presentingStream = sharingScreen
    ? screenStream
    : remotePresenter
      ? (liveByUserId.get(remotePresenter.userId)?.screenStream ?? null)
      : null;
  const presentingName = sharingScreen ? "Your screen" : remotePresenter ? `${remotePresenter.name}'s screen` : "";
  const activeParticipantCount = liveOthers.length + 1;

  if (checkingAuth || !me) {
    return <LoadingScreen message="Loading..." />;
  }

  if (!hostCheckDone) {
    return <LoadingScreen message="Joining meeting..." />;
  }

  if (!joined && !isHost) {
    return (
      <div className="relative flex h-dvh flex-col overflow-hidden bg-[#0f1012] text-white">
        <header className="flex items-center justify-between px-6 py-5 sm:px-10">
          <BrandLink size={22} />
        </header>

        <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 pb-10 sm:flex-row sm:gap-12">
          <div className="relative h-[280px] w-full max-w-xl overflow-hidden rounded-2xl bg-[#171A21] sm:h-[360px]">
            <VideoTile
              name={me.name ?? me.email}
              isMuted={!micOn}
              cameraOn={cameraOn}
              stream={localStream}
              isLocal
              mirrored
            />
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2">
              <button
                onClick={toggleMic}
                aria-label={micOn ? "Turn off microphone" : "Turn on microphone"}
                className={`flex h-11 w-11 items-center justify-center rounded-full ${micOn ? "bg-white/10 hover:bg-white/15" : "bg-[#ea4335] hover:bg-[#d93025]"}`}
              >
                {micOn ? <Mic size={18} /> : <MicOff size={18} />}
              </button>
              <button
                onClick={toggleCamera}
                aria-label={cameraOn ? "Turn off camera" : "Turn on camera"}
                className={`flex h-11 w-11 items-center justify-center rounded-full ${cameraOn ? "bg-white/10 hover:bg-white/15" : "bg-[#ea4335] hover:bg-[#d93025]"}`}
              >
                {cameraOn ? <Video size={18} /> : <VideoOff size={18} />}
              </button>
            </div>
          </div>

          <div className="flex w-full max-w-sm flex-col items-center text-center sm:items-start sm:text-left">
            <h1 className="font-display text-2xl font-semibold">
              {waitingForAdmission ? "Asking to join..." : "Ready to join?"}
            </h1>
            <p className="mt-1 text-sm text-white/50">{token}</p>
            {waitingForAdmission ? (
              <p className="mt-6 text-sm text-white/60">
                Waiting for the host to let you in. This page will move on automatically once
                they respond.
              </p>
            ) : (
              <button
                onClick={() => void handleJoinFromLobby()}
                disabled={joining}
                className="mt-6 rounded-full bg-accent px-8 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {joining ? "Joining..." : "Join now"}
              </button>
            )}
          </div>
        </main>
        {showReadyCard && (
          <ReadyMeetingCard token={token} inviteInput={inviteInput} setInviteInput={setInviteInput} inviting={inviting} handleInvite={handleInvite} linkCopied={linkCopied} setLinkCopied={setLinkCopied} onClose={() => setShowReadyCard(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-dvh overflow-hidden bg-[#0f1012] text-white">
      <header className="absolute inset-x-0 top-0 z-20 flex h-16 items-center justify-between px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-medium text-white sm:text-base">{formatTime(now)}</span>
          <span className="text-white/35">|</span>
          <span className="max-w-[180px] truncate text-sm font-medium text-white/85 sm:max-w-none">{meetingTitle || token}</span>
          <span className={`h-2 w-2 rounded-full ${(livekitActive ? livekitConnected : connected) ? "bg-emerald-400" : "bg-amber-400"}`} title={(livekitActive ? livekitConnected : connected) ? "Connected" : "Connecting"} />
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {sharingScreen && (
            <div className="hidden items-center gap-2 rounded-full bg-white/[0.06] pl-3 pr-1 py-1 sm:flex">
              <span className="text-xs font-medium text-white/85">You&apos;re presenting</span>
              <button
                onClick={presentSomethingElse}
                className="rounded-full px-3 py-1.5 text-xs font-medium text-white/75 hover:bg-white/10 hover:text-white"
              >
                Present something else
              </button>
              <button
                onClick={handleScreenShareClick}
                className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                Stop presenting
              </button>
            </div>
          )}
          {agentPeer && (
            <div
              className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5"
              title="Veyra's AI meeting assistant is present, silently analyzing the conversation"
            >
              <Bot size={14} className="text-accent" />
              <span className="text-xs font-medium text-accent">Veyra AI</span>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-full bg-white/[0.06] pl-1.5 pr-2.5 py-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-xs font-semibold">{initials(me.name ?? me.email)}</div>
            <span className="text-xs font-medium text-white/75">{activeParticipantCount}</span>
          </div>
        </div>
      </header>

      <main className="absolute inset-x-0 top-16 bottom-24 overflow-hidden bg-[#0f1012] px-4 py-4 sm:top-20 sm:bottom-28 sm:px-8 sm:py-6">
        {presentingStream ? (
          // Meet-style presenting layout: the shared content takes the
          // main area, and every camera (including the presenter's own)
          // lines up in a strip alongside it — a vertical column on
          // larger screens, a horizontal scrollable row along the bottom
          // on narrow ones. Unlike the old floating-thumbnail approach
          // this isn't capped at 3 people — the strip just scrolls.
          <div className="flex h-full w-full flex-col gap-2 sm:flex-row sm:gap-3">
            <div className="min-h-0 flex-1">
              <VideoTile name={presentingName} cameraOn stream={presentingStream} rounded={false} fit="contain" isLocal={sharingScreen} />
            </div>
            <div className="flex h-24 shrink-0 gap-2 overflow-x-auto sm:h-full sm:w-64 sm:flex-col sm:gap-3 sm:overflow-y-auto sm:overflow-x-visible">
              <div className="aspect-video h-full shrink-0 sm:aspect-auto sm:w-full sm:min-h-[110px] sm:flex-1">
                <VideoTile
                  name={`${me.name ?? me.email} (You)`}
                  isHost={myRow?.isHost ?? false}
                  isMuted={!micOn}
                  cameraOn={cameraOn}
                  stream={localStream}
                  isLocal
                  mirrored
                  handRaised={handRaised}
                />
              </div>
              {liveOthers.map((participant) => {
                const live = liveByUserId.get(participant.userId);
                return (
                  <div key={participant.userId} className="aspect-video h-full shrink-0 sm:aspect-auto sm:w-full sm:min-h-[110px] sm:flex-1">
                    <VideoTile
                      name={participant.name}
                      isHost={participant.isHost}
                      isMuted={live ? !live.micOn : participant.isMuted}
                      cameraOn={live ? live.cameraOn : false}
                      stream={live?.stream ?? null}
                      handRaised={live?.handRaised ?? false}
                      isAgent={live?.isAgent ?? false}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : totalTiles === 1 ? (
          // Solo view — a real 16:9 box centered in the available space,
          // matching the camera's own requested aspect ratio (see the
          // getUserMedia call above). `h-full` gives the box an actual
          // sizing basis before aspect-ratio kicks in — without it (just
          // max-h-full/max-w-full, no base dimension), the box has nothing
          // to size itself from and collapses to fit its content instead
          // of filling the space, which is what produced a tiny
          // shrunken avatar when the camera was off.
          <div className="flex h-full w-full items-center justify-center">
            <div className="aspect-video h-full max-w-full">
              <VideoTile
                name={`${me.name ?? me.email} (You)`}
                isHost={myRow?.isHost ?? false}
                isMuted={!micOn}
                cameraOn={cameraOn}
                stream={localStream}
                isLocal
                mirrored
                handRaised={handRaised}
              />
            </div>
          </div>
        ) : layoutMode === "spotlight" ? (
          <div className="flex h-full w-full flex-col gap-2 p-2 sm:gap-3 sm:p-3">
            <div className="min-h-0 flex-1">
              {spotlightFeatured ? (
                (() => {
                  const live = liveByUserId.get(spotlightFeatured.userId);
                  return (
                    <VideoTile
                      name={spotlightFeatured.name}
                      isHost={spotlightFeatured.isHost}
                      isMuted={live ? !live.micOn : spotlightFeatured.isMuted}
                      cameraOn={live ? live.cameraOn : false}
                      stream={live?.stream ?? null}
                      handRaised={live?.handRaised ?? false}
                    />
                  );
                })()
              ) : (
                <VideoTile
                  name={`${me.name ?? me.email} (You)`}
                  isHost={myRow?.isHost ?? false}
                  isMuted={!micOn}
                  cameraOn={cameraOn}
                  stream={localStream}
                  isLocal
                  mirrored
                  handRaised={handRaised}
                />
              )}
            </div>
            <div className="flex h-20 shrink-0 gap-2 overflow-x-auto sm:h-24 sm:gap-3">
              {spotlightFeatured && (
                <div className="aspect-video h-full shrink-0">
                  <VideoTile
                    name={`${me.name ?? me.email} (You)`}
                    isHost={myRow?.isHost ?? false}
                    isMuted={!micOn}
                    cameraOn={cameraOn}
                    stream={localStream}
                    isLocal
                    mirrored
                    handRaised={handRaised}
                  />
                </div>
              )}
              {liveOthers
                .filter((participant) => participant.userId !== spotlightFeatured?.userId)
                .map((participant) => {
                  const live = liveByUserId.get(participant.userId);
                  return (
                    <div key={participant.userId} className="aspect-video h-full shrink-0">
                      <VideoTile
                        name={participant.name}
                        isHost={participant.isHost}
                        isMuted={live ? !live.micOn : participant.isMuted}
                        cameraOn={live ? live.cameraOn : false}
                        stream={live?.stream ?? null}
                        handRaised={live?.handRaised ?? false}
                        isAgent={live?.isAgent ?? false}
                      />
                    </div>
                  );
                })}
            </div>
          </div>
        ) : (
          (() => {
            const meTile = {
              key: "me",
              node: (
                <VideoTile
                  name={`${me.name ?? me.email} (You)`}
                  isHost={myRow?.isHost ?? false}
                  isMuted={!micOn}
                  cameraOn={cameraOn}
                  stream={localStream}
                  isLocal
                  mirrored
                  handRaised={handRaised}
                  rounded={false}
                />
              ),
            };
            const otherTiles = liveOthers.map((participant) => {
              const live = liveByUserId.get(participant.userId);
              return {
                key: String(participant.userId),
                node: (
                  <VideoTile
                    name={participant.name}
                    isHost={participant.isHost}
                    isMuted={live ? !live.micOn : participant.isMuted}
                    cameraOn={live ? live.cameraOn : false}
                    stream={live?.stream ?? null}
                    handRaised={live?.handRaised ?? false}
                    isAgent={live?.isAgent ?? false}
                    rounded={false}
                  />
                ),
              };
            });
            const allTiles = [meTile, ...otherTiles];
            // Cap at maxVisibleTiles (host-adjustable, default 9),
            // exactly like Meet's own tiled view: past that, people stay
            // fully connected — audio, video, the participant list —
            // just not drawn as a tile, with a "+N more" cell standing
            // in for them instead of the grid silently overflowing or
            // shrinking tiles unreadably.
            const overflowCount = Math.max(0, allTiles.length - maxVisibleTiles);
            const visibleTiles = overflowCount > 0 ? allTiles.slice(0, maxVisibleTiles - 1) : allTiles;
            const cellCount = visibleTiles.length + (overflowCount > 0 ? 1 : 0);
            const cols = isNarrowViewport ? mobileGridColumns(cellCount) : meetGridColumns(cellCount);

            return (
              <div
                className="absolute inset-0 grid auto-rows-fr gap-1 sm:gap-1.5"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {visibleTiles.map((tile) => (
                  <div key={tile.key} className="min-h-0 min-w-0">
                    {tile.node}
                  </div>
                ))}
                {overflowCount > 0 && (
                  <div className="flex flex-col items-center justify-center gap-1 bg-[#171A21] text-white">
                    <span className="text-2xl font-semibold">+{overflowCount}</span>
                    <span className="text-xs text-white/60">more in this meeting</span>
                  </div>
                )}
              </div>
            );
          })()
        )}

        {captionsOn && (
          <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4 sm:bottom-28">
            {captionText ? (
              <div className="max-w-2xl rounded-lg bg-black/85 px-5 py-3 shadow-xl">
                <p className="text-xs font-semibold text-accent">{me.name ?? me.email}</p>
                <p className="text-base text-white">{captionText}</p>
              </div>
            ) : (
              <p className="rounded-lg bg-black/60 px-4 py-2 text-sm text-white/70 shadow-xl">
                Captions on — listening for speech...
              </p>
            )}
          </div>
        )}

        {timerRemaining !== null && (
          <div className="absolute right-4 top-4 z-20 rounded-full bg-black/60 px-4 py-2 text-sm font-semibold text-white backdrop-blur">
            {Math.floor(timerRemaining / 60)}:{String(timerRemaining % 60).padStart(2, "0")}
          </div>
        )}
      </main>

      {menuOpen && (
        <div className="absolute bottom-24 left-1/2 z-40 w-72 -translate-x-1/2 rounded-2xl border border-white/10 bg-[#202124] p-2 shadow-2xl sm:bottom-24">
          {myRow?.isHost && (
            <>
              <button onClick={() => { void handleToggleLock(); setMenuOpen(false); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-white/10">
                {locked ? <LockOpen size={18} /> : <Lock size={18} />}
                <span>{locked ? "Unlock meeting" : "Lock meeting"}</span>
              </button>
              <button onClick={() => { void handleSetPasscode(); setMenuOpen(false); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-white/10">
                <KeyRound size={18} />
                <span>{passcodeSet ? "Change passcode" : "Set a passcode"}</span>
              </button>
              <button onClick={() => { void handleEndMeeting(); setMenuOpen(false); }} disabled={ending} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-60">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs">×</span>
                <span>{ending ? "Ending meeting…" : "End meeting for everyone"}</span>
              </button>
            </>
          )}
          {/* Desktop already has a dedicated captions button in the
              control bar itself — this stays mobile-only so it's not a
              duplicate there, same reasoning as hand-raise/chat/tools
              below: below sm, this menu is the only way to reach it. */}
          <button
            onClick={() => {
              toggleCaptions();
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-white/10 sm:hidden"
          >
            <Captions size={18} />
            <span>{captionsOn ? "Turn off captions" : "Turn on captions"}</span>
          </button>

          {/* Mobile-only — on larger screens these three already have
              their own dedicated buttons (hand raise in the main pill,
              chat/tools in the bottom-right utility strip), so showing
              them here too would just be a redundant duplicate. Below
              those breakpoints, this menu is the only way to reach
              them — without this they'd have been genuinely
              unreachable, not just relocated. */}
          <button
            onClick={() => {
              handleToggleHandRaise();
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-white/10 sm:hidden"
          >
            <Hand size={18} />
            <span>{handRaised ? "Lower hand" : "Raise hand"}</span>
          </button>
          <button
            onClick={() => {
              setActivePanel("chat");
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-white/10 md:hidden"
          >
            <MessageSquare size={18} />
            <span>Chat</span>
          </button>
          <button
            onClick={() => {
              setActivePanel("tools");
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-white/10 md:hidden"
          >
            <LayoutGrid size={18} />
            <span>Meeting tools</span>
          </button>
        </div>
      )}

      {pendingRequests.length > 0 && (
        <div className="absolute right-4 top-16 z-30 w-full max-w-xs space-y-2 sm:top-20">
          {pendingRequests.map((request) => (
            <div key={request.id} className="rounded-2xl bg-[#202124] p-4 text-white shadow-2xl">
              <p className="text-sm">
                <span className="font-semibold">{request.name}</span> wants to join
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => handleDeny(request.id)}
                  className="flex-1 rounded-full px-3 py-2 text-xs font-medium text-white/70 hover:bg-white/10"
                >
                  Deny
                </button>
                <button
                  onClick={() => handleAdmit(request.id)}
                  className="flex-1 rounded-full bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
                >
                  Admit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showReadyCard && (
        <ReadyMeetingCard token={token} inviteInput={inviteInput} setInviteInput={setInviteInput} inviting={inviting} handleInvite={handleInvite} linkCopied={linkCopied} setLinkCopied={setLinkCopied} onClose={() => setShowReadyCard(false)} />
      )}

      {showShareWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#202124] p-6 text-white shadow-2xl">
            <h2 className="text-lg font-medium">Before you share...</h2>
            <p className="mt-2 text-sm text-white/70">
              Don&apos;t share your entire screen or this browser tab — sharing the tab this
              meeting is running in creates an infinite mirror (your shared screen showing
              itself, showing itself...). Share a different window or tab instead.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowShareWarning(false)}
                className="rounded-full px-4 py-2 text-sm font-medium text-white/70 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={startScreenShare}
                className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                Continue anyway
              </button>
            </div>
          </div>
        </div>
      )}

      <ControlBar
        micOn={micOn}
        cameraOn={cameraOn}
        micLocked={micLocked}
        cameraLocked={cameraLocked}
        participantsOpen={panel === "people"}
        onToggleMic={toggleMic}
        onToggleCamera={toggleCamera}
        onToggleParticipants={() => setActivePanel("people")}
        onScreenShareClick={handleScreenShareClick}
        onPresentSomethingElse={presentSomethingElse}
        sharingScreen={sharingScreen}
        handRaised={handRaised}
        onToggleHandRaise={handleToggleHandRaise}
        onReact={handleReact}
        captionsOn={captionsOn}
        onToggleCaptions={toggleCaptions}
        onMoreClick={() => setMenuOpen((value) => !value)}
        onLeave={handleLeave}
        leaving={leaving || ending}
        onChat={() => setActivePanel("chat")}
        onTools={() => setActivePanel("tools")}
      />

      {reactions.length > 0 && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1">
          {reactions.map((r) => (
            <div
              key={r.id}
              className="animate-[float-up_3s_ease-out_forwards] rounded-full bg-black/40 px-3 py-1 text-sm text-white backdrop-blur"
            >
              <span className="mr-1.5 text-lg">{r.emoji}</span>
              {r.fromName}
            </div>
          ))}
        </div>
      )}

      <MeetingPanel
        panel={panel}
        token={token}
        participants={participants}
        viewerIsHost={myRow?.isHost ?? false}
        onClose={() => setPanel(null)}
        onMute={handleMuteParticipant}
        onCameraOff={handleCameraOffParticipant}
        onRemove={handleRemoveParticipant}
        onMuteAll={handleMuteAll}
        onUnmuteAll={handleUnmuteAll}
        onCameraOffAll={handleCameraOffAll}
        onCameraOnAll={handleCameraOnAll}
        pendingRequests={pendingRequests}
        onAdmit={handleAdmit}
        onDeny={handleDeny}
        inviteInput={inviteInput}
        setInviteInput={setInviteInput}
        inviting={inviting}
        handleInvite={handleInvite}
        message={message}
        setMessage={setMessage}
        layoutMode={layoutMode}
        onCycleLayout={cycleLayout}
        maxVisibleTiles={maxVisibleTiles}
        onChangeMaxVisibleTiles={handleChangeLayoutSettings}
        backgroundEffect={backgroundEffect}
        onChangeBackgroundEffect={(effect) => void applyBackgroundEffect(effect)}
        timerRemaining={timerRemaining}
        onStartTimer={startTimer}
        onStopTimer={stopTimer}
        chatMessages={chatMessages}
        onSendChat={sendChatMessage}
        myUserId={me.id}
      />

    </div>
  );
}
