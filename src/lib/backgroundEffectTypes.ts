/**
 * The lightweight, dependency-free half of the background-effects
 * feature: the effect type itself, comparing two effects, and the
 * gradient template list. Deliberately kept separate from
 * virtualBackground.ts, which pulls in @mediapipe/tasks-vision (a real,
 * sizeable ML library) — this file can be imported anywhere (including
 * plain top-level imports in the room page, for rendering the Background
 * swatches) without dragging that dependency into the build's module
 * graph. The actual MediaPipe-backed processor is dynamic-imported at
 * the one place it's used (applyBackgroundEffect), so it's only pulled
 * in — and only counted against build memory/bundle size — when a
 * background effect is actually applied, not just because the room page
 * exists.
 */

export type BackgroundEffect =
  | { type: "none" }
  | { type: "blur" }
  | { type: "gradient"; colors: [string, string] };

export function backgroundEffectsEqual(a: BackgroundEffect, b: BackgroundEffect): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "gradient" && b.type === "gradient") return a.colors[0] === b.colors[0] && a.colors[1] === b.colors[1];
  return true;
}

/** Solid, no-asset "template" backgrounds — gradients rather than photos,
 *  so there's nothing to source, license, or bundle. */
export const BACKGROUND_TEMPLATES: { id: string; label: string; colors: [string, string] }[] = [
  { id: "slate", label: "Slate", colors: ["#1f2937", "#0f172a"] },
  { id: "ocean", label: "Ocean", colors: ["#0ea5e9", "#1e3a8a"] },
  { id: "violet", label: "Violet", colors: ["#7c3aed", "#312e81"] },
  { id: "forest", label: "Forest", colors: ["#16a34a", "#14532d"] },
];
