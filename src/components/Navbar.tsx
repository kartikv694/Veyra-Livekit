"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandLink } from "./BrandLink";
import { UserMenu } from "./UserMenu";
import { checkAuth, type SessionUser } from "@/lib/auth-client";

/**
 * Top navbar for the landing page. Checks auth itself on mount so it can
 * show the right thing without the page having to wire it through:
 *   - signed out -> "Log in" / "Sign up" buttons, top right.
 *   - signed in  -> the circular avatar menu (view profile / log out)
 *     instead, so a returning signed-in visitor isn't shown a login button.
 */
export function Navbar() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    checkAuth().then((u) => {
      if (cancelled) return;
      setUser(u);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="relative z-30 flex items-center justify-between px-6 py-5 sm:px-10">
      <BrandLink size={22} />
      <div className="flex items-center gap-3">
        {!checking &&
          (user ? (
            <UserMenu user={user} variant="dark" />
          ) : (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold transition-colors hover:border-white/40"
              >
                Log in
              </Link>
              <Link
                href="/signup"
                className="rounded-lg bg-[#6C77FF] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                Sign up
              </Link>
            </div>
          ))}
      </div>
    </header>
  );
}
