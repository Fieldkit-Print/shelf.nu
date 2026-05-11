import { atom } from "jotai";

/**
 * Whether a workspace switch is in progress. The layout shows a spinner with
 * "Activating workspace…" while this is true.
 *
 * Default is `false`: upstream Shelf-nu had this defaulting to `true` and
 * relied on `disabledTeamOrg` short-circuiting the spinner check for users
 * with premium enabled. With `ENABLE_PREMIUM_FEATURES=false` (Fieldkit's
 * deployment) `disabledTeamOrg` is always false, so the spinner would never
 * clear. No code in the repo ever wrote this atom, so flipping the default
 * is safe — if anyone adds true org-switching UX later, they can set this
 * to `true` before the action and back to `false` when it completes.
 */
export const switchingWorkspaceAtom = atom(false);
