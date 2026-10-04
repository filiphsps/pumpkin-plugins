import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const scripts = import.meta.dirname;
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(name = 'Published plugin') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-publish-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ pumpkinPlugin: { info: 'src/info.ts' } }));
    fs.writeFileSync(
        path.join(dir, 'src', 'info.ts'),
        `export const info = { name: ${JSON.stringify(name)} } as const;`
    );
    fs.writeFileSync(path.join(dir, 'plugin.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    return dir;
}

function run(dir, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'node',
            [path.join(scripts, 'publish-to-market.mjs'), dir, 'plug-v1.2.3', path.join(dir, 'plugin.wasm')],
            {
                env: { ...process.env, ...env }
            }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

function server(handler) {
    return new Promise((resolve) => {
        const instance = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const address = instance.address();
            resolve({ instance, url: `http://127.0.0.1:${address.port}` });
        });
    });
}

describe('publish-to-market', () => {
    it('warns, rather than failing, when the token is absent', async () => {
        const result = await run(fixture());
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /MARKET_API_TOKEN is not set/);
    });

    it('warns, rather than failing, when the plugin has no market listing', async () => {
        const market = await server((_, response) => response.end('[]'));
        try {
            const result = await run(fixture(), { MARKET_API_TOKEN: 'test-token', MARKET_API_URL: market.url });
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /no market listing named/);
        } finally {
            market.instance.close();
        }
    });

    it('warns, rather than failing, when the matching listing is still unpublished', async () => {
        const market = await server((_, response) =>
            response.end('[{"id":42,"name":"Published plugin","version":null}]')
        );
        try {
            const result = await run(fixture(), { MARKET_API_TOKEN: 'test-token', MARKET_API_URL: market.url });
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /has not been published yet/);
        } finally {
            market.instance.close();
        }
    });

    it('uploads the wasm and stable version to its matching listing', async () => {
        const requests = [];
        const market = await server((request, response) => {
            requests.push(request);
            if (request.url === '/plugins?limit=100') {
                response.end('[{"id":42,"name":"Published plugin","version":"1.0.0"}]');
            } else {
                let body = '';
                request.setEncoding('utf8');
                request.on('data', (chunk) => (body += chunk));
                request.on('end', () => {
                    request.body = body;
                    response.end('{}');
                });
            }
        });
        try {
            const result = await run(fixture(), { MARKET_API_TOKEN: 'test-token', MARKET_API_URL: market.url });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(requests[1].method, 'PUT');
            assert.equal(requests[1].url, '/plugins/42');
            assert.equal(requests[1].headers.authorization, 'Bearer test-token');
            assert.match(requests[1].body, /name="metadata"\r\n\r\n{"version":"1.2.3","track":"stable"}/);
            assert.match(result.stdout, /Published Published plugin 1\.2\.3 to market listing 42/);
        } finally {
            market.instance.close();
        }
    });
});
