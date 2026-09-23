"use client";

/**
 * /login
 *
 * Sign-in screen: split layout with the brand panel (SignalMotif) on the
 * left and the credentials form on the right.
 *
 * Wired to POST /api/auth/login. Two behaviors worth noting:
 *   - If the email isn't registered (404, reason "not_registered"), we
 *     show that as a plain inline error ("Email ID not found.") and stay
 *     on this page — we don't assume the person wants to sign up and
 *     silently redirect them there.
 *   - On success we save the session and return to /dashboard, which picks
 *     up whatever intent (create/join) the landing page stashed before
 *     sending the visitor here.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { toast } from "@/lib/toast";
import { SignalMotif } from "@/components/SignalMotif";
import { BrandLink } from "@/components/BrandLink";
import { PasswordField } from "@/components/PasswordField";
import { saveSession } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Pick up ?email= from a /signup redirect (already-registered email).
  // Deliberately an effect, not a useState lazy initializer reading
  // window directly: this page is statically prerendered, so the
  // initializer would run with window undefined at build/server-render
  // time and a real value on the client — a hydration mismatch.
  // useSearchParams() avoids that but needs a Suspense boundary around
  // an otherwise-static page for no real benefit here. Effect-after-mount
  // is what actually keeps server and client markup identical; the
  // "state update in an effect" the linter flags is safe in this
  // specific case since it can only ever run once (empty deps) and
  // can't cascade.
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
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.reason === "not_registered") {
          toast.error("Email ID not found.");
          return;
        }
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }

      saveSession(data.token, data.user);
      toast.success(`Welcome back, ${data.user.name ?? data.user.email}.`);
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
            Every seat connected, one room at a time.
          </p>
          <p className="mt-3 text-sm text-ink/60 dark:text-white/60">
            Host, present, and talk with your team in real time — no downloads required.
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
          <h1 className="font-display text-2xl font-semibold">Welcome back</h1>
          <p className="mt-1 text-sm text-muted">Sign in to create or join a meeting.</p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
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
              <div className="mb-1.5 flex items-center justify-between">
                <label className="block text-sm font-medium text-muted">Password</label>
                <Link href="/forgot-password" className="text-xs font-medium text-accent">
                  Forgot password?
                </Link>
              </div>
              <PasswordField value={password} onChange={setPassword} placeholder="••••••••" />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-accent">
              Create one
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
