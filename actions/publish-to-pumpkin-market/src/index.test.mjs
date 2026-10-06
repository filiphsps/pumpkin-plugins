import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const testDir = import.meta.dirname;
const publisher = path.resolve(testDir, 'index.mjs');
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-publish-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'plugin.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    return dir;
}

function run(dir, env = {}) {
    return new Promise((resolve, reject) => {
        const childEnv = { ...process.env, ...env, GITHUB_STEP_SUMMARY: env.GITHUB_STEP_SUMMARY };
        const child = spawn('node', [publisher], { cwd: dir, env: childEnv });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

function inputs(extra = {}) {
    return {
        'INPUT_PLUGIN-NAME': 'Published plugin',
        INPUT_VERSION: '1.2.3',
        'INPUT_WASM-FILE': 'plugin.wasm',
        ...extra
    };
}

function server(handler) {
    return new Promise((resolve) => {
        const instance = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const address = instance.address();
            resolve({ instance, url: `http://127.0.0.1:${address.port}` });
        });
    });
}

describe('publish-to-market action', () => {
    it('fails when the token is absent and warn is not enabled', async () => {
        const dir = fixture();
        const result = await run(dir, inputs());
        assert.equal(result.status, 1);
        assert.match(result.stderr, /api-token input is empty/);
    });

    it('warns and succeeds when the token is absent and warn is enabled', async () => {
        const dir = fixture();
        const result = await run(dir, inputs({ INPUT_WARN: 'true' }));
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /::warning .*api-token input is empty/);
    });

    it('fails when the plugin has no market listing and warn is not enabled', async () => {
        const market = await server((request, response) => {
            if (request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else response.end('[]');
        });
        try {
            const dir = fixture();
            const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));
            assert.equal(result.status, 1);
            assert.match(result.stderr, /no Market listing named/);
        } finally {
            market.instance.close();
        }
    });

    it('warns and succeeds when the plugin has no listing and warn is enabled', async () => {
        const market = await server((request, response) => {
            if (request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else response.end('[]');
        });
        try {
            const dir = fixture();
            const result = await run(
                dir,
                inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url, INPUT_WARN: 'true' })
            );
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /::warning .*no Market listing named/);
        } finally {
            market.instance.close();
        }
    });

    it('fails when the matching listing is unpublished and warn is not enabled', async () => {
        const market = await server((request, response) => {
            if (request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else response.end('[{"id":42,"name":"Published plugin","version":null}]');
        });
        try {
            const dir = fixture();
            const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));
            assert.equal(result.status, 1);
            assert.match(result.stderr, /has not been published yet/);
        } finally {
            market.instance.close();
        }
    });

    it('warns and succeeds when the matching listing is unpublished and warn is enabled', async () => {
        const market = await server((request, response) => {
            if (request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else response.end('[{"id":42,"name":"Published plugin","version":null}]');
        });
        try {
            const dir = fixture();
            const result = await run(
                dir,
                inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url, INPUT_WARN: 'true' })
            );
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /::warning .*has not been published yet/);
        } finally {
            market.instance.close();
        }
    });

    it('uploads the WASM and configurable version metadata to the matching listing', async () => {
        const requests = [];
        const market = await server((request, response) => {
            requests.push(request);
            if (request.method === 'GET' && request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else if (request.method === 'GET') {
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
            const dir = fixture();
            const summaryFile = path.join(dir, 'summary.md');
            const result = await run(
                dir,
                inputs({
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    INPUT_TRACK: 'beta',
                    'INPUT_RELEASE-NOTES': '## Fixed\n\n- Kept the ports open.',
                    GITHUB_STEP_SUMMARY: summaryFile
                })
            );
            assert.equal(result.status, 0, result.stderr);
            assert.equal(requests[0].method, 'GET');
            assert.equal(requests[0].url, '/api/v1/rest/plugins/Published%20plugin');
            assert.equal(requests[1].method, 'GET');
            assert.equal(requests[1].url, '/api/v1/rest/plugins?q=Published+plugin&limit=20');
            assert.equal(requests[2].method, 'PUT');
            assert.equal(requests[2].url, '/api/plugins/42');
            assert.equal(requests[2].headers.authorization, 'Bearer test-token');
            assert.match(
                requests[2].body,
                /name="metadata"\r\n\r\n{"version":"1.2.3","track":"beta","releaseNotes":"## Fixed\\n\\n- Kept the ports open\."}/
            );
            assert.equal(fs.existsSync(summaryFile), true, 'successful publishing should write a CI summary');
            assert.match(result.stdout, /Published Published plugin 1\.2\.3 to Market listing 42/);
        } finally {
            market.instance.close();
        }
    });

    it('fails when the Market API rejects the upload', async () => {
        const market = await server((request, response) => {
            if (request.method === 'GET' && request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else if (request.method === 'GET') {
                response.end('[{"id":42,"name":"Published plugin","version":"1.0.0"}]');
            } else {
                response.statusCode = 503;
                response.end('try again');
            }
        });
        try {
            const dir = fixture();
            const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));
            assert.equal(result.status, 1);
            assert.match(result.stderr, /Market update for Published plugin failed \(503\): try again/);
        } finally {
            market.instance.close();
        }
    });

    it('fails when the WASM path does not exist', async () => {
        const dir = fixture();
        const result = await run(dir, inputs({ 'INPUT_WASM-FILE': 'missing.wasm' }));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /WASM file not found/);
    });
});
