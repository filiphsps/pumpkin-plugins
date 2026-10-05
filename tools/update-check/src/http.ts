import { handle } from 'wasi:http/outgoing-handler@0.2.3';
import type { IncomingBody, IncomingResponse } from 'wasi:http/types@0.2.3';
import { Fields, OutgoingRequest, RequestOptions } from 'wasi:http/types@0.2.3';
import type { Pollable } from 'wasi:io/poll@0.2.3';
import type { InputStream } from 'wasi:io/streams@0.2.3';
import { strFromU8, strToU8 } from 'fflate';

const MAX_RESPONSE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 4096;
const CONNECT_TIMEOUT_NS = 2_000_000_000;
const RESPONSE_TIMEOUT_NS = 3_000_000_000;
const BETWEEN_BYTES_TIMEOUT_NS = 1_000_000_000;

/** Sends a synchronous HTTPS or HTTP GET request through Pumpkin's WASI HTTP host. */
export function requestMarketJson(url: string): unknown {
    let stage = 'parse URL';
    try {
        const target = parseUrl(url);
        stage = 'construct request headers';
        const fields = new Fields();
        fields.set('accept', [strToU8('application/json')]);
        const request = new OutgoingRequest(fields);
        stage = 'configure outgoing request';
        request.setMethod({ tag: 'get' });
        request.setScheme({ tag: target.scheme === 'https' ? 'HTTPS' : 'HTTP' });
        request.setAuthority(target.authority);
        request.setPathWithQuery(target.path);

        stage = 'configure request timeouts';
        const options = new RequestOptions();
        options.setConnectTimeout(CONNECT_TIMEOUT_NS);
        options.setFirstByteTimeout(RESPONSE_TIMEOUT_NS);
        options.setBetweenBytesTimeout(BETWEEN_BYTES_TIMEOUT_NS);
        stage = 'send outgoing request';
        // `handle` consumes both resources, so their ownership moves to the host here.
        const future = handle(request, options);
        try {
            stage = 'subscribe to response future';
            const pollable = future.subscribe();
            try {
                stage = 'wait for response future';
                pollable.block();
            } finally {
                stage = 'dispose response pollable';
                disposeWasiResource(pollable);
            }

            stage = 'read response future';
            const ready = future.get();
            if (!ready) throw new Error('Market did not return an HTTP response');
            if (ready.tag !== 'ok') throw new Error(`Market HTTP request failed: ${String(ready.val)}`);
            const responseResult = ready.val;
            if (responseResult.tag !== 'ok')
                throw new Error(`Market HTTP request failed: ${String(responseResult.val)}`);
            const response = responseResult.val;
            try {
                stage = 'read response status';
                if (response.status() !== 200) throw new Error(`Market returned HTTP ${response.status()}`);
                stage = 'consume response body';
                const body = response.consume();
                try {
                    stage = 'open response stream';
                    const stream = body.stream();
                    try {
                        const chunks: Uint8Array[] = [];
                        let size = 0;
                        for (;;) {
                            let chunk: Uint8Array;
                            try {
                                stage = 'read response stream';
                                chunk = stream.blockingRead(READ_CHUNK_BYTES);
                            } catch (error) {
                                if (isClosed(error)) break;
                                throw error;
                            }
                            if (chunk.length === 0) break;
                            size += chunk.length;
                            if (size > MAX_RESPONSE_BYTES) throw new Error('Market response is too large');
                            chunks.push(chunk);
                        }
                        stage = 'combine response bytes';
                        const bytes = join(chunks, size);
                        stage = 'decode response JSON';
                        const json = strFromU8(bytes);
                        stage = 'parse response JSON';
                        return JSON.parse(json) as unknown;
                    } finally {
                        stage = 'dispose response stream';
                        disposeWasiResource(stream);
                    }
                } finally {
                    stage = 'dispose response body';
                    disposeWasiResource(body);
                }
            } finally {
                stage = 'dispose HTTP response';
                disposeWasiResource(response);
            }
        } finally {
            stage = 'dispose response future';
            disposeWasiResource(future);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`WASI HTTP ${stage}: ${message}`);
    }
}

/** The outcome of one asynchronous Market request. */
export type MarketJsonResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Schedules work to run again without blocking the current plugin task. */
export type SchedulePoll = (callback: () => void) => void;

