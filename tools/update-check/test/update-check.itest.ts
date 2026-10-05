import { builtPluginPath, startPumpkin } from '@pumpkin-plugins/test-harness';
import { describe, expect, it } from 'vitest';

describe('update-check in Pumpkin', () => {
    it('bundles and runs the Market checker from a real plugin', async () => {
        const server = await startPumpkin({
            plugins: [builtPluginPath(process.cwd())],
            config: { plugins: { allowed_permissions: ['http.outbound'] } }
        });
        try {
            await server.waitForLog(/Loaded UpdateCheckFixture/, 10_000);
            const result = await server.waitForLog(/UpdateCheckFixture update available:/, 5000);
            expect(result).toContain('0.1.0 -> 1.3.0');
            expect(server.errors()).toEqual([]);
        } finally {
            await server.stop();
        }
    });
});
