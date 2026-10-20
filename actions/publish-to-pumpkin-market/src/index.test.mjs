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
        const child = spawn(process.execPath, [publisher], { cwd: dir, env: childEnv(dir, env) });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

// Start from a minimal environment so the runner's own INPUT_* and GITHUB_* values can't reach the action.
function childEnv(dir, env) {
    const base = { PATH: process.env.PATH, HOME: process.env.HOME };
    if (process.env.SystemRoot) base.SystemRoot = process.env.SystemRoot;
    return {
        ...base,
        GITHUB_OUTPUT: path.join(dir, 'unread-outputs.txt'),
        GITHUB_STEP_SUMMARY: path.join(dir, 'unread-summary.md'),
        ...env,
    };
}

function inputs(extra = {}) {
    return {
        'INPUT_PLUGIN-NAME': 'Published plugin',
        INPUT_VERSION: '1.2.3',
        'INPUT_WASM-FILE': 'plugin.wasm',
        ...extra,
    };
}

function readOutputs(file) {
    return Object.fromEntries(
        [...fs.readFileSync(file, 'utf8').matchAll(/^([a-z-]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm)].map((match) => [
            match[1],
            match[3],
        ]),
    );
}

function server(handler) {
    return new Promise((resolve) => {
        const instance = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const address = instance.address();
            resolve({ instance, url: `http://127.0.0.1:${address.port}` });
        });
    });
}

function uploadedFile(body, contentType, filename) {
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
    assert.ok(boundaryMatch, 'multipart content type should include a boundary');
    const header = body.indexOf(Buffer.from(`filename="${filename}"`));
    assert.notEqual(header, -1, `multipart body should include ${filename}`);
    const headerStart = body.lastIndexOf(Buffer.from('Content-Disposition:'), header);
    const start = body.indexOf(Buffer.from('\r\n\r\n'), header) + 4;
    const end = body.indexOf(Buffer.from(`\r\n--${boundaryMatch[1] ?? boundaryMatch[2]}`), start);
    assert.notEqual(headerStart, -1, 'file part should include a content disposition header');
    assert.ok(start >= 4, 'file part should include a header/body separator');
    assert.notEqual(end, -1, 'file part should end at the multipart boundary');
    return {
        headers: body.subarray(headerStart, start - 4).toString('utf8'),
        bytes: body.subarray(start, end),
    };
}

