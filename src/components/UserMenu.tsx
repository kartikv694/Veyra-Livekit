"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { User as UserIcon, LogOut } from "lucide-react";
import { toast } from "@/lib/toast";
import { clearSession, type SessionUser } from "@/lib/auth-client";

function initials(user: SessionUser): string {
  const source = user.name ?? user.email;
  return source
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

interface UserMenuProps {
  user: SessionUser;
  /** "themed" (default) follows the app's light/dark CSS variables — use
   *  on pages like /dashboard. "dark" forces the white-on-dark styling the
   *  landing page always uses, regardless of the theme toggle. */
  variant?: "themed" | "dark";
}

/**
 * The circular initials avatar shown top-right once a user is signed in.
 * Clicking it opens a dropdown with "View profile" (their account details)
 * and "Log out".
 */
export function UserMenu({ user, variant = "themed" }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dark = variant === "dark";

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const handleLogout = () => {
    clearSession();
    toast.info("Signed out.");
    // A full reload, not router.push + router.refresh — refresh() only
    // re-fetches server data, it doesn't force already-mounted client
    // components to remount. Navbar sets its own "user" state once on
    // mount (via checkAuth()) and never re-checks it afterward, so a soft
    // refresh left it showing the stale logged-in avatar even though the
    // token really had been cleared. A full reload guarantees every
    // component starts clean. router.push() (what this lint rule
    // suggests) is exactly what was tried before and caused that stale
    // state — not an oversight, so suppressed rather than "fixed".
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/";
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-haspopup="true"
        aria-expanded={open}
        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
          dark
            ? "bg-white/10 text-white hover:bg-white/20"
            : "bg-surface2 text-ink hover:bg-surface2/70"
        }`}
      >
        {initials(user)}
      </button>

      {open && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className={`absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-lg border shadow-lg ${
            dark ? "border-white/10 bg-[#171A21] text-white" : "border-edge bg-surface text-ink"
          }`}
        >
          <button
            onClick={() => {
              setShowProfile(true);
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm ${
              dark ? "hover:bg-white/10" : "hover:bg-surface2"
            }`}
          >
            <UserIcon size={15} /> View profile
          </button>
          <button
            onClick={handleLogout}
            className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-red-500 ${
              dark ? "hover:bg-white/10" : "hover:bg-surface2"
            }`}
          >
            <LogOut size={15} /> Log out
          </button>
        </div>
      )}

      {showProfile && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => setShowProfile(false)}
        >
          <div
            className={`w-full max-w-sm rounded-xl border p-6 ${
              dark ? "border-white/10 bg-[#171A21] text-white" : "border-edge bg-surface text-ink"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div
                className={`flex h-16 w-16 items-center justify-center rounded-full text-lg font-semibold ${
                  dark ? "bg-white/10" : "bg-surface2"
                }`}
              >
                {initials(user)}
              </div>
              <h2 className="mt-3 font-display text-lg font-semibold">{user.name ?? "Unnamed"}</h2>
              <p className={`text-sm ${dark ? "text-white/60" : "text-muted"}`}>{user.email}</p>
            </div>

            <dl className="mt-5 space-y-3 text-sm">
              <div className={`flex justify-between border-b pb-2 ${dark ? "border-white/10" : "border-edge"}`}>
                <dt className={dark ? "text-white/60" : "text-muted"}>Full name</dt>
                <dd className="font-medium">{user.name ?? "—"}</dd>
              </div>
              <div className={`flex justify-between border-b pb-2 ${dark ? "border-white/10" : "border-edge"}`}>
                <dt className={dark ? "text-white/60" : "text-muted"}>Username</dt>
                <dd className="font-medium">{user.username ?? "—"}</dd>
              </div>
              <div className={`flex justify-between border-b pb-2 ${dark ? "border-white/10" : "border-edge"}`}>
                <dt className={dark ? "text-white/60" : "text-muted"}>Email</dt>
                <dd className="font-medium">{user.email}</dd>
              </div>
              <div className="flex justify-between">
                <dt className={dark ? "text-white/60" : "text-muted"}>User ID</dt>
                <dd className="font-medium">#{user.id}</dd>
              </div>
            </dl>

            <button
              onClick={() => setShowProfile(false)}
              className={`mt-6 w-full rounded-lg border py-2.5 text-sm font-semibold transition-colors ${
                dark
                  ? "border-white/20 hover:border-white/40"
                  : "border-edge hover:border-accent hover:text-accent"
              }`}
            >
              Close
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
