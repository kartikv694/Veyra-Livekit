"use client";

import { useState } from "react";
import { Check, Crown, Mic, MicOff, UserPlus, UserX, Video, VideoOff, X } from "lucide-react";
import { authHeaders } from "@/lib/auth-client";

export interface ParticipantRow {
  userId: number;
  name: string;
  isHost: boolean;
  isMuted: boolean;
  isCameraOff: boolean;
  leftAt: string | null;
}

/** A standard sliding toggle switch — same visual pattern as a theme
 *  toggle, reused here for bulk mic/camera actions. It's an action
 *  trigger dressed as a state switch: since any individual participant
 *  can unmute/re-enable their own camera independently at any time,
 *  there's no single true "on/off" state to track for the whole group —
 *  the switch's position just reflects whether *everyone* currently
 *  happens to be muted/off, and flipping it fires the bulk mute-all or
 *  release-all action accordingly. */
function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-2 text-left transition hover:bg-white/5"
    >
      <span className="text-sm text-white/85">{label}</span>
      {/* Inline styles here on purpose, not Tailwind classes — this is
          the actual visible switch, so it shouldn't depend on Tailwind's
          class generation picking up a template-literal class name
          correctly. Fixed pixel sizes and explicit hex colors, so it
          renders identically regardless of any build/CSS-pipeline
          quirk. */}
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
          width: 44,
          height: 24,
          borderRadius: 9999,
          border: "1px solid rgba(255,255,255,0.35)",
          background: checked ? "#6C77FF" : "#4a4d50",
          transition: "background-color 150ms",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 22 : 2,
            width: 18,
            height: 18,
            borderRadius: 9999,
            background: "#ffffff",
            boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
            transition: "left 150ms",
          }}
        />
      </span>
    </button>
  );
}