describe('publish-to-market action', () => {
    it('requires exactly one of plugin-name or plugin-id', async () => {
        const dir = fixture();
        const noSelector = await run(dir, {
            INPUT_VERSION: '1.2.3',
            'INPUT_WASM-FILE': 'plugin.wasm',
            'INPUT_API-TOKEN': 'test-token',
        });
        assert.equal(noSelector.status, 1);
        assert.match(noSelector.stderr, /Set exactly one of plugin-name or plugin-id/);

        const bothSelectors = await run(
            dir,
            inputs({ 'INPUT_PLUGIN-ID': 'public-test-id', 'INPUT_API-TOKEN': 'test-token' }),
        );
        assert.equal(bothSelectors.status, 1);
        assert.match(bothSelectors.stderr, /Set exactly one of plugin-name or plugin-id/);
    });

    it('fails when the token is absent and warn is not enabled', async () => {
        const dir = fixture();
        const result = await run(dir, inputs());
        assert.equal(result.status, 1);
        assert.match(result.stderr, /api-token input is empty/);
    });

    it('warns and succeeds when the token is absent and warn is enabled', async () => {
        const dir = fixture();
        const outputFile = path.join(dir, 'outputs.txt');
        const result = await run(dir, inputs({ INPUT_WARN: 'true', GITHUB_OUTPUT: outputFile }));
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /::warning .*api-token input is empty/);
        assert.deepEqual(readOutputs(outputFile), { status: 'skipped' });
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
            const outputFile = path.join(dir, 'outputs.txt');
            const result = await run(
                dir,
                inputs({
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    INPUT_WARN: 'true',
                    GITHUB_OUTPUT: outputFile,
                }),
            );
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /::warning .*no Market listing named/);
            assert.deepEqual(readOutputs(outputFile), { status: 'skipped' });
        } finally {
            market.instance.close();
        }
    });

    it('resolves names through exact case-insensitive search without a detail lookup', async () => {
        const requests = [];
        const market = await server((request, response) => {
            requests.push({ method: request.method, url: request.url });
            if (request.method === 'PUT') {
                response.end('{}');
                return;
            }
            response.end(
                JSON.stringify([
                    { id: 41, name: 'Published plugin extra', version: '1.0.0' },
                    { id: 42, name: 'PUBLISHED PLUGIN', version: '1.0.0' },
                ]),
            );
        });
        try {
            const dir = fixture();
            const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));

            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(
                requests.map(({ method, url }) => [method, url]),
                [
                    ['GET', '/api/v1/rest/plugins?q=Published+plugin&limit=20&page=1'],
                    ['PUT', '/api/plugins/42'],
                ],
            );
            assert.match(result.stdout, /Published PUBLISHED PLUGIN 1\.2\.3 to Market listing 42/);
        } finally {
            market.instance.close();
        }
    });

    it('rejects an ambiguous case-insensitive name search before upload', async () => {
        let uploads = 0;
        const market = await server((request, response) => {
            if (request.method === 'PUT') {
                uploads++;
                response.end('{}');
            } else {
                response.end(
                    JSON.stringify([
                        { id: 42, name: 'Published plugin', version: '1.0.0' },
                        { id: 43, name: 'PUBLISHED PLUGIN', version: '1.0.0' },
                    ]),
                );
            }
        });
        try {
            const dir = fixture();
            const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));

            assert.equal(result.status, 1, result.stdout);
            assert.match(result.stderr, /Market has multiple listings named/);
            assert.equal(uploads, 0, 'ambiguous search results must not trigger an upload');
        } finally {
            market.instance.close();
        }
    });

    it('fails a name search on HTTP 503 without warning when warn is enabled', async () => {
        const requests = [];
        const market = await server((request, response) => {
            requests.push({ method: request.method, url: request.url });
            if (request.url === '/api/v1/rest/plugins?q=Published+plugin&limit=20&page=1') {
                response.statusCode = 503;
                response.end('temporarily unavailable');
            } else response.end('{}');
        });
        try {
            const dir = fixture();
            const outputFile = path.join(dir, 'outputs.txt');
            const result = await run(
                dir,
                inputs({
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    INPUT_WARN: 'true',
                    GITHUB_OUTPUT: outputFile,
                }),
            );
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /Could not search Market plugins \(503\)/);
            assert.doesNotMatch(result.stdout + result.stderr, /::warning|status: skipped/);
            assert.equal(fs.existsSync(outputFile), false);
            assert.deepEqual(requests, [
                { method: 'GET', url: '/api/v1/rest/plugins?q=Published+plugin&limit=20&page=1' },
            ]);
        } finally {
            market.instance.close();
        }
    });

    it('rejects an oversized chunked listing before upload or success outputs', async () => {
        const dir = fixture();
        const outputFile = path.join(dir, 'outputs.txt');
        const listing = JSON.stringify({ id: 42, name: 'x'.repeat(1_048_576), version: '1.0.0' });
        let uploads = 0;
        let hadContentLength = false;
        const market = await server((request, response) => {
            if (request.method === 'PUT') {
                uploads++;
                response.end('{}');
                return;
            }
            hadContentLength = response.hasHeader('content-length');
            response.setHeader('content-type', 'application/json');
            response.write(listing.slice(0, 512 * 1024));
            response.end(listing.slice(512 * 1024));
        });

        try {
            const result = await run(
                dir,
                inputs({
                    'INPUT_PLUGIN-NAME': '',
                    'INPUT_PLUGIN-ID': 'public-test-id',
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    GITHUB_OUTPUT: outputFile,
                }),
            );

            assert.equal(hadContentLength, false, 'the oversized lookup should use chunked transfer');
            assert.equal(result.status, 1, result.stdout);
            assert.match(result.stderr, /JSON response exceeds 1048576 byte limit/);
            assert.equal(uploads, 0, 'oversized listing data must not trigger a WASM upload');
            assert.equal(fs.existsSync(outputFile), false, 'oversized listing data must not write success outputs');
        } finally {
            market.instance.close();
        }
    });

    it('rejects an oversized chunked name search before upload or success outputs', async () => {
        const dir = fixture();
        const outputFile = path.join(dir, 'outputs.txt');
        const listings = JSON.stringify([{ id: 42, name: 'x'.repeat(1_048_576), version: '1.0.0' }]);
        let uploads = 0;
        let hadContentLength = false;
        const market = await server((request, response) => {
            if (request.method === 'PUT') {
                uploads++;
                response.end('{}');
            } else if (request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else {
                hadContentLength = response.hasHeader('content-length');
                response.setHeader('content-type', 'application/json');
                response.write(listings.slice(0, 512 * 1024));
                response.end(listings.slice(512 * 1024));
            }
        });

        try {
            const result = await run(
                dir,
                inputs({
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    GITHUB_OUTPUT: outputFile,
                }),
            );

            assert.equal(hadContentLength, false, 'the oversized search should use chunked transfer');
            assert.equal(result.status, 1, result.stdout);
            assert.match(result.stderr, /JSON response exceeds 1048576 byte limit/);
            assert.equal(uploads, 0, 'oversized search results must not trigger a WASM upload');
            assert.equal(fs.existsSync(outputFile), false, 'oversized search results must not write success outputs');
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
            const outputFile = path.join(dir, 'outputs.txt');
            const result = await run(
                dir,
                inputs({
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    INPUT_WARN: 'true',
                    GITHUB_OUTPUT: outputFile,
                }),
            );
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /::warning .*has not been published yet/);
            assert.deepEqual(readOutputs(outputFile), {
                'listing-id': '42',
                'listing-name': 'Published plugin',
                status: 'skipped',
            });
        } finally {
            market.instance.close();
        }
    });

    for (const { kind, version } of [
        { kind: 'object', version: { malformed: true } },
        { kind: 'number', version: 42 },
    ]) {
        it(`rejects a name search result when version data has type ${kind}`, async () => {
            let uploads = 0;
            const listing = { id: 42, name: 'Published plugin', version };
            const market = await server((request, response) => {
                if (request.method === 'PUT') {
                    uploads++;
                    response.end('{}');
                } else response.end(JSON.stringify([listing]));
            });
            try {
                const dir = fixture();
                const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));
                assert.equal(result.status, 1, result.stdout);
                assert.match(result.stderr, /Market plugin lookup response was not a valid listing/);
                assert.equal(uploads, 0, 'malformed listing data must not trigger an upload');
            } finally {
                market.instance.close();
            }
        });
    }

    it('uploads a listing with a string version from name search', async () => {
        let uploads = 0;
        const market = await server((request, response) => {
            if (request.method === 'PUT') {
                uploads++;
                response.end('{}');
            } else response.end('[{"id":42,"name":"Published plugin","version":"1.0.0"}]');
        });
        try {
            const dir = fixture();
            const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));
            assert.equal(result.status, 0, result.stderr);
            assert.equal(uploads, 1, 'a valid published listing should receive the upload');
        } finally {
            market.instance.close();
        }
    });

    it('skips the upload and reports success when the listing already has the version', async () => {
        let uploads = 0;
        const market = await server((request, response) => {
            if (request.method === 'PUT') {
                uploads++;
                response.statusCode = 409;
                response.end('{}');
            } else response.end('[{"id":42,"name":"Published plugin","version":"1.2.3"}]');
        });
        try {
            const dir = fixture();
            const outputFile = path.join(dir, 'outputs.txt');
            const result = await run(
                dir,
                inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url, GITHUB_OUTPUT: outputFile }),
            );
            assert.equal(result.status, 0, result.stderr);
            assert.equal(uploads, 0, 'a retried job must not upload the same version again');
            assert.match(result.stdout, /already/);
            assert.deepEqual(readOutputs(outputFile), {
                'listing-id': '42',
                'listing-name': 'Published plugin',
                status: 'success',
                'published-version': '1.2.3',
            });
        } finally {
            market.instance.close();
        }
    });

    it('does not upload a name search match whose version is null', async () => {
        let uploads = 0;
        const market = await server((request, response) => {
            if (request.method === 'PUT') {
                uploads++;
                response.end('{}');
            } else response.end('[{"id":42,"name":"Published plugin","version":null}]');
        });
        try {
            const dir = fixture();
            const result = await run(dir, inputs({ 'INPUT_API-TOKEN': 'test-token', 'INPUT_API-URL': market.url }));
            assert.equal(result.status, 1);
            assert.match(result.stderr, /has not been published yet/);
            assert.equal(uploads, 0, 'an unpublished listing must not receive the upload');
        } finally {
            market.instance.close();
        }
    });

    it('uploads the WASM and configurable version metadata to the matching listing', async () => {
        const requests = [];
        const market = await server((request, response) => {
            requests.push(request);
            if (request.method === 'GET') {
                response.end('[{"id":42,"name":"Published plugin","version":"1.0.0"}]');
            } else {
                const chunks = [];
                request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                request.on('end', () => {
                    request.rawBody = Buffer.concat(chunks);
                    request.body = request.rawBody.toString('utf8');
                    response.end('{}');
                });
            }
        });
        try {
            const dir = fixture();
            const summaryFile = path.join(dir, 'summary.md');
            const outputFile = path.join(dir, 'outputs.txt');
            const result = await run(
                dir,
                inputs({
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    INPUT_TRACK: 'beta',
                    'INPUT_RELEASE-NOTES': '## Fixed\n\n- Kept the ports open.',
                    GITHUB_STEP_SUMMARY: summaryFile,
                    GITHUB_OUTPUT: outputFile,
                }),
            );
            assert.equal(result.status, 0, result.stderr);
            assert.equal(requests[0].method, 'GET');
            assert.equal(requests[0].url, '/api/v1/rest/plugins?q=Published+plugin&limit=20&page=1');
            assert.equal(requests[1].method, 'PUT');
            assert.equal(requests[1].url, '/api/plugins/42');
            assert.equal(requests[1].headers.authorization, 'Bearer test-token');
            const wasmPart = uploadedFile(requests[1].rawBody, requests[1].headers['content-type'], 'plugin.wasm');
            assert.match(wasmPart.headers, /Content-Type: application\/wasm/i);
            assert.deepEqual(wasmPart.bytes, fs.readFileSync(path.join(dir, 'plugin.wasm')));
            assert.match(
                requests[1].body,
                /name="metadata"\r\n\r\n{"version":"1.2.3","track":"beta","releaseNotes":"## Fixed\\n\\n- Kept the ports open\."}/,
            );
            assert.equal(fs.existsSync(summaryFile), true, 'successful publishing should write a CI summary');
            assert.match(result.stdout, /Published Published plugin 1\.2\.3 to Market listing 42/);
            assert.deepEqual(readOutputs(outputFile), {
                'listing-id': '42',
                'listing-name': 'Published plugin',
                status: 'success',
                'published-version': '1.2.3',
            });
        } finally {
            market.instance.close();
        }
    });

    it('keeps untrusted listing text and versions out of extra log and summary lines', async () => {
        const listingName = 'Published plugin\n### ::error::injected';
        const version = '1.2.3\n::error::injected';
        const market = await server((_request, response) => {
            response.end(JSON.stringify({ id: 42, name: listingName, version: '1.0.0' }));
        });
        try {
            const dir = fixture();
            const summaryFile = path.join(dir, 'summary.md');
            const result = await run(
                dir,
                inputs({
                    'INPUT_PLUGIN-NAME': '',
                    'INPUT_PLUGIN-ID': '42',
                    INPUT_VERSION: version,
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    GITHUB_STEP_SUMMARY: summaryFile,
                }),
            );

            assert.equal(result.status, 0, result.stderr);
            assert.match(
                result.stdout,
                /Published Published plugin%0A### ::error::injected 1\.2\.3%0A::error::injected to Market listing 42\./,
            );
            assert.equal(result.stdout.trimEnd().split(/\r?\n/).length, 1);
            const summary = fs.readFileSync(summaryFile, 'utf8');
            assert.ok(summary.includes('Published plugin \\#\\#\\# ::error::injected 1\\.2\\.3 ::error::injected'));
            assert.doesNotMatch(summary, /\n### ::error::injected/);
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

    for (const phase of ['upload', 'search']) {
        it(`redacts and bounds ${phase} error bodies while escaping workflow commands`, async () => {
            const secret = 'FAKE-MARKET-TOKEN-SENTINEL';
            const body = `Bearer ${secret}\r\n::notice::injected%${'x'.repeat(4000)}BODY-TAIL`;
            const market = await server((request, response) => {
                if (request.method === 'GET' && request.url.startsWith('/api/v1/rest/plugins/')) {
                    response.statusCode = 404;
                    response.end('not found');
                } else if (request.method === 'GET' && phase === 'upload') {
                    response.end('[{"id":42,"name":"Published plugin","version":"1.0.0"}]');
                } else {
                    response.statusCode = 503;
                    response.end(body);
                }
            });
            try {
                const dir = fixture();
                const outputFile = path.join(dir, 'outputs.txt');
                const summaryFile = path.join(dir, 'summary.md');
                const result = await run(
                    dir,
                    inputs({
                        'INPUT_API-TOKEN': secret,
                        'INPUT_API-URL': market.url,
                        INPUT_WARN: 'true',
                        GITHUB_OUTPUT: outputFile,
                        GITHUB_STEP_SUMMARY: summaryFile,
                    }),
                );
                const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '';
                assert.equal(result.status, 1);
                assert.doesNotMatch(result.stdout + result.stderr + summary, new RegExp(secret));
                assert.match(result.stderr, /503/);
                assert.match(result.stderr, /Bearer \[REDACTED\]%0D%0A::notice::injected%25/);
                assert.doesNotMatch(result.stderr, /BODY-TAIL|\n::notice::/);
                assert.ok(result.stderr.length < 1200, `diagnostic length ${result.stderr.length}`);
                assert.equal(fs.existsSync(outputFile), false);
                assert.equal(summary, '');
            } finally {
                market.instance.close();
            }
        });
    }

    it('fails when the WASM path does not exist', async () => {
        const dir = fixture();
        const result = await run(dir, inputs({ 'INPUT_WASM-FILE': 'missing.wasm' }));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /WASM file not found/);
    });

    it('refuses to send the token to a plain HTTP Market URL, even with warn enabled', async () => {
        const result = await run(
            fixture(),
            inputs({
                'INPUT_API-TOKEN': 'test-token',
                'INPUT_API-URL': 'http://market.example.test',
                INPUT_WARN: 'true',
            }),
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /api-url must use https/);
    });

    for (const status of [401, 403, 429, 500]) {
        it(`fails ID lookup on HTTP ${status} even with warn enabled`, async () => {
            const requests = [];
            const market = await server((request, response) => {
                requests.push({ method: request.method, url: request.url });
                response.statusCode = status;
                response.end('lookup failure');
            });
            try {
                const dir = fixture();
                const outputFile = path.join(dir, 'outputs.txt');
                const result = await run(
                    dir,
                    inputs({
                        'INPUT_PLUGIN-NAME': '',
                        'INPUT_PLUGIN-ID': 'public-test-id',
                        'INPUT_API-TOKEN': 'test-token',
                        'INPUT_API-URL': market.url,
                        INPUT_WARN: 'true',
                        GITHUB_OUTPUT: outputFile,
                    }),
                );
                assert.equal(result.status, 1, result.stdout);
                assert.match(result.stderr, new RegExp(`Could not look up Market plugin.*${status}`));
                assert.doesNotMatch(result.stdout, /::warning|skipped/);
                assert.equal(fs.existsSync(outputFile), false);
                assert.deepEqual(requests, [{ method: 'GET', url: '/api/v1/rest/plugins/public-test-id' }]);
            } finally {
                market.instance.close();
            }
        });
    }

    for (const body of [
        'invalid json',
        '{}',
        'null',
        '[]',
        '{"id":42,"name":true,"version":"1"}',
        '{"id":"42","name":"Plugin","version":"1"}',
        '{"id":42,"name":"Plugin","version":{}}',
    ]) {
        it(`rejects an invalid successful ID response: ${body}`, async () => {
            const requests = [];
            const market = await server((request, response) => {
                requests.push(request.method);
                response.end(body);
            });
            try {
                const dir = fixture();
                const outputFile = path.join(dir, 'outputs.txt');
                const result = await run(
                    dir,
                    inputs({
                        'INPUT_PLUGIN-NAME': '',
                        'INPUT_PLUGIN-ID': '42',
                        'INPUT_API-TOKEN': 'test-token',
                        'INPUT_API-URL': market.url,
                        INPUT_WARN: 'true',
                        GITHUB_OUTPUT: outputFile,
                    }),
                );
                assert.equal(result.status, 1, result.stdout);
                assert.match(result.stderr, /Market plugin lookup response.*(?:JSON|listing)/);
                assert.doesNotMatch(result.stdout, /::warning|skipped/);
                assert.equal(fs.existsSync(outputFile), false);
                assert.deepEqual(requests, ['GET']);
            } finally {
                market.instance.close();
            }
        });
    }

    for (const warn of ['false', 'true']) {
        it(`treats only HTTP 404 as an absent ID listing with warn=${warn}`, async () => {
            let requests = 0;
            const market = await server((_request, response) => {
                requests++;
                response.statusCode = 404;
                response.end('not found');
            });
            try {
                const dir = fixture();
                const outputFile = path.join(dir, 'outputs.txt');
                const result = await run(
                    dir,
                    inputs({
                        'INPUT_PLUGIN-NAME': '',
                        'INPUT_PLUGIN-ID': '42',
                        'INPUT_API-TOKEN': 'test-token',
                        'INPUT_API-URL': market.url,
                        INPUT_WARN: warn,
                        GITHUB_OUTPUT: outputFile,
                    }),
                );
                assert.equal(result.status, warn === 'true' ? 0 : 1, result.stderr);
                assert.equal(requests, 1);
                if (warn === 'true') assert.deepEqual(readOutputs(outputFile), { status: 'skipped' });
                else assert.equal(fs.existsSync(outputFile), false);
            } finally {
                market.instance.close();
            }
        });
    }

    for (const selectedId of ['42', 'public-test-id']) {
        it(`publishes through plugin ID ${selectedId} without name search`, async () => {
            const requests = [];
            const market = await server((request, response) => {
                requests.push(request);
                if (request.method === 'GET') {
                    response.setHeader('content-type', 'application/json');
                    response.end(
                        JSON.stringify({
                            id: 42,
                            public_id: 'public-test-id',
                            name: 'Canonical Plugin',
                            version: '1.0.0',
                        }),
                    );
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
                const outputFile = path.join(dir, 'outputs.txt');
                const result = await run(dir, {
                    'INPUT_PLUGIN-ID': selectedId,
                    INPUT_VERSION: '1.2.3',
                    'INPUT_WASM-FILE': 'plugin.wasm',
                    'INPUT_API-TOKEN': 'test-token',
                    'INPUT_API-URL': market.url,
                    GITHUB_OUTPUT: outputFile,
                });

                assert.equal(result.status, 0, result.stderr);
                assert.equal(requests.length, 2);
                assert.equal(requests[0].url, `/api/v1/rest/plugins/${selectedId}`);
                assert.equal(requests[1].url, '/api/plugins/42');
                assert.deepEqual(readOutputs(outputFile), {
                    'listing-id': '42',
                    'listing-name': 'Canonical Plugin',
                    status: 'success',
                    'published-version': '1.2.3',
                });
            } finally {
                market.instance.close();
            }
        });
    }
});
