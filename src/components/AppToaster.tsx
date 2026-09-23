"use client";

/**
 * Mounts the app's toast notification viewport (react-hot-toast). Render
 * this once near the root (see layout.tsx) — individual pages then just
 * `import { toast } from "@/lib/toast"` and call `toast.success(...)` /
 * `toast.error(...)`.
 *
 * The Toaster itself renders nothing visually here — every toast is a
 * fully custom component built in `src/lib/toast.tsx` (via `toast.custom`),
 * so it already carries its own theme-aware styling (CSS vars, so it
 * follows light/dark automatically) and its own close button. This
 * component's only job is to host react-hot-toast's positioning/portal.
 */
import { Toaster } from "react-hot-toast";

export function AppToaster() {
  return <Toaster position="top-center" gutter={8} />;
}
