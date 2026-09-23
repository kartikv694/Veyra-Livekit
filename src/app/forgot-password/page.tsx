"use client";

/**
 * /forgot-password
 *
 * Three-step forgot-password flow, matching /login and /signup's split
 * layout. Each step is genuinely gated on the previous one succeeding:
 *   1. email -> request a 6-digit code (emailed via SMTP, see lib/mailer.ts)
 *   2. code only -> verified against the server BEFORE any password field
 *      is shown at all (separate endpoint, doesn't touch the password)
 *   3. new password + confirm -> only reachable after step 2 succeeds
 */
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { toast } from "@/lib/toast";
import { SignalMotif } from "@/components/SignalMotif";
import { BrandLink } from "@/components/BrandLink";
import { PasswordField } from "@/components/PasswordField";

type Step = "email" | "code" | "reset";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleRequestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't send the reset code.");
        return;
      }
      toast.success("Check your email for the 6-digit code.");
      setStep("code");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/verify-reset-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Invalid or expired code.");
        return;
      }
      toast.success("Code verified.");
      setStep("reset");
    } catch {
      toast.error("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      // The code was already verified in the previous step — carried over
      // in state rather than asked for again; the endpoint still re-checks
      // it server-side regardless, so nothing is trusted from the client.
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't reset your password.");
        return;
      }
      toast.success("Password updated — log in with your new password.");
      router.push(`/login?email=${encodeURIComponent(email)}`);
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
          <h1 className="font-display text-2xl font-semibold">Reset your password</h1>
          <p className="mt-1 text-sm text-muted">
            {step === "email" && "Enter your account email and we'll send you a 6-digit code."}
            {step === "code" && `Enter the 6-digit code sent to ${email}.`}
            {step === "reset" && "Code verified — choose your new password."}
          </p>

          {step === "email" && (
            <form onSubmit={handleRequestCode} className="mt-8 space-y-4">
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
              <button
                type="submit"
                disabled={loading}
                className="mt-2 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {loading ? "Sending..." : "Send code"}
              </button>
            </form>
          )}

          {step === "code" && (
            <form onSubmit={handleVerifyCode} className="mt-8 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-muted">6-digit code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-center text-lg tracking-[0.5em] outline-none focus:border-accent"
                />
              </div>
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="mt-2 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {loading ? "Verifying..." : "Verify code"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setCode("");
                }}
                className="w-full text-center text-xs font-medium text-muted hover:text-ink"
              >
                Use a different email or resend the code
              </button>
            </form>
          )}

          {step === "reset" && (
            <form onSubmit={handleReset} className="mt-8 space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-muted">New password</label>
                <PasswordField value={newPassword} onChange={setNewPassword} placeholder="At least 6 characters" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-muted">Confirm new password</label>
                <PasswordField value={confirmPassword} onChange={setConfirmPassword} placeholder="Re-enter your new password" />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="mt-2 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {loading ? "Resetting..." : "Reset password"}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-sm text-muted">
            <Link href="/login" className="font-medium text-accent">
              Back to login
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
