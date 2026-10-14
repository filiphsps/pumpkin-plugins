import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: { include: ['test/**/*.itest.ts'], testTimeout: 300_000 },
});
