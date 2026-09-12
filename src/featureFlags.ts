/** In-tree feature flags for incrementally re-enabling work that isn't trusted
 *  yet. Flip a flag to `true`, build, and test one slice at a time.
 *  See ../NEXT-STEPS.md (Steps 4 and 7). */

/**
 * Per-occurrence recurring-event editing/deletion: the "This event" /
 * "This and following" prompt and single-occurrence delete (EXDATE /
 * RECURRENCE-ID overrides).
 *
 * OFF (current baseline): recurring events still render as occurrences and
 * whole-series ("All events") create / edit / delete work normally; the flaky
 * per-occurrence prompt is simply not offered — editing or deleting a recurring
 * event applies to the whole series.
 *
 * The underlying implementation stays in the tree — NOT deleted — including
 * `updateEventScoped` / `deleteEventScoped` in App.tsx and the EXDATE/override
 * serialization in caldav.ts / ical.ts, plus the git tag
 * `recurring-full-2026-07-16` as a pristine reference. Re-enabling a slice is
 * flip-the-flag + test (Step 7), not re-typing code.
 */
export const RECURRING_PER_OCCURRENCE = false;

/**
 * Built-in sync server (bundled Radicale) — Phase B2+ in DAYNIZER-SERVER-PLAN.md.
 *
 * NOTE: the server runs in the Electron MAIN process, which can't import this
 * renderer module at runtime, so the AUTHORITATIVE flag lives main-side as
 * `SERVER_BUILTIN` in `electron/serverManager.ts`. This constant is the
 * renderer-side mirror for when the onboarding/status UI arrives (C1/C3); until
 * then there's no server UI to gate. Keep the two in sync — flip both together.
 */
export const SERVER_BUILTIN = false;
