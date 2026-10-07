import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const entrypoint = path.resolve(import.meta.dirname, 'index.mjs');
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-metadata-'));
    dirs.push(dir);
    return dir;
}

function run(dir, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [entrypoint], { cwd: dir, env: { ...process.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

function inputs(extra = {}) {
    return { 'INPUT_PLUGIN-ID': 'public-test-id', 'INPUT_API-TOKEN': 'test-token', ...extra };
}

function server(handler) {
    return new Promise((resolve) => {
        const instance = http.createServer(handler).listen(0, '127.0.0.1', () => {
            const address = instance.address();
            resolve({ instance, url: `http://127.0.0.1:${address.port}` });
        });
    });
}

function collectBody(request) {
    return new Promise((resolve) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => resolve(body));
    });
}

function readMetadataFromMultipart(request, body) {
    const boundary = /boundary=([^;]+)/.exec(request.headers['content-type'])?.[1];
    assert.ok(boundary, 'multipart request should have a boundary');
    const part = body.split(`--${boundary}`).find((candidate) => candidate.includes('name="metadata"'));
    assert.ok(part, 'multipart request should contain metadata');
    const json = /\r\n\r\n([\s\S]*?)\r\n$/.exec(part)?.[1];
    assert.ok(json, 'metadata part should contain JSON');
    return JSON.parse(json);
}

function outputs(file) {
    return Object.fromEntries(
        [...fs.readFileSync(file, 'utf8').matchAll(/^([a-z-]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm)].map((match) => [
            match[1],
            match[3]
        ])
    );
}

describe('update-pumpkin-market-listing action', () => {
    it('requires exactly one listing selector and a metadata source', async () => {
        const dir = fixture();
        const noSelector = await run(dir, { 'INPUT_API-TOKEN': 'test-token', INPUT_DESCRIPTION: 'Description' });
        assert.equal(noSelector.status, 1);
        assert.match(noSelector.stderr, /Set exactly one of plugin-name or plugin-id/);

        const bothSelectors = await run(
            dir,
            inputs({ 'INPUT_PLUGIN-NAME': 'Test listing', INPUT_DESCRIPTION: 'Description' })
        );
        assert.equal(bothSelectors.status, 1);
        assert.match(bothSelectors.stderr, /Set exactly one of plugin-name or plugin-id/);

        const noMetadata = await run(dir, inputs());
        assert.equal(noMetadata.status, 1);
        assert.match(noMetadata.stderr, /Provide metadata-file or at least one metadata input/);
    });

    it('resolves a public ID and combines file metadata with direct input overrides', async () => {
        const dir = fixture();
        const metadataFile = path.join(dir, 'metadata.json');
        const outputFile = path.join(dir, 'outputs.txt');
        fs.writeFileSync(
            metadataFile,
            JSON.stringify({ category: 'Utilities', translatedDescriptions: { fr: 'Description française' } })
        );
        let putRequest;
        const market = await server(async (request, response) => {
            if (request.method === 'GET') {
                assert.equal(request.url, '/api/v1/rest/plugins/public-test-id');
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ id: 42, public_id: 'public-test-id', name: 'Test Listing' }));
                return;
            }
            putRequest = request;
            putRequest.body = await collectBody(request);
            response.end('{"status":"updated"}');
        });

        try {
            const result = await run(
                dir,
                inputs({
                    'INPUT_METADATA-FILE': 'metadata.json',
                    INPUT_DESCRIPTION: 'Updated English description',
                    INPUT_COMMANDS: JSON.stringify([
                        { name: 'hello', aliases: ['hi'], description: { 'en-US': 'Say hello' }, display_order: 0 }
                    ]),
                    'INPUT_API-URL': market.url,
                    GITHUB_OUTPUT: outputFile
                })
            );

            assert.equal(result.status, 0, result.stderr);
            assert.equal(putRequest.method, 'PUT');
            assert.equal(putRequest.url, '/api/plugins/42');
            assert.equal(putRequest.headers.authorization, 'Bearer test-token');
            const metadata = readMetadataFromMultipart(putRequest, putRequest.body);
            assert.deepEqual(metadata, {
                category: 'Utilities',
                translatedDescriptions: { fr: 'Description française', 'en-US': 'Updated English description' },
                commands: [{ name: 'hello', aliases: ['hi'], description: { 'en-US': 'Say hello' }, display_order: 0 }]
            });
            assert.deepEqual(outputs(outputFile), {
                'listing-id': '42',
                'listing-name': 'Test Listing',
                status: 'success'
            });
        } finally {
            market.instance.close();
        }
    });

    it('uses the publisher name lookup and sends full metadata from a file', async () => {
        const dir = fixture();
        const metadataFile = path.join(dir, 'metadata.json');
        fs.writeFileSync(
            metadataFile,
            JSON.stringify({
                name: 'Test Listing',
                category: 'Utilities',
                sourceLink: '',
                youtubeVideoUrl: '',
                keywords: 'pumpkin, tools',
                translatedDescriptions: { 'en-US': 'A full listing' },
                isEarlyAccess: false,
                commands: []
            })
        );
        const requests = [];
        const market = await server(async (request, response) => {
            requests.push(request);
            if (request.method === 'GET' && request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else if (request.method === 'GET') {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify([{ id: 17, name: 'Test Listing' }]));
            } else {
                request.body = await collectBody(request);
                response.end('{}');
            }
        });

        try {
            const result = await run(dir, {
                'INPUT_PLUGIN-NAME': 'Test Listing',
                'INPUT_METADATA-FILE': 'metadata.json',
                'INPUT_UPDATE-MODE': 'full',
                'INPUT_API-TOKEN': 'test-token',
                'INPUT_API-URL': market.url
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(requests[0].url, '/api/v1/rest/plugins/Test%20Listing');
            assert.equal(requests[1].url, '/api/v1/rest/plugins?q=Test+Listing&limit=20');
            assert.equal(requests[2].url, '/api/plugins/17');
            assert.deepEqual(
                readMetadataFromMultipart(requests[2], requests[2].body),
                JSON.parse(fs.readFileSync(metadataFile))
            );
        } finally {
            market.instance.close();
        }
    });

    it('rejects incomplete full metadata before making API calls', async () => {
        const dir = fixture();
        fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ name: 'Test Listing' }));
        let requestCount = 0;
        const market = await server((_request, response) => {
            requestCount += 1;
            response.end('{}');
        });

        try {
            const result = await run(
                dir,
                inputs({
                    'INPUT_METADATA-FILE': 'metadata.json',
                    'INPUT_UPDATE-MODE': 'full',
                    'INPUT_API-URL': market.url
                })
            );
            assert.equal(result.status, 1);
            assert.match(result.stderr, /Full metadata is missing fields/);
            assert.equal(requestCount, 0);
        } finally {
            market.instance.close();
        }
    });

    it('rejects invalid direct boolean and command values', async () => {
        const dir = fixture();
        const invalidBoolean = await run(dir, inputs({ 'INPUT_IS-EARLY-ACCESS': 'yes' }));
        assert.equal(invalidBoolean.status, 1);
        assert.match(invalidBoolean.stderr, /is-early-access must be true or false/);

        const invalidCommands = await run(dir, inputs({ INPUT_COMMANDS: '{"name":"not-an-array"}' }));
        assert.equal(invalidCommands.status, 1);
        assert.match(invalidCommands.stderr, /commands must be a JSON array/);

        const invalidCommandId = await run(
            dir,
            inputs({ INPUT_COMMANDS: JSON.stringify([{ name: 'hello', id: 'invalid' }]) })
        );
        assert.equal(invalidCommandId.status, 1);
        assert.match(invalidCommandId.stderr, /commands\[0\]\.id must be a positive integer/);
    });

    it('fails on ambiguous name matches without updating a listing', async () => {
        const dir = fixture();
        let putCount = 0;
        const market = await server((_request, response) => {
            if (_request.url.startsWith('/api/v1/rest/plugins/')) {
                response.statusCode = 404;
                response.end('not found');
            } else {
                if (_request.method === 'PUT') putCount += 1;
                response.setHeader('content-type', 'application/json');
                response.end(
                    JSON.stringify([
                        { id: 1, name: 'Test Listing' },
                        { id: 2, name: 'test listing' }
                    ])
                );
            }
        });

        try {
            const result = await run(dir, {
                'INPUT_PLUGIN-NAME': 'Test Listing',
                INPUT_DESCRIPTION: 'Description',
                'INPUT_API-TOKEN': 'test-token',
                'INPUT_API-URL': market.url
            });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /multiple listings named/);
            assert.equal(putCount, 0);
        } finally {
            market.instance.close();
        }
    });

    it('redacts the token from API error bodies and does not report success', async () => {
        const dir = fixture();
        const outputFile = path.join(dir, 'outputs.txt');
        const market = await server(async (request, response) => {
            if (request.method === 'GET') {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ id: 42, name: 'Test Listing' }));
            } else {
                await collectBody(request);
                response.statusCode = 503;
                response.end('rejected test-token');
            }
        });

        try {
            const result = await run(
                dir,
                inputs({ INPUT_DESCRIPTION: 'Description', 'INPUT_API-URL': market.url, GITHUB_OUTPUT: outputFile })
            );
            assert.equal(result.status, 1);
            assert.match(result.stderr, /rejected \[REDACTED\]/);
            assert.doesNotMatch(result.stderr, /test-token/);
            assert.equal(fs.existsSync(outputFile), false);
        } finally {
            market.instance.close();
        }
    });
});
