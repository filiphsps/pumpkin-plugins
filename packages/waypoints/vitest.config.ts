import { definePluginVitestConfig } from '@pumpkin-plugins/test-harness/vitest';

export default definePluginVitestConfig({ unitGlobalSetup: ['./test/pinned-wit.ts'] });
