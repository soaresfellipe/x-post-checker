import { REQUIRED_CONTENT_MATCHES, REQUIRED_HOST_PERMISSION } from './build-variants';

interface ManifestLike {
  manifest_version?: number;
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
  background?: { service_worker?: string; scripts?: string[] };
}

const LOCAL_HOST_PATTERN = /localhost|127\.0\.0\.1|\[::1\]/;

/** Returns human-readable problems; an empty list means the release manifest is acceptable. */
export function checkReleaseManifest(manifest: ManifestLike): string[] {
  const problems: string[] = [];

  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version must be 3, got ${String(manifest.manifest_version)}`);
  }
  if (!manifest.host_permissions?.includes(REQUIRED_HOST_PERMISSION)) {
    problems.push(`host_permissions is missing ${REQUIRED_HOST_PERMISSION}`);
  }

  const matches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
  for (const required of REQUIRED_CONTENT_MATCHES) {
    if (!matches.includes(required)) problems.push(`content script matches is missing ${required}`);
  }

  if (LOCAL_HOST_PATTERN.test(JSON.stringify(manifest))) {
    problems.push('release manifest references a localhost URL');
  }
  return problems;
}