/** Starts a WASI HTTP request and polls its response across scheduled tasks without blocking. */
export function requestMarketJsonAsync(
    url: string,
    schedule: SchedulePoll,
    complete: (result: MarketJsonResult) => void
): void {
    let future: ReturnType<typeof handle> | undefined;
    let response: IncomingResponse | undefined;
    let body: IncomingBody | undefined;
    let stream: InputStream | undefined;
    let pollable: Pollable | undefined;
    let stage = 'parse URL';
    let finished = false;
    const chunks: Uint8Array[] = [];
    let size = 0;

    const release = (resource: { [Symbol.dispose]?: () => void; drop?: () => void } | undefined): void => {
        if (!resource) return;
        try {
            disposeWasiResource(resource);
        } catch {
            // The host owns resources that cannot be explicitly disposed by QuickJS.
        }
    };

    const finish = (result: MarketJsonResult): void => {
        if (finished) return;
        finished = true;
        release(pollable);
        release(stream);
        release(body);
        release(response);
        release(future);
        complete(result);
    };

    const fail = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        finish({ ok: false, error: new Error(`WASI HTTP ${stage}: ${message}`) });
    };

    const pollBody = (): void => {
        try {
            if (!pollable?.ready()) {
                schedule(pollBody);
                return;
            }
            stage = 'read response stream';
            let chunk: Uint8Array;
            try {
                chunk = stream?.read(READ_CHUNK_BYTES) ?? new Uint8Array();
            } catch (error) {
                if (!isClosed(error)) throw error;
                const bytes = join(chunks, size);
                stage = 'decode response JSON';
                const json = strFromU8(bytes);
                stage = 'parse response JSON';
                finish({ ok: true, value: JSON.parse(json) as unknown });
                return;
            }
            if (chunk.length === 0) {
                schedule(pollBody);
                return;
            }
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) throw new Error('Market response is too large');
            chunks.push(chunk);
            schedule(pollBody);
        } catch (error) {
            fail(error);
        }
    };

    const pollHeaders = (): void => {
        try {
            if (!pollable?.ready()) {
                schedule(pollHeaders);
                return;
            }
            release(pollable);
            pollable = undefined;
            stage = 'read response future';
            const ready = future?.get();
            if (!ready) throw new Error('Market did not return an HTTP response');
            if (ready.tag !== 'ok') throw new Error(`Market HTTP request failed: ${String(ready.val)}`);
            const responseResult = ready.val;
            if (responseResult.tag !== 'ok')
                throw new Error(`Market HTTP request failed: ${String(responseResult.val)}`);
            response = responseResult.val;
            stage = 'read response status';
            if (response.status() !== 200) throw new Error(`Market returned HTTP ${response.status()}`);
            stage = 'consume response body';
            body = response.consume();
            stage = 'open response stream';
            stream = body.stream();
            pollable = stream.subscribe();
            schedule(pollBody);
        } catch (error) {
            fail(error);
        }
    };

    try {
        const target = parseUrl(url);
        stage = 'construct request headers';
        const fields = new Fields();
        fields.set('accept', [strToU8('application/json')]);
        const request = new OutgoingRequest(fields);
        stage = 'configure outgoing request';
        request.setMethod({ tag: 'get' });
        request.setScheme({ tag: target.scheme === 'https' ? 'HTTPS' : 'HTTP' });
        request.setAuthority(target.authority);
        request.setPathWithQuery(target.path);

        stage = 'configure request timeouts';
        const options = new RequestOptions();
        options.setConnectTimeout(CONNECT_TIMEOUT_NS);
        options.setFirstByteTimeout(RESPONSE_TIMEOUT_NS);
        options.setBetweenBytesTimeout(BETWEEN_BYTES_TIMEOUT_NS);
        stage = 'send outgoing request';
        future = handle(request, options);
        stage = 'subscribe to response future';
        pollable = future.subscribe();
        schedule(pollHeaders);
    } catch (error) {
        fail(error);
    }
}

interface HttpTarget {
    scheme: 'http' | 'https';
    authority: string;
    path: string;
}

/** Splits an HTTP URL without relying on the URL global, which QuickJS does not provide. */
function parseUrl(url: string): HttpTarget {
    const match = /^(https?):\/\/([^/?#]+)(\/[^#]*)?(?:#.*)?$/i.exec(url);
    if (!match) throw new TypeError(`Invalid HTTP URL: ${url}`);
    const [, rawScheme, authority, path] = match;
    if (!rawScheme || !authority) throw new TypeError(`Invalid HTTP URL: ${url}`);
    return { scheme: rawScheme.toLowerCase() as 'http' | 'https', authority, path: path ?? '/' };
}

/** Joins response chunks into one byte array. */
function join(chunks: Uint8Array[], size: number): Uint8Array {
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

/** Explicitly releases WASI resources when the host runtime exposes disposal. */
function disposeWasiResource(resource: { [Symbol.dispose]?: () => void; drop?: () => void }): void {
    const dispose = resource[Symbol.dispose];
    if (typeof dispose === 'function') {
        dispose.call(resource);
        return;
    }
    const drop = resource.drop;
    if (typeof drop === 'function') drop.call(resource);
}

/** Identifies the normal end-of-stream signal returned by WASI input streams. */
function isClosed(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('payload' in error)) return false;
    const payload = error.payload;
    return typeof payload === 'object' && payload !== null && 'tag' in payload && payload.tag === 'closed';
}
