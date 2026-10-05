import { createServer } from 'node:http';
import { builtPluginPath, startPumpkin } from '@pumpkin-plugins/test-harness';
import { describe, expect, it } from 'vitest';

describe('WASI HTTP in Pumpkin', () => {
    it('polls a delayed, chunked response and survives HTTP and JSON errors', async () => {
        const http = createServer((req, res) => {
            if (req.url === '/status') {
                res.writeHead(503).end();
            } else if (req.url === '/invalid') {
                res.end('not JSON');
            } else {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.write('{"message":');
                const timer = setTimeout(() => res.end('"héllo"}'), 300);
                res.on('close', () => clearTimeout(timer));
            }
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        try {
            const address = http.address();
            if (!address || typeof address === 'string') throw new Error('Expected an HTTP port');
            const server = await startPumpkin({
                plugins: [builtPluginPath(process.cwd())],
                config: { plugins: { allowed_permissions: ['http.outbound'] } }
            });
            try {
                for (const [path, expected] of [
                    ['/json', /Fixture HTTP result: {"message":"héllo"}/],
                    ['/status', /Fixture HTTP result:.*Market returned HTTP 503/],
                    ['/invalid', /Fixture HTTP result:.*parse response JSON/]
                ] as const) {
                    const from = server.lines.length;
                    server.command(`checkhttp http://127.0.0.1:${address.port}${path}`);
                    await server.waitForLog(/Fixture HTTP request scheduled/, 5000, from);
                    await server.waitForLog(expected, 10_000, from);
                }
                expect(server.errors()).toEqual([]);
            } finally {
                await server.stop();
            }
        } finally {
            http.closeAllConnections();
            await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
