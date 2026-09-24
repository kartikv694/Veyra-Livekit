"use client";

/**
 * /meeting-ended/[token]
 *
 * Post-meeting landing screen (matches Google Meet's "You've left the
 * meeting" pattern) — what the room page redirects to instead of going
 * straight back to the dashboard, whichever way someone exits: leaving
 * voluntarily, being removed by the host, or the host ending the meeting
 * for everyone. The `?reason=` query param picks the headline and whether
 * "Rejoin" makes sense to offer at all.
 *
 * Also matches Meet's auto-return behavior: a 60-second countdown (shown
 * as a ring around the brand mark, top-left, mirroring Meet's own
 * numbered-circle countdown) redirects to the dashboard on its own if the
 * person doesn't click anything. Either button click cancels the timer.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";
import { toast } from "@/lib/toast";
import { authHeaders } from "@/lib/auth-client";

type Reason = "left" | "removed" | "ended";

interface ParticipantAnalysisRow {
  userId: number;
  name: string;
  communication: number;
  fluency: number;
  topicKnowledge: number;
  teamworkListening: number;
  leadershipInitiative: number;
  confidenceProfessionalism: number;
  summary: string | null;
}

const MAX_SCORE = 5;

const SCORE_LABELS: { key: keyof Omit<ParticipantAnalysisRow, "userId" | "name" | "summary">; label: string }[] = [
  { key: "communication", label: "Communication" },
  { key: "fluency", label: "Fluency" },
  { key: "topicKnowledge", label: "Topic knowledge" },
  { key: "teamworkListening", label: "Teamwork & listening" },
  { key: "leadershipInitiative", label: "Leadership & initiative" },
  { key: "confidenceProfessionalism", label: "Confidence & professionalism" },
];

const HEADLINES: Record<Reason, string> = {
  left: "You've left the meeting",
  removed: "You were removed from the meeting",
  ended: "The meeting has ended",
};

const AUTO_RETURN_SECONDS = 60;
const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const ANALYSIS_POLL_MS = 5000;
// How long to keep polling before giving up — covers the agent's own
// ~15s empty-room grace period plus real processing/LLM time, with
// margin. Past this, either nobody said anything analyzable, the agent
// worker isn't configured/running, or something failed — any of which
// means waiting longer won't help.
const ANALYSIS_MAX_WAIT_MS = 90_000;

export default function MeetingEndedPage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const [reason, setReason] = useState<Reason>("left");
  const [rejoining, setRejoining] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RETURN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // "idle" for anyone but a host who just ended the meeting (the only
  // case where there's anything to wait for or show) — see the
  // analysis-fetch effect below for the rest of the state machine.
  const [analysisState, setAnalysisState] = useState<"idle" | "waiting" | "ready" | "unavailable">("idle");
  const [analysis, setAnalysis] = useState<ParticipantAnalysisRow[]>([]);

  // Pick up ?reason= from the redirect that sent someone here — same
  // "one-off mount read, no Suspense boundary needed, no cascade risk"
  // reasoning as login/signup's matching ?email= effects.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("reason");
    if (value === "removed" || value === "ended") setReason(value);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fetches (and, if not ready yet, polls for) the AI meeting analysis —
  // only meaningful when the meeting was actually ended for everyone
  // (not just "you left" or "you were removed", where the meeting could
  // still be ongoing for others and the agent wouldn't have finished
  // analyzing anything yet). A 403 here just means this viewer isn't the
  // host — not an error worth surfacing, since analysis is host-only by
  // design; it simply resolves to "unavailable" (nothing shown) the same
  // as a genuine timeout would.
  useEffect(() => {
    if (reason !== "ended") return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/rooms/${params.token}/analysis`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 403) {
          setAnalysisState("unavailable");
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const rows: ParticipantAnalysisRow[] = Array.isArray(data.analysis) ? data.analysis : [];
        if (rows.length > 0) {
          setAnalysis(rows);
          setAnalysisState("ready");
          return;
        }
        if (Date.now() - startedAt >= ANALYSIS_MAX_WAIT_MS) {
          setAnalysisState("unavailable");
          return;
        }
        setAnalysisState("waiting");
        pollTimer = setTimeout(poll, ANALYSIS_POLL_MS);
      } catch {
        // A network hiccup mid-poll isn't fatal — just try again on the
        // next tick rather than giving up on the first failure.
        if (!cancelled) pollTimer = setTimeout(poll, ANALYSIS_POLL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [reason, params.token]);

  // Derived, not separate state updated via effect — true immediately
  // whenever there's nothing to wait for (not "ended", or analysis has
  // resolved one way or the other), false only while a confirmed host
  // is actively waiting on their meeting analysis. Gates the auto-return
  // countdown effect below, so it can't redirect that host away before
  // they get to see it.
  const countdownReady = reason !== "ended" || analysisState === "ready" || analysisState === "unavailable";

  // Auto-return countdown — cancelled by cancelAutoReturn() below the
  // instant the person clicks either button, so it never fires after
  // they've already chosen where to go. Gated behind countdownReady —
  // stays paused (not even started) while a confirmed host is actively
  // waiting on their meeting analysis, so it can't redirect them away
  // before they get to see it. Ready immediately for every other case.
  useEffect(() => {
    if (!countdownReady) return;
    intervalRef.current = setInterval(() => {
      // Keep this updater pure — no side effects (router.push, etc.)
      // inside it. React doesn't allow triggering another component's
      // state update (like the router's) from inside a setState updater
      // function; doing that is exactly what caused "Cannot update a
      // component (Router) while rendering a different component" here.
      // The actual navigation happens in the effect below instead, which
      // reacts to secondsLeft hitting 0 — the React-sanctioned way to run
      // a side effect off of a state change.
      setSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [countdownReady]);

  useEffect(() => {
    if (secondsLeft === 0) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      router.push("/dashboard");
    }
  }, [secondsLeft, router]);

  const cancelAutoReturn = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  };

  const handleRejoin = async () => {
    cancelAutoReturn();
    setRejoining(true);
    try {
      const res = await fetch("/api/rooms/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ token: params.token }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't rejoin that meeting.");
        return;
      }
      router.push(`/room/${params.token}`);
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setRejoining(false);
    }
  };

  const handleReturnHome = () => {
    cancelAutoReturn();
    router.push("/dashboard");
  };

  const progress = secondsLeft / AUTO_RETURN_SECONDS;

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="flex items-center gap-3">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
            <svg viewBox="0 0 44 44" className="absolute h-9 w-9 -rotate-90">
              <circle cx="22" cy="22" r={RING_RADIUS} fill="none" stroke="var(--edge)" strokeWidth="3" />
              <circle
                cx="22"
                cy="22"
                r={RING_RADIUS}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
                className="transition-all duration-1000 ease-linear"
              />
            </svg>
            <span className="text-[11px] font-semibold text-muted">{secondsLeft}</span>
          </div>
          <span className="text-sm text-muted">
            {analysisState === "waiting" ? "Preparing your meeting summary…" : "Returning to your dashboard..."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <BrandLink size={22} />
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-3xl font-semibold sm:text-4xl">{HEADLINES[reason]}</h1>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {reason !== "ended" && (
            <button
              onClick={handleRejoin}
              disabled={rejoining}
              className="rounded-full border border-edge px-6 py-2.5 text-sm font-semibold transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
            >
              {rejoining ? "Rejoining..." : "Rejoin"}
            </button>
          )}
          <button
            onClick={handleReturnHome}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Return to home screen
          </button>
        </div>

        {analysisState === "waiting" && (
          <div className="mt-10 flex max-w-md items-center gap-3 rounded-xl border border-edge bg-surface p-4 text-left">
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <div>
              <p className="text-sm font-medium">Preparing your meeting summary</p>
              <p className="mt-0.5 text-sm text-muted">
                Your AI meeting analysis will appear here shortly.
              </p>
            </div>
          </div>
        )}

        {analysisState === "ready" && (
          <div className="mt-10 w-full max-w-5xl text-left">
            <h2 className="text-center font-display text-xl font-semibold sm:text-2xl">Meeting analysis</h2>
            <p className="mt-1 text-center text-sm text-muted">
              AI-generated, based on what each participant said during the meeting. Each parameter scored out of {MAX_SCORE}.
            </p>
            <div className="mt-6 overflow-x-auto rounded-xl border border-edge">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-edge bg-surface">
                    <th className="sticky left-0 bg-surface px-4 py-3 text-left font-medium">Participant</th>
                    {SCORE_LABELS.map(({ key, label }) => (
                      <th key={key} className="px-3 py-3 text-center font-medium text-muted">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analysis.map((row, i) => (
                    <tr key={row.userId} className={i % 2 === 1 ? "bg-white/[0.02]" : undefined}>
                      <td className="sticky left-0 whitespace-nowrap bg-inherit px-4 py-3 font-medium">{row.name}</td>
                      {SCORE_LABELS.map(({ key }) => (
                        <td key={key} className="px-3 py-3 text-center">
                          <span className="font-semibold">{row[key]}</span>
                          <span className="text-muted">/{MAX_SCORE}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {analysis.some((row) => row.summary) && (
              <div className="mt-4 space-y-2">
                {analysis
                  .filter((row) => row.summary)
                  .map((row) => (
                    <p key={row.userId} className="text-sm text-muted">
                      <span className="font-medium text-fg">{row.name}:</span> {row.summary}
                    </p>
                  ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-10 flex max-w-md items-start gap-3 rounded-xl border border-edge bg-surface p-4 text-left">
          <ShieldCheck size={20} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <p className="text-sm font-medium">Your meeting is safe</p>
            <p className="mt-0.5 text-sm text-muted">
              No one can join a meeting unless invited or admitted by the host.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