interface ParticipantListProps {
  open: boolean;
  token: string;
  participants: ParticipantRow[];
  onClose: () => void;
  viewerIsHost: boolean;
  onMute?: (userId: number) => void;
  onCameraOff?: (userId: number) => void;
  onRemove?: (userId: number) => void;
  onMuteAll?: () => void;
  onUnmuteAll?: () => void;
  onCameraOffAll?: () => void;
  onCameraOnAll?: () => void;
  pendingRequests?: { id: number; userId: number; name: string; requestedAt: string }[];
  onAdmit?: (requestId: number) => void;
  onDeny?: (requestId: number) => void;
  /** Host-only: lets someone invite a person mid-meeting, after the
   *  initial "Your meeting's ready" card has already been dismissed. */
  inviteInput?: string;
  setInviteInput?: (value: string) => void;
  inviting?: boolean;
  onInvite?: () => void;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function ParticipantList({
  open,
  token,
  participants,
  onClose,
  viewerIsHost,
  onMute,
  onCameraOff,
  onRemove,
  onMuteAll,
  onUnmuteAll,
  onCameraOffAll,
  onCameraOnAll,
  pendingRequests = [],
  onAdmit,
  onDeny,
  inviteInput = "",
  setInviteInput,
  inviting = false,
  onInvite,
}: ParticipantListProps) {
  const [showInvite, setShowInvite] = useState(false);
  // Contact suggestions — same pattern as the dashboard's schedule modal
  // and the "meeting's ready" card, but self-contained here rather than
  // shared: this panel and those two are separate components with their
  // own state, not a common one to lift this into.
  const [contacts, setContacts] = useState<{ id: number; name: string | null; email: string }[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [alreadyInvitedEmails, setAlreadyInvitedEmails] = useState<Set<string>>(new Set());

  const inviteEmails = inviteInput.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const currentEmailToken = inviteEmails.length ? inviteEmails[inviteEmails.length - 1] : "";
  const filteredContacts = currentEmailToken
    ? contacts.filter(
        (contact) =>
          contact.email.toLowerCase().includes(currentEmailToken) ||
          (contact.name ?? "").toLowerCase().includes(currentEmailToken),
      )
    : contacts;

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

  const openContacts = async () => {
    setShowContacts(true);
    if (contacts.length > 0) {
      // Already loaded once this panel session — just refresh which
      // ones are marked invited, no need to re-fetch the contact list
      // itself every time the field is focused.
      void loadInvitedEmails();
      return;
    }
    setLoadingContacts(true);
    try {
      const [contactsRes] = await Promise.all([fetch("/api/contacts", { headers: authHeaders() }), loadInvitedEmails()]);
      const data = await contactsRes.json().catch(() => ({}));
      if (contactsRes.ok) setContacts(data.contacts ?? []);
    } catch {
      // Non-critical — the manual input still works without suggestions.
    } finally {
      setLoadingContacts(false);
    }
  };

  // Re-checks the persisted invite list right after a send succeeds, so
  // a contact just invited immediately shows the checkmark instead of
  // waiting for the dropdown to be closed and reopened.
  const handleInviteAndRefresh = async () => {
    await onInvite?.();
    if (showContacts) void loadInvitedEmails();
  };

  const addContactEmail = (email: string) => {
    const lower = email.trim().toLowerCase();
    if (inviteEmails.includes(lower)) return;
    setInviteInput?.(inviteEmails.length ? `${inviteInput.replace(/[,\s]+$/, "")}, ${lower}` : lower);
  };

  if (!open) return null;

  const active = participants.filter((p) => !p.leftAt);
  const departed = participants.filter((p) => p.leftAt);
  const othersActive = active.filter((p) => !p.isHost);
  const anyoneUnmuted = othersActive.some((p) => !p.isMuted);
  const anyoneCameraOn = othersActive.some((p) => !p.isCameraOff);

  return (
    <aside className="flex h-full w-full flex-col bg-[#202124] text-white">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-xl font-medium">People</h2>
        <button
          onClick={onClose}
          aria-label="Close participant panel"
          className="rounded-full p-2 text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <X size={20} />
        </button>
      </div>

      <div className="px-5 pb-3 text-sm text-white/60">{active.length} in this meeting</div>

      {viewerIsHost && (
        <div className="mx-3 mb-3">
          <button
            onClick={() => setShowInvite((v) => !v)}
            className="flex items-center gap-2 rounded-full bg-accent px-3.5 py-2 text-xs font-semibold text-white hover:opacity-90"
          >
            <UserPlus size={14} /> Invite
          </button>
          {showInvite && (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={inviteInput}
                  onChange={(e) => setInviteInput?.(e.target.value)}
                  onFocus={() => void openContacts()}
                  onBlur={() => window.setTimeout(() => setShowContacts(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleInviteAndRefresh();
                    }
                  }}
                  placeholder="name@example.com, another@example.com"
                  className="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                />
                <button
                  onClick={() => void handleInviteAndRefresh()}
                  disabled={inviting || !inviteInput.trim()}
                  className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {inviting ? "..." : "Invite"}
                </button>
              </div>
              {showContacts && (loadingContacts || filteredContacts.length > 0) && (
                // In normal flow, not absolutely positioned — this panel
                // itself can scroll, and an absolutely-positioned overlay
                // near the edge of a scroll container gets clipped by it
                // invisible even when it's rendering and positioned
                // correctly (found and fixed the same bug in the
                // dashboard's schedule modal earlier).
                <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-[#2b2c30]">
                  {loadingContacts ? (
                    <div className="px-3 py-2 text-xs text-white/40">Loading…</div>
                  ) : (
                    filteredContacts.map((contact) => {
                      const added = alreadyInvitedEmails.has(contact.email.toLowerCase()) || inviteEmails.includes(contact.email.toLowerCase());
                      return (
                        <button
                          key={contact.id}
                          type="button"
                          disabled={added}
                          onMouseDown={() => addContactEmail(contact.email)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-white/5 disabled:opacity-50"
                        >
                          <span className="min-w-0 truncate">
                            <span className="block truncate font-medium">{contact.name ?? contact.email}</span>
                            {contact.name && <span className="block truncate text-xs text-white/45">{contact.email}</span>}
                          </span>
                          {added ? <Check size={14} className="shrink-0 text-accent" /> : <UserPlus size={14} className="shrink-0 text-white/40" />}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {viewerIsHost && pendingRequests.length > 0 && (
        <div className="mx-3 mb-3 rounded-2xl border border-white/10 bg-[#2b2c30] p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/45">Waiting to join</p>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{pendingRequests.length}</span>
          </div>
          <div className="mt-2 space-y-2">
            {pendingRequests.map((request) => (
              <div key={request.id} className="rounded-xl bg-[#202124] p-3">
                <p className="truncate text-sm font-medium">{request.name}</p>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => onDeny?.(request.id)} className="flex-1 rounded-full px-2 py-1.5 text-xs text-white/60 hover:bg-white/10">Deny</button>
                  <button onClick={() => onAdmit?.(request.id)} className="flex-1 rounded-full bg-accent px-2 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Check size={13} className="mr-1 inline" />Admit</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewerIsHost && othersActive.length > 0 && (
        <div className="space-y-1 px-5 pb-3">
          <ToggleSwitch
            checked={!anyoneUnmuted}
            onChange={() => (anyoneUnmuted ? onMuteAll : onUnmuteAll)?.()}
            label="All participants mic mute"
          />
          <ToggleSwitch
            checked={!anyoneCameraOn}
            onChange={() => (anyoneCameraOn ? onCameraOffAll : onCameraOnAll)?.()}
            label="All participants camera off"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {active.map((p) => (
          <div
            key={p.userId}
            className="group flex items-center gap-3 rounded-xl px-2 py-3 transition hover:bg-white/5"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">
              {initials(p.name)}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{p.name}</span>
                {p.isHost && <Crown size={13} className="shrink-0 text-amber-300" />}
              </div>
              <span className="text-xs text-white/45">{p.isHost ? "Host" : "Participant"}</span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {p.isMuted ? <MicOff size={17} className="text-white/55" /> : <Mic size={17} className="text-white/75" />}
              {p.isCameraOff ? <VideoOff size={17} className="text-white/55" /> : <Video size={17} className="text-white/75" />}
              {viewerIsHost && !p.isHost && (
                <div className="hidden items-center gap-1 group-hover:flex">
                  <button
                    onClick={() => onMute?.(p.userId)}
                    aria-label={p.isMuted ? `Unmute ${p.name}` : `Mute ${p.name}`}
                    title={p.isMuted ? "Unmute" : "Mute"}
                    className="rounded-full p-2 text-white/60 hover:bg-white/10 hover:text-white"
                  >
                    {p.isMuted ? <Mic size={14} /> : <MicOff size={14} />}
                  </button>
                  <button
                    onClick={() => onCameraOff?.(p.userId)}
                    aria-label={p.isCameraOff ? `Turn on ${p.name}'s camera` : `Turn off ${p.name}'s camera`}
                    title={p.isCameraOff ? "Turn on camera" : "Turn off camera"}
                    className="rounded-full p-2 text-white/60 hover:bg-white/10 hover:text-white"
                  >
                    {p.isCameraOff ? <Video size={14} /> : <VideoOff size={14} />}
                  </button>
                  <button
                    onClick={() => onRemove?.(p.userId)}
                    aria-label={`Remove ${p.name}`}
                    title="Remove participant"
                    className="rounded-full p-2 text-white/60 hover:bg-red-500/15 hover:text-red-300"
                  >
                    <UserX size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {departed.length > 0 && (
          <div className="mt-5 border-t border-white/10 pt-4">
            <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-white/35">Left</p>
            {departed.map((p) => (
              <div key={p.userId} className="flex items-center gap-3 rounded-xl px-2 py-2 text-sm text-white/40">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5">
                  {initials(p.name)}
                </div>
                <span className="truncate">{p.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
