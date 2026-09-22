"use client";

/**
 * /dashboard
 *
 * Landing screen after login: create a new meeting (host flow), join one
 * by code (participant flow), and a "Recent meetings" list fetched from
 * GET /api/rooms.
 *
 * Guarded on mount via `checkAuth()` — a direct/bookmarked visit with no
 * valid session gets bounced to /login rather than rendering a page whose
 * API calls would just fail with 401s.
 *
 * Also honors an "intent" the landing page may have set before sending
 * someone here (?intent=create|join in the URL for an already-authenticated
 * visitor, or stashed in localStorage if they had to log in first):
 * intent=join focuses the join-code field so they can drop a code straight
 * in. intent=create deliberately does NOT auto-create a meeting — landing
 * here is as far as it goes, the person clicks "New meeting" themselves
 * from here, same as anyone who navigated to the dashboard directly. Either
 * way the intent is consumed once and not reapplied on a later visit.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, LogIn, Copy, Check, Users, Calendar, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { BrandLink } from "@/components/BrandLink";
import { UserMenu } from "@/components/UserMenu";
import { LoadingScreen } from "@/components/LoadingScreen";
import { SkeletonRows } from "@/components/SkeletonRows";
import { checkAuth, authHeaders, type SessionUser } from "@/lib/auth-client";

const INTENT_STORAGE_KEY = "veyra_intent";

interface MeetingSummary {
  id: number;
  token: string;
  link: string;
  createdAt: string;
  endAt: string | null;
  isHost: boolean;
  participantCount: number;
  scheduledAt: string | null;
  title: string | null;
  durationMinutes: number | null;
}

/** Reads the intent set by the landing page, checking the URL first (the
 *  already-authenticated path) and falling back to the stashed localStorage
 *  value (the "had to log in first" path). Consumes it either way. */
