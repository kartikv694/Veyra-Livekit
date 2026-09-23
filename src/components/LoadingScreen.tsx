import { BrandMark } from "./BrandMark";

interface LoadingScreenProps {
  /** Message shown under the spinner — e.g. "Joining meeting...",
   *  "Loading your meetings...". */
  message?: string;
  /** "dark" (default) matches the room/landing page's always-dark
   *  background. "themed" follows the app's light/dark CSS variables —
   *  use on pages like /dashboard. */
  variant?: "dark" | "themed";
}

/**
 * Full-screen branded loading state — replaces what used to be a blank
 * colored div while checking auth or waiting on a connection. Modeled on
 * Google Meet's "Joining..." screen: a spinner, the brand mark, and a
 * short status message, centered on the page.
 */
export function LoadingScreen({ message = "Loading...", variant = "dark" }: LoadingScreenProps) {
  const dark = variant === "dark";
  return (
    <div
      className={`flex min-h-screen flex-col items-center justify-center gap-4 ${
        dark ? "bg-[#0f1012] text-white" : "bg-bg text-fg"
      }`}
    >
      <div className="relative flex h-14 w-14 items-center justify-center">
        <span
          className={`absolute inset-0 animate-spin rounded-full border-2 border-t-transparent ${
            dark ? "border-white/25 border-t-white/80" : "border-edge border-t-accent"
          }`}
        />
        <BrandMark size={24} />
      </div>
      <p className={`text-sm ${dark ? "text-white/60" : "text-muted"}`}>{message}</p>
    </div>
  );
}
