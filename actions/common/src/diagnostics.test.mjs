import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readBoundedJson, safeResponseBody } from './diagnostics.mjs';

describe('action diagnostics', () => {
    it('parses a JSON response within the size limit', async () => {
        const response = new Response('{"id":42,"name":"Test listing"}');

        assert.deepEqual(await readBoundedJson(response), { id: 42, name: 'Test listing' });
    });

    it('rejects an oversized identity response before reading its body', async () => {
        let readCount = 0;
        let cancelCount = 0;
        const body = new ReadableStream(
            {
                pull(controller) {
                    readCount++;
                    controller.enqueue(new TextEncoder().encode('{"id":42}'));
                    controller.close();
                },
                cancel() {
                    cancelCount++;
                },
            },
            { highWaterMark: 0 },
        );
        const response = new Response(body, {
            headers: { 'content-length': '1048577', 'content-encoding': 'identity' },
        });

        await assert.rejects(readBoundedJson(response), RangeError);
        assert.equal(readCount, 0, 'oversized known-length bodies should be rejected before reading');
        assert.equal(cancelCount, 1, 'oversized known-length bodies should be canceled');
    });

    it('uses streamed bytes when content length describes an encoded response', async () => {
        const response = new Response('{"id":42}', {
            headers: { 'content-length': '1048577', 'content-encoding': 'gzip' },
        });

        assert.deepEqual(await readBoundedJson(response), { id: 42 });
    });

    it('cancels a chunked JSON response when streamed bytes exceed the limit', async () => {
        let chunksRead = 0;
        let cancelCount = 0;
        const chunks = [new Uint8Array(1_048_576), new Uint8Array(1)];
        const body = new ReadableStream(
            {
                pull(controller) {
                    controller.enqueue(chunks[chunksRead++]);
                },
                cancel() {
                    cancelCount++;
                },
            },
            { highWaterMark: 0 },
        );

        await assert.rejects(readBoundedJson(new Response(body)), /JSON response exceeds 1048576 byte limit/);
        assert.equal(chunksRead, 2);
        assert.equal(cancelCount, 1, 'oversized chunked bodies should be canceled at the limit');
    });

    it('redacts a bounded response prefix and cancels before later chunks are read', async () => {
        const secret = 'test-token';
        const chunks = [
            new TextEncoder().encode(`Bearer ${secret} ${'x'.repeat(580)}`),
            new TextEncoder().encode('é'.repeat(250)),
            new TextEncoder().encode('tail-marker'),
        ];
        let chunksRead = 0;
        let cancelCount = 0;
        const body = new ReadableStream(
            {
                pull(controller) {
                    controller.enqueue(chunks[chunksRead++]);
                },
                cancel() {
                    cancelCount += 1;
                },
            },
            { highWaterMark: 0 },
        );

        const diagnostic = await safeResponseBody(new Response(body), secret);

        assert.match(diagnostic, /Bearer \[REDACTED\]/);
        assert.doesNotMatch(diagnostic, /test-token|tail-marker/);
        assert.equal(Buffer.byteLength(diagnostic), 1000, 'diagnostic should stop at the byte limit');
        assert.equal(chunksRead, 2, 'chunks after the byte limit should not be read');
        assert.equal(cancelCount, 1, 'the response stream should be canceled at the limit');
    });

    it('redacts a credential fragment cut off at the byte limit', async () => {
        const secret = 'test-token';
        const chunks = [new TextEncoder().encode(`${'x'.repeat(995)}test-`), new TextEncoder().encode('token')];
        let chunksRead = 0;
        const body = new ReadableStream(
            {
                pull(controller) {
                    controller.enqueue(chunks[chunksRead++]);
                },
            },
            { highWaterMark: 0 },
        );

        const diagnostic = await safeResponseBody(new Response(body), secret);

        assert.doesNotMatch(diagnostic, /test-/);
        assert.match(diagnostic, /\[REDACTED\]$/);
        assert.equal(chunksRead, 1, 'the remainder of the credential should not be read');
    });
});