function consumeIntent(): "create" | "join" | null {
  const fromUrl = new URLSearchParams(window.location.search).get("intent");
  const fromStorage = window.localStorage.getItem(INTENT_STORAGE_KEY);
  window.localStorage.removeItem(INTENT_STORAGE_KEY);
  const intent = fromUrl ?? fromStorage;
  return intent === "create" || intent === "join" ? intent : null;
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // Used for the "is this meeting still upcoming" check and the
  // schedule-form's minimum date/time — Date.now() can't be called
  // directly during render (React Compiler's purity rule flags it: the
  // same render must produce the same output every time it's called, and
  // a live clock read breaks that). A once-a-minute refresh is more than
  // enough precision for either use.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [roomLink, setRoomLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(true);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleTitle, setScheduleTitle] = useState("");
  const [scheduleDateTime, setScheduleDateTime] = useState("");
  const [scheduleEmails, setScheduleEmails] = useState("");
  const [durationEnabled, setDurationEnabled] = useState(false);
  const [scheduleDuration, setScheduleDuration] = useState(60);
  const [scheduling, setScheduling] = useState(false);
  const [contacts, setContacts] = useState<{ id: number; name: string | null; email: string }[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [showEmailSuggestions, setShowEmailSuggestions] = useState(false);
  const joinInputRef = useRef<HTMLInputElement>(null);

  // Loads past contacts once per modal session (not on every keystroke) so
  // the invite-emails field can suggest people already met in a past
  // meeting — same /api/contacts source as the in-room "Add others" card.
  useEffect(() => {
    if (!scheduleOpen || contactsLoaded) return;
    (async () => {
      try {
        const res = await fetch("/api/contacts", { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.ok) setContacts(data.contacts ?? []);
      } catch {
        // Non-critical — typing the email manually still works fine.
      } finally {
        setContactsLoaded(true);
      }
    })();
  }, [scheduleOpen, contactsLoaded]);

  // The comma/newline-separated textarea's "current" token is whatever
  // comes after the last separator — that's what gets matched against
  // contacts and replaced when a suggestion is picked, so picking one
  // completes the in-progress email instead of appending a duplicate.
  const emailTokens = scheduleEmails.split(/[,\n]/);
  const currentEmailToken = emailTokens[emailTokens.length - 1].trim().toLowerCase();
  const alreadyEnteredEmails = emailTokens.slice(0, -1).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const emailSuggestions = currentEmailToken
    ? contacts
        .filter((c) => !alreadyEnteredEmails.includes(c.email.toLowerCase()))
        .filter((c) => c.email.toLowerCase().includes(currentEmailToken) || (c.name ?? "").toLowerCase().includes(currentEmailToken))
        .slice(0, 5)
    : [];

  const applyEmailSuggestion = (email: string) => {
    const tokens = scheduleEmails.split(/[,\n]/);
    tokens[tokens.length - 1] = email;
    setScheduleEmails(tokens.map((t) => t.trim()).filter(Boolean).join(", ") + ", ");
    setShowEmailSuggestions(false);
  };

  const loadMeetings = async () => {
    try {
      const res = await fetch("/api/rooms", { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setMeetings(data.meetings);
      }
    } finally {
      setMeetingsLoading(false);
    }
  };

  const handleCreateRoom = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/rooms", { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't create the meeting. Please try again.");
        return;
      }
      setRoomLink(data.meeting.link);
      setCopied(false);
      toast.success("Meeting created — taking you in.");
      router.push(`/room/${data.meeting.token}?fresh=1`);
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  const handleScheduleMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleDateTime) {
      toast.error("Choose a date and time first.");
      return;
    }
    const scheduledAt = new Date(scheduleDateTime);
    if (scheduledAt.getTime() <= Date.now()) {
      toast.error("Choose a future date and time.");
      return;
    }
    setScheduling(true);
    try {
      const emails = scheduleEmails
        .split(/[,\n]/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
      const res = await fetch("/api/rooms/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          scheduledAt: scheduledAt.toISOString(),
          emails,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          title: scheduleTitle.trim() || undefined,
          durationMinutes: durationEnabled ? scheduleDuration : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't schedule the meeting.");
        return;
      }
      toast.success("Meeting scheduled.");
      setScheduleOpen(false);
      setScheduleTitle("");
      setScheduleDateTime("");
      setScheduleEmails("");
      setDurationEnabled(false);
      setScheduleDuration(60);
      await loadMeetings();
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setScheduling(false);
    }
  };

  const handleCopy = async () => {
    if (!roomLink) return;
    await navigator.clipboard.writeText(roomLink);
    setCopied(true);
    toast.success("Link copied.");
    setTimeout(() => setCopied(false), 1500);
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = joinCode.trim();
    if (!value) return;
    setJoining(true);
    router.push(`/room/${encodeURIComponent(value)}`);
  };

  // Auth guard + one-time intent handling, in that order: we don't act on
  // an intent until we know the session is actually valid.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const authedUser = await checkAuth();
      if (cancelled) return;

      if (!authedUser) {
        toast.error("Please sign in to continue.");
        router.push("/login");
        return;
      }

      setUser(authedUser);
      setCheckingAuth(false);
      await loadMeetings();

      const intent = consumeIntent();
      if (intent === "join") {
        joinInputRef.current?.focus();
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (checkingAuth || !user) {
    return <LoadingScreen variant="themed" message="Loading..." />;
  }

  return (
    <div className="min-h-screen bg-bg">
      <header className="relative flex items-center justify-between border-b border-edge px-6 py-4 sm:px-10">
        <BrandLink size={22} />

        <nav className="absolute left-1/2 -translate-x-1/2" aria-label="Primary navigation">
          <Link
            href="/dashboard"
            aria-current="page"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/10"
          >
            Dashboard
          </Link>
        </nav>

        <div className="flex items-center gap-4">
          <UserMenu user={user} />
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12 sm:px-10">
        <h1 className="font-display text-2xl font-semibold">
          Good to see you, {user.name ?? user.email}
        </h1>
        <p className="mt-1 text-sm text-muted">Start a new meeting or join one with a code.</p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border border-edge bg-surface p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10">
              <Plus size={18} className="text-accent" />
            </div>
            <h2 className="mt-4 font-display text-lg font-semibold">New meeting</h2>
            <p className="mt-1 text-sm text-muted">
              You&apos;ll be assigned as host with full room controls.
            </p>
            <button
              onClick={handleCreateRoom}
              disabled={creating}
              className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {creating ? "Creating..." : "Create room"}
            </button>

            {roomLink && (
              <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-edge bg-surface2 px-3 py-2.5">
                <span className="truncate text-sm text-muted">{roomLink}</span>
                <button onClick={handleCopy} aria-label="Copy link" className="shrink-0 text-accent">
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-edge bg-surface p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10">
              <Calendar size={18} className="text-accent" />
            </div>
            <h2 className="mt-4 font-display text-lg font-semibold">Schedule meeting</h2>
            <p className="mt-1 text-sm text-muted">Plan a meeting for a future date and invite people by email.</p>
            <button
              onClick={() => setScheduleOpen(true)}
              className="mt-4 w-full rounded-lg border border-edge py-2.5 text-sm font-semibold transition-colors hover:border-accent hover:text-accent"
            >
              Schedule
            </button>
          </div>

          <div className="rounded-xl border border-edge bg-surface p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent2/10">
              <LogIn size={18} className="text-accent2" />
            </div>
            <h2 className="mt-4 font-display text-lg font-semibold">Join meeting</h2>
            <p className="mt-1 text-sm text-muted">Enter a room code or paste a link.</p>
            <form onSubmit={handleJoin} className="mt-4 space-y-3">
              <input
                ref={joinInputRef}
                type="text"
                required
                value={joinCode}
                onChange={(e) => {
                  setJoinCode(e.target.value);
                }}
                placeholder="e.g. 7fk-2xa-plm"
                className="w-full rounded-lg border border-edge bg-surface2 px-3 py-2.5 text-sm outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={joining}
                className="w-full rounded-lg border border-edge py-2.5 text-sm font-semibold transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {joining ? "Joining..." : "Join"}
              </button>
            </form>
          </div>
        </div>

        <div className="mt-10">
          <h3 className="text-sm font-semibold text-muted">Recent meetings</h3>
          {meetingsLoading ? (
            <div className="mt-3">
              <SkeletonRows count={3} />
            </div>
          ) : meetings.length === 0 ? (
            <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-dashed border-edge py-12 text-center">
              <Users size={22} className="text-muted" />
              <p className="mt-2 text-sm text-muted">No meetings yet — create your first room above.</p>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-edge rounded-xl border border-edge bg-surface">
              {meetings.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.title || m.token}</p>
                    <p className="text-muted">
                      {m.scheduledAt ? `Scheduled for ${new Date(m.scheduledAt).toLocaleString()}` : `${m.isHost ? "You hosted" : "You joined"} · ${m.participantCount} participant${m.participantCount === 1 ? "" : "s"}`}{m.endAt ? " · ended" : ""}
                    </p>
                  </div>
                  {m.endAt ? (
                    <span className="shrink-0 rounded-lg border border-edge bg-surface2 px-3 py-1.5 text-xs font-semibold text-muted">Ended</span>
                  ) : m.scheduledAt && new Date(m.scheduledAt).getTime() > now ? (
                    <span className="shrink-0 rounded-lg border border-edge bg-surface2 px-3 py-1.5 text-xs font-semibold text-accent">Scheduled</span>
                  ) : (
                    <button
                      onClick={() => router.push(`/room/${m.token}`)}
                      className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-xs font-semibold transition-colors hover:border-accent hover:text-accent"
                    >Rejoin</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {scheduleOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
            <form onSubmit={handleScheduleMeeting} className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-xl font-semibold">Schedule meeting</h2>
                  <p className="mt-1 text-sm text-muted">Choose when you want the meeting to start.</p>
                </div>
                <button type="button" onClick={() => setScheduleOpen(false)} className="rounded-full p-2 text-muted hover:bg-surface2 hover:text-fg" aria-label="Close">
                  <X size={18} />
                </button>
              </div>
              <label className="mt-5 block text-sm font-medium">Meeting title <span className="font-normal text-muted">(optional)</span>
                <input
                  type="text"
                  value={scheduleTitle}
                  onChange={(e) => setScheduleTitle(e.target.value)}
                  placeholder="e.g. Weekly design sync"
                  maxLength={200}
                  className="mt-2 w-full rounded-lg border border-edge bg-surface2 px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
              </label>
              <label className="mt-4 block text-sm font-medium">Date and time
                <input
                  type="datetime-local"
                  required
                  value={scheduleDateTime}
                  onChange={(e) => setScheduleDateTime(e.target.value)}
                  min={new Date(now + 60_000).toISOString().slice(0,16)}
                  className="mt-2 w-full rounded-lg border border-edge bg-surface2 px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
              </label>

              <div className="mt-4 flex items-center justify-between">
                <span className="text-sm font-medium">Set a time limit</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={durationEnabled}
                  onClick={() => setDurationEnabled((v) => !v)}
                  className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${durationEnabled ? "justify-end bg-accent" : "justify-start border border-edge bg-surface2"
                    }`}
                >
                  <span className="h-5 w-5 rounded-full bg-white shadow" />
                </button>
              </div>
              {durationEnabled && (
                <label className="mt-2 block text-sm text-muted">The meeting ends automatically after
                  <select
                    value={scheduleDuration}
                    onChange={(e) => setScheduleDuration(Number(e.target.value))}
                    className="mt-2 w-full rounded-lg border border-edge bg-surface2 px-3 py-2.5 text-sm outline-none focus:border-accent"
                  >
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={45}>45 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={90}>1.5 hours</option>
                    <option value={120}>2 hours</option>
                    <option value={180}>3 hours</option>
                  </select>
                </label>
              )}

              <div className="mt-4">
                <label className="block text-sm font-medium">Invite emails <span className="font-normal text-muted">(optional)</span>
                  <textarea
                    value={scheduleEmails}
                    onChange={(e) => setScheduleEmails(e.target.value)}
                    onFocus={() => setShowEmailSuggestions(true)}
                    onBlur={() => window.setTimeout(() => setShowEmailSuggestions(false), 150)}
                    placeholder="name@example.com, another@example.com"
                    rows={3}
                    className="mt-2 w-full resize-none rounded-lg border border-edge bg-surface2 px-3 py-2.5 text-sm outline-none focus:border-accent"
                  />
                </label>
                {showEmailSuggestions && emailSuggestions.length > 0 && (
                  // Deliberately NOT position:absolute — this modal scrolls
                  // (overflow-y-auto), and an absolutely-positioned overlay
                  // near the bottom of a scroll container gets clipped by
                  // it invisible even though it's rendering and positioned
                  // correctly. Normal flow means it just pushes the buttons
                  // below it down instead, which the same scroll handles fine.
                  <div className="mt-1 overflow-hidden rounded-lg border border-edge bg-surface2">
                    {emailSuggestions.map((contact) => (
                      // onMouseDown, not onClick — fires before the textarea's
                      // onBlur, so the suggestion is still there to click.
                      <button
                        key={contact.id}
                        type="button"
                        onMouseDown={() => applyEmailSuggestion(contact.email)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface"
                      >
                        <span className="min-w-0 truncate">
                          <span className="block truncate font-medium">{contact.name ?? contact.email}</span>
                          {contact.name && <span className="block truncate text-xs text-muted">{contact.email}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <button type="button" onClick={() => setScheduleOpen(false)} className="rounded-lg px-4 py-2.5 text-sm font-medium text-muted hover:bg-surface2">Cancel</button>
                <button type="submit" disabled={scheduling} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{scheduling ? "Scheduling..." : "Schedule meeting"}</button>
              </div>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
