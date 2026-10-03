import { defineConfig } from 'wxt';
import { TEST_FIXTURE_MATCH, TEST_FIXTURE_HOST_PERMISSIONS, TEST_MODE } from './scripts/build-variants';

export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  dev: { server: { port: 3101 } },
  // No system browser exists on dev/CI machines; load .output/chrome-mv3-dev manually.
  webExt: { disabled: true },
  zip: {
    name: 'amplifyx',
    artifactTemplate: '{{name}}-{{browser}}-{{manifestVersion}}.zip',
    zipSources: false,
  },
  // The release manifest is fully derived from this config; the fixture match below is the only
  // thing that differs between builds.
  manifest: ({ browser }) => ({
    name: 'AmplifyX',
    description: 'Viral-potential assistant for X: live draft scoring and reply-target hints.',
    permissions: ['storage'],
    // Firefox MV3 gates content-script injection on host permissions covering the match;
    // Chrome treats these as granted at install, so the prompt text is unchanged.
    host_permissions: ['https://api.typesafe.ai/*', 'https://x.com/*', 'https://twitter.com/*'],
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'amplifyx@typesafe.ai',
          strict_min_version: '142.0',
          data_collection_permissions: { required: ['websiteContent'] },
        },
      },
    }),
  }),
  hooks: {
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.mode !== TEST_MODE) return;
      for (const script of manifest.content_scripts ?? []) {
        script.matches = [...(script.matches ?? []), TEST_FIXTURE_MATCH];
      }
      // Same Firefox MV3 rule for the fixture origin: without host permission the e2e
      // content script never injects in Firefox.
      manifest.host_permissions = [
        ...new Set([...(manifest.host_permissions ?? []), ...TEST_FIXTURE_HOST_PERMISSIONS]),
      ];
    },
  },
});
