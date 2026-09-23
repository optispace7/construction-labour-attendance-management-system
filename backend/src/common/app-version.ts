/**
 * Which build of the gate app sent a request — recorded on every scan's audit
 * row and as each phone's version on the Devices page.
 *
 * Builds from 2026-09-23 on send an `x-app-version` header on every request.
 * Anything older sends nothing and is still served in full — phones in the
 * field update when someone installs the new APK, not when we deploy — so the
 * absence is recorded as `legacy` rather than refused.
 */
export const APP_VERSION_HEADER = 'x-app-version';
export const LEGACY_APP_VERSION = 'legacy';

/** The header's value, trimmed and bounded, or `legacy` when it is missing. */
export function appVersionFrom(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = raw?.trim().slice(0, 40);
  return value ? value : LEGACY_APP_VERSION;
}
