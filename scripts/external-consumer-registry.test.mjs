import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';
import { createInternalRegistry } from './external-consumer-registry.mjs';

test('confines upstream requests to npm and hides fetch errors', async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (input) => {
        const url = new URL(input);
        requestedUrls.push(url);
        if (url.pathname === '/failure') throw new Error('sensitive upstream details');
        return new Response('npm registry response');
    };

    const registry = createInternalRegistry(new Map());
    await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    assert.ok(address && typeof address !== 'string');

    try {
        const allowed = await request(address.port, '/some-package');
        assert.equal(allowed.status, 200);
        assert.equal(allowed.body, 'npm registry response');
        assert.equal(requestedUrls[0]?.origin, 'https://registry.npmjs.org');

        const externalTarget = await request(address.port, 'http://example.invalid/metadata');
        assert.equal(externalTarget.status, 400);
        assert.equal(externalTarget.body, 'Invalid registry request target');
        assert.equal(requestedUrls.length, 1);

        const traversalTarget = await request(address.port, '/%2e%2e/private');
        assert.equal(traversalTarget.status, 400);
        assert.equal(traversalTarget.body, 'Invalid registry request target');
        assert.equal(requestedUrls.length, 1);

        const failed = await request(address.port, '/failure');
        assert.equal(failed.status, 500);
        assert.equal(failed.body, 'Temporary registry request failed');
        assert.doesNotMatch(failed.body, /sensitive upstream details|Error/);
    } finally {
        globalThis.fetch = originalFetch;
        await new Promise((resolve) => registry.close(resolve));
    }
});

test('uses the bound origin for tarball links when the request Host header is forged', async () => {
    const registry = createInternalRegistry(
        new Map([
            [
                'test-package',
                {
                    packageJson: { name: 'test-package', version: '1.2.3' },
                    filename: 'test-package-1.2.3.tgz',
                    bytes: Buffer.from('archive')
                }
            ]
        ])
    );
    await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const address = registry.address();
    assert.ok(address && typeof address !== 'string');

    try {
        const response = await request(address.port, '/test-package', { host: 'attacker.invalid' });
        const metadata = JSON.parse(response.body);
        assert.equal(
            metadata.versions['1.2.3'].dist.tarball,
            `http://127.0.0.1:${address.port}/tarballs/test-package-1.2.3.tgz`
        );
    } finally {
        await new Promise((resolve) => registry.close(resolve));
    }
});

function request(port, target, headers) {
    return new Promise((resolve, reject) => {
        const outgoing = http.get({ hostname: '127.0.0.1', port, path: target, headers }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        outgoing.on('error', reject);
    });
}
