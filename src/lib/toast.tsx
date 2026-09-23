"use client";

/**
 * Toast notifications, built on react-hot-toast.
 *
 * Every other file in the app imports `toast` from here instead of
 * directly from "react-hot-toast" — that's what makes every toast in the
 * app consistently styled with a visible close (×) button, since
 * react-hot-toast doesn't render one by default and we want one on every
 * toast, not just some. Call sites look identical to the old sonner API
 * (`toast.success(...)`, `toast.error(...)`, etc.) so switching libraries
 * didn't require touching every call site — just the import line.
 */
import hotToast, { type Toast } from "react-hot-toast";
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from "lucide-react";
import type { ElementType } from "react";

type Variant = "success" | "error" | "info" | "warning";

const ICONS: Record<Variant, ElementType> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

const ICON_COLORS: Record<Variant, string> = {
  success: "text-emerald-400",
  error: "text-red-400",
  info: "text-accent",
  warning: "text-amber-400",
};

function renderToast(t: Toast, variant: Variant, message: string) {
  const Icon = ICONS[variant];
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-ink shadow-lg transition-all ${
        t.visible ? "opacity-100" : "opacity-0"
      }`}
      style={{ minWidth: 280, maxWidth: 420 }}
    >
      <Icon size={18} className={`shrink-0 ${ICON_COLORS[variant]}`} />
      <span className="flex-1">{message}</span>
      <button
        onClick={() => hotToast.dismiss(t.id)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-surface2 hover:text-ink"
      >
        <X size={15} />
      </button>
    </div>
  );
}

function show(variant: Variant, message: string, durationMs?: number) {
  return hotToast.custom((t) => renderToast(t, variant, message), {
    duration: durationMs ?? (variant === "error" ? 5000 : 3500),
  });
}

export const toast = {
  success: (message: string) => show("success", message),
  error: (message: string) => show("error", message),
  info: (message: string) => show("info", message),
  warning: (message: string, durationMs?: number) => show("warning", message, durationMs),
  dismiss: hotToast.dismiss,
};

/**
 * A toast with Confirm/Cancel buttons instead of an auto-dismiss timer —
 * used for destructive host actions (remove participant, end meeting)
 * instead of a native window.confirm() popup. Resolves true/false.
 */
export function confirmToast(message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean, id: string) => {
      if (settled) return;
      settled = true;
      hotToast.dismiss(id);
      resolve(value);
    };

    hotToast.custom(
      (t) => (
        <div
          className={`flex items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-ink shadow-lg transition-all ${
            t.visible ? "opacity-100" : "opacity-0"
          }`}
          style={{ minWidth: 300, maxWidth: 420 }}
        >
          <AlertTriangle size={18} className="shrink-0 text-amber-400" />
          <span className="flex-1">{message}</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => finish(false, t.id)}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface2"
            >
              Cancel
            </button>
            <button
              onClick={() => finish(true, t.id)}
              className="rounded-md bg-red-500/90 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500"
            >
              {confirmLabel}
            </button>
          </div>
          <button
            onClick={() => finish(false, t.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-muted hover:bg-surface2 hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ),
      { duration: Infinity },
    );
  });
}

/**
 * A toast with a text input plus OK/Cancel — used in place of a native
 * window.prompt() popup (timer length, meeting passcode). Resolves the
 * entered string, or null if cancelled/dismissed.
 */
export function promptToast(message: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let value = defaultValue;
    const finish = (result: string | null, id: string) => {
      if (settled) return;
      settled = true;
      hotToast.dismiss(id);
      resolve(result);
    };

    hotToast.custom(
      (t) => (
        <div
          className={`flex flex-col gap-2 rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-ink shadow-lg transition-all ${
            t.visible ? "opacity-100" : "opacity-0"
          }`}
          style={{ minWidth: 300, maxWidth: 420 }}
        >
          <span>{message}</span>
          <input
            autoFocus
            defaultValue={defaultValue}
            onChange={(e) => {
              value = e.target.value;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") finish(value, t.id);
              if (e.key === "Escape") finish(null, t.id);
            }}
            className="rounded-md border border-edge bg-surface2 px-2.5 py-1.5 text-sm text-ink outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => finish(null, t.id)}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface2"
            >
              Cancel
            </button>
            <button
              onClick={() => finish(value, t.id)}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90"
            >
              OK
            </button>
          </div>
        </div>
      ),
      { duration: Infinity },
    );
  });
}
