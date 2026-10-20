import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { builtPluginPath, startPumpkin } from '@pumpkin-plugins/test-harness';
import { describe, expect, it } from 'vitest';

const { version: currentVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
};

describe('update-check in Pumpkin', () => {
    it('runs the scheduled Market check after the plugin loads', async () => {
        const requests: string[] = [];
        const market = createServer((req, res) => {
            requests.push(req.url ?? '');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ latest_version: '1.3.0', update_available: true }));
        });
        await new Promise<void>((resolve) => market.listen(0, '127.0.0.1', resolve));
        try {
            const address = market.address();
            if (!address || typeof address === 'string') throw new Error('Expected an HTTP port');
            const server = await startPumpkin({
                plugins: [builtPluginPath(process.cwd())],
                config: { plugins: { allowed_permissions: ['http.outbound', 'fs.read.data'] } },
                files: { 'plugins/data/UpdateCheckFixture/market-url.txt': `http://127.0.0.1:${address.port}` },
            });
            try {
                await server.waitForLog(/Loaded UpdateCheckFixture/, 10_000);
                const result = await server.waitForLog(/UpdateCheckFixture update available:/, 10_000);
                expect(result).toContain(`${currentVersion} -> 1.3.0`);
                expect(requests).toEqual([
                    `/api/v1/rest/check-update?plugin_name=UpdateCheckFixture&current_version=${currentVersion}`,
                ]);
                expect(server.errors()).toEqual([]);
            } finally {
                await server.stop();
            }
        } finally {
            market.closeAllConnections();
            await new Promise<void>((resolve, reject) => market.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
