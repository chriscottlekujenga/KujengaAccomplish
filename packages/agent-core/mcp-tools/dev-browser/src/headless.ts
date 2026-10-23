/**
 * Whether a graphical display is reachable in this process environment.
 * Chromium launches through Playwright require one of the two session
 * variables; both are absent in daemon processes hosted by systemd --user.
 */
export function hasGraphicalDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Headless resolution for the sidecar entry. `HEADLESS` stays the explicit
 * override (true/false). The default adapts to the environment: headed
 * (the interactive, visible-window UX) when a display exists; headless when
 * none does — a headed Chromium cannot launch in a display-less process
 * (Playwright exits immediately and every browser tool call surfaces as an
 * HTTP 500), and the production daemon runs display-less under systemd --user
 * while its verification harnesses inherited a graphical session, which is
 * why all prior suites passed (T7 live finding, 2026-10-23).
 */
export function resolveHeadlessFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HEADLESS === 'true') {
    return true;
  }
  if (env.HEADLESS === 'false') {
    return false;
  }
  return !hasGraphicalDisplay(env);
}
