import { describe, expect, it } from 'vitest';
import { checkReleaseManifest } from '../../scripts/manifest-check';

const validManifest = {
  manifest_version: 3,
  host_permissions: ['https://api.typesafe.ai/*'],
  content_scripts: [{ matches: ['https://x.com/*', 'https://twitter.com/*'] }],
};

describe('checkReleaseManifest', () => {
  it('accepts a manifest with both X domains and the Jev host permission', () => {
    expect(checkReleaseManifest(validManifest)).toEqual([]);
  });

  it('flags a missing twitter.com match', () => {
    const problems = checkReleaseManifest({
      ...validManifest,
      content_scripts: [{ matches: ['https://x.com/*'] }],
    });
    expect(problems).toContain('content script matches is missing https://twitter.com/*');
  });

  it('flags a missing api.typesafe.ai host permission', () => {
    const problems = checkReleaseManifest({ ...validManifest, host_permissions: [] });
    expect(problems).toContain('host_permissions is missing https://api.typesafe.ai/*');
  });

  it('flags any localhost reference', () => {
    const problems = checkReleaseManifest({
      ...validManifest,
      content_scripts: [{ matches: [...validManifest.content_scripts[0]!.matches, 'http://localhost:3177/*'] }],
    });
    expect(problems).toContain('release manifest references a localhost URL');
  });

  it('flags a non-MV3 manifest', () => {
    expect(checkReleaseManifest({ ...validManifest, manifest_version: 2 })).toContain(
      'manifest_version must be 3, got 2',
    );
  });
});
