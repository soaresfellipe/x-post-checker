/**
 * Link classification for the draft link signal (M2 scrutiny round-1 fix): the external-link
 * penalty applies ONLY to off-platform destinations. Classification is destination-honest: a link
 * to x.com/twitter.com never counts as external, and an unexpanded t.co wrapper never gets a
 * guessed destination. The host lists live in `HEURISTIC_CONFIG.linkHosts` — no magic strings here.
 */
import { HEURISTIC_CONFIG } from './config';

/** Where a draft link points, decided by the destination host visible in the snapshot URL. */
export type LinkDestination = 'on-platform' | 'off-platform' | 'unknown';

/**
 * `on-platform`: x.com / twitter.com or any subdomain (status/profile/permalink destinations) —
 * the viewer stays on X. `off-platform`: any other visible destination — the configured minor
 * negative applies. `unknown`: an unexpanded t.co wrapper (or an unparseable string) — the
 * destination is NEVER guessed, so no penalty and the short URL stands as the signal value.
 */
export function classifyLink(url: string): LinkDestination {
  const host = linkHost(url);
  if (host === null) return 'unknown';
  if (matchesHostList(host, HEURISTIC_CONFIG.linkHosts.onPlatform)) return 'on-platform';
  if (matchesHostList(host, HEURISTIC_CONFIG.linkHosts.shortener)) return 'unknown';
  return 'off-platform';
}

/** Lowercased hostname of a snapshot URL, or null when the string parses as no URL at all. */
export function linkHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // Fall through: the extractor can emit scheme-less `www.` forms (parseUrls contract).
  }
  if (/^www\./i.test(url)) {
    try {
      return new URL(`https://${url}`).hostname.toLowerCase();
    } catch {
      // Unparseable even with a scheme: no host to classify.
    }
  }
  return null;
}

/** Exact-host or subdomain match: `x.com` covers `www.x.com` but never `xcompany.com`. */
function matchesHostList(host: string, hosts: readonly string[]): boolean {
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}
