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

const HEADLINES: Record<Reason, string> = {
  left: "You've left the meeting",
  removed: "You were removed from the meeting",
  ended: "The meeting has ended",
};

const AUTO_RETURN_SECONDS = 60;
const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export default function MeetingEndedPage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const [reason, setReason] = useState<Reason>("left");
  const [rejoining, setRejoining] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RETURN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pick up ?reason= from the redirect that sent someone here — same
  // "one-off mount read, no Suspense boundary needed, no cascade risk"
  // reasoning as login/signup's matching ?email= effects.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("reason");
    if (value === "removed" || value === "ended") setReason(value);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-return countdown — cancelled by cancelAutoReturn() below the
  // instant the person clicks either button, so it never fires after
  // they've already chosen where to go.
  useEffect(() => {
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
  }, []);

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
          <span className="text-sm text-muted">Returning to your dashboard...</span>
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
