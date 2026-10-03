import { defineConfig } from 'wxt';
import { TEST_FIXTURE_MATCH, TEST_MODE } from './scripts/build-variants';

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
    host_permissions: ['https://api.typesafe.ai/*'],
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
    },
  },
});
