import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            { extends: true, test: { name: 'unit', include: ['bin/**/*.test.ts'] } },
            { extends: true, test: { name: 'integration', include: ['test/**/*.itest.ts'] } }
        ]
    }
});
