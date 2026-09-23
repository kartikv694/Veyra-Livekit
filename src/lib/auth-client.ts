"use client";

/** Client-side JWT session helpers. */

const TOKEN_KEY = "veyra_token";
const USER_KEY = "veyra_user";
const AUTH_CACHE_MS = 10_000;

export interface SessionUser {
  id: number;
  name: string | null;
  email: string;
  username: string | null;
}

let cachedAuth: { token: string; user: SessionUser; expiresAt: number } | null = null;
let authRequest: Promise<SessionUser | null> | null = null;

function invalidateAuthCache(): void {
  cachedAuth = null;
  authRequest = null;
}

export function saveSession(token: string, user: SessionUser): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  cachedAuth = { token, user, expiresAt: Date.now() + AUTH_CACHE_MS };
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getCachedUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  if (cachedAuth && cachedAuth.token === getToken() && cachedAuth.expiresAt > Date.now()) return cachedAuth.user;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  invalidateAuthCache();
}

/**
 * Verifies the stored JWT once per short client-side window. Concurrent
 * callers share the same in-flight request, preventing Navbar + page guards
 * from firing duplicate /api/auth/me requests during navigation/dev reloads.
 */
export function checkAuth(): Promise<SessionUser | null> {
  const token = getToken();
  if (!token) {
    invalidateAuthCache();
    return Promise.resolve(null);
  }

  if (cachedAuth && cachedAuth.token === token && cachedAuth.expiresAt > Date.now()) {
    return Promise.resolve(cachedAuth.user);
  }

  if (authRequest) return authRequest;

  authRequest = (async () => {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        window.localStorage.removeItem(TOKEN_KEY);
        window.localStorage.removeItem(USER_KEY);
        cachedAuth = null;
        return null;
      }
      const data = (await res.json()) as { user: SessionUser };
      cachedAuth = { token, user: data.user, expiresAt: Date.now() + AUTH_CACHE_MS };
      window.localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      return data.user;
    } catch {
      return null;
    } finally {
      authRequest = null;
    }
  })();

  return authRequest;
}

export function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
