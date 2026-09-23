"use client";

/**
 * / (landing page)
 *
 * Entry point for the whole app. Instead of forcing a login/signup choice
 * up front, it leads with the two things people actually came here to do —
 * "New meeting" and "Join meeting" — and only checks auth once one of them
 * is clicked:
 *
 *   - authenticated  -> straight to /dashboard, with ?intent= so the
 *     dashboard can act on it immediately (auto-start creation, or focus
 *     the join-code field) instead of making them click again.
 *   - not authenticated -> the intent is stashed in localStorage and the
 *     visitor is sent to /login. Login (or a signup it bounces to — see
 *     that page) redirects back to /dashboard once they're in; the
 *     dashboard picks the stashed intent back up from there.
 *
 * The auth check itself is `checkAuth()` (GET /api/auth/me) — never just a
 * "is there a token in localStorage" guess — so an expired/invalid token
 * correctly sends someone to /login instead of a dashboard that then fails.
 */
import { useState } from "react";

import { useRouter } from 'next/navigation'
import { Plus, LogIn } from "lucide-react";
import { toast } from "@/lib/toast";
import { Navbar } from "@/components/Navbar";
import { SignalMotif } from "@/components/SignalMotif";
import { checkAuth } from "@/lib/auth-client";

type Intent = "create" | "join";

/** Key under which the landing page's chosen intent is stashed for
 *  /dashboard to pick up after a login/signup round-trip. */
const INTENT_STORAGE_KEY = "veyra_intent";

export default function LandingPage() {
  const router = useRouter();
  const [pending, setPending] = useState<Intent | null>(null);

  async function handleIntent(intent: Intent) {
    if (pending) return;
    setPending(intent);

    const user = await checkAuth();

    if (user) {
      router.push(`/dashboard?intent=${intent}`);
      return;
    }

    window.localStorage.setItem(INTENT_STORAGE_KEY, intent);
    toast.info("Please sign in to continue.");
    router.push("/login");
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#0F1115] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <SignalMotif />
      </div>

      <Navbar />

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="max-w-xl font-display text-3xl font-semibold leading-tight sm:text-4xl">
          Every seat connected, one room at a time.
        </h1>
        <p className="mt-3 max-w-md text-sm text-white/60">
          Start a meeting and share the link, or join one with a code —
          no downloads required.
        </p>

        <div className="mt-10 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
          <button
            onClick={() => handleIntent("create")}
            disabled={pending !== null}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#6C77FF] py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <Plus size={16} />
            {pending === "create" ? "Checking..." : "New meeting"}
          </button>
          <button
            onClick={() => handleIntent("join")}
            disabled={pending !== null}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-white/20 py-3 text-sm font-semibold transition-colors hover:border-white/40 disabled:opacity-60"
          >
            <LogIn size={16} />
            {pending === "join" ? "Checking..." : "Join meeting"}
          </button>
        </div>
      </main>

      <footer className="relative z-10 px-6 pb-6 text-center text-xs text-white/40 sm:px-10 sm:text-left">
        © 2026 Veyra. Built for teams that meet often.
      </footer>
    </div>
  );
}
