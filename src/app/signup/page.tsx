"use client";

/**
 * /signup
 *
 * Account creation screen — same split layout as /login.
 *
 * Wired to POST /api/auth/signup. Mirrors login's cross-redirect: if the
 * email is already registered (409, reason "already_registered"), we toast
 * it and send them to /login with the email pre-filled instead of leaving
 * them stuck on a form they can't submit.
 *
 * If arrived at via a redirect from /login (unregistered email), the email
 * query param pre-fills the field so they don't have to retype it.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Mail, User } from "lucide-react";
import { toast } from "@/lib/toast";
import { SignalMotif } from "@/components/SignalMotif";
import { BrandLink } from "@/components/BrandLink";
import { PasswordField } from "@/components/PasswordField";
import { saveSession } from "@/lib/auth-client";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Pick up ?email= from a /login redirect, without needing a Suspense
  // boundary for useSearchParams — this is a one-off read on mount. Safe
  // to suppress the state-in-effect warning here specifically: empty
  // deps means it can only ever run once, so there's no cascade risk —
  // see login/page.tsx's matching comment for the fuller reasoning.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prefill = params.get("email");
    if (prefill) setEmail(prefill);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.reason === "already_registered") {
          toast.error("That email's already registered — let's sign you in instead.");
          const next = new URLSearchParams(window.location.search).get("next");
          router.push(`/login?email=${encodeURIComponent(email)}${next ? `&next=${encodeURIComponent(next)}` : ""}`);
          return;
        }
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }

      saveSession(data.token, data.user);
      toast.success(`Welcome to Veyra, ${data.user.name ?? data.user.email}.`);
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next && next.startsWith("/") ? next : "/dashboard");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-edge bg-surface2 p-10 text-ink md:flex dark:border-none dark:bg-[#0F1115] dark:text-white">
        <BrandLink size={22} />
        <div className="absolute inset-0 opacity-70">
          <SignalMotif />
        </div>
        <div className="relative max-w-sm">
          <p className="font-display text-2xl font-medium leading-snug">
            Set up your room in under a minute.
          </p>
          <p className="mt-3 text-sm text-ink/60 dark:text-white/60">
            Create an account, generate a link, and bring your team in.
          </p>
        </div>
      </div>

      <div className="flex flex-col justify-between p-6 sm:p-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 md:hidden">
            <BrandLink size={22} />
          </div>
          <div />
        </div>

        <div className="mx-auto w-full max-w-sm">
          <h1 className="font-display text-2xl font-semibold">Create your account</h1>
          <p className="mt-1 text-sm text-muted">Start hosting meetings in minutes.</p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-muted">Full name</label>
              <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2.5 focus-within:border-accent">
                <User size={16} className="text-muted" />
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ayesha Khan"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted/60"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-muted">Email</label>
              <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2.5 focus-within:border-accent">
                <Mail size={16} className="text-muted" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted/60"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-muted">Password</label>
              <PasswordField
                value={password}
                onChange={setPassword}
                placeholder="At least 8 characters"
                minLength={8}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-accent">
              Sign in
            </Link>
          </p>
        </div>

        <div className="text-center text-xs text-muted/70 md:text-left">
          © 2026 Veyra. Built for teams that meet often.
        </div>
      </div>
    </div>
  );
}
