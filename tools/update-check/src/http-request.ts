import { handle } from 'wasi:http/outgoing-handler@0.2.3';
import { Fields, OutgoingRequest, RequestOptions } from 'wasi:http/types@0.2.3';
import type { Pollable } from 'wasi:io/poll@0.2.3';
import { strFromU8, strToU8 } from 'fflate';

const MAX_RESPONSE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 4096;

type Resource = { [Symbol.dispose]?: () => void; drop?: () => void };

/** Performs a GET in steps, yielding the pollable that must be ready before each step. */
export function* marketJsonRequest(url: string): Generator<Pollable, unknown, void> {
    const resources: Resource[] = [];
    const own = <T extends Resource>(resource: T): T => {
        resources.push(resource);
        return resource;
    };
    const transfer = (resource: Resource): void => {
        resources.splice(resources.indexOf(resource), 1);
    };
    const release = (resource: Resource): void => {
        transfer(resource);
        dispose(resource);
    };
    let stage = 'parse URL';
    try {
        const target = parseUrl(url);
        stage = 'construct request headers';
        const fields = own(new Fields());
        fields.set('accept', [strToU8('application/json')]);
        // The constructor consumes the headers resource.
        transfer(fields);
        const request = own(new OutgoingRequest(fields));
        stage = 'configure outgoing request';
        request.setMethod({ tag: 'get' });
        request.setScheme({ tag: target.scheme === 'https' ? 'HTTPS' : 'HTTP' });
        request.setAuthority(target.authority);
        request.setPathWithQuery(target.path);
        stage = 'configure request timeouts';
        const options = own(new RequestOptions());
        options.setConnectTimeout(2_000_000_000);
        options.setFirstByteTimeout(3_000_000_000);
        options.setBetweenBytesTimeout(1_000_000_000);
        stage = 'send outgoing request';
        // These owned arguments are consumed even when handle returns an error.
        transfer(request);
        transfer(options);
        const future = own(handle(request, options));
        stage = 'wait for response future';
        const responsePollable = own(future.subscribe());
        yield responsePollable;
        release(responsePollable);
        stage = 'read response future';
        const ready = future.get();
        if (!ready) throw new Error('Market did not return an HTTP response');
        if (ready.tag !== 'ok') throw new Error('Market HTTP response was already retrieved');
        if (ready.val.tag !== 'ok') throw new Error(`Market HTTP request failed: ${JSON.stringify(ready.val.val)}`);
        const response = own(ready.val.val);
        stage = 'read response status';
        const status = response.status();
        if (status !== 200) throw new Error(`Market returned HTTP ${status}`);
        stage = 'consume response body';
        const body = own(response.consume());
        stage = 'open response stream';
        const stream = own(body.stream());
        const streamPollable = own(stream.subscribe());
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            stage = 'wait for response stream';
            yield streamPollable;
            stage = 'read response stream';
            let chunk: Uint8Array;
            try {
                chunk = stream.read(READ_CHUNK_BYTES);
            } catch (error) {
                if (isClosed(error)) break;
                throw error;
            }
            // An empty read means no data yet, not end-of-stream.
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) throw new Error('Market response is too large');
            if (chunk.length > 0) chunks.push(chunk);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        stage = 'parse response JSON';
        return JSON.parse(strFromU8(bytes)) as unknown;
    } catch (error) {
        throw new Error(`WASI HTTP ${stage}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        // Child resources must be dropped before their parents, including on setup failures.
        for (const resource of resources.reverse()) dispose(resource);
    }
}

function dispose(resource: Resource): void {
    try {
        const drop = resource[Symbol.dispose] ?? resource.drop;
        drop?.call(resource);
    } catch {
        // Keep cleaning up other resources and preserve the original request failure.
    }
}

function parseUrl(url: string): { scheme: string; authority: string; path: string } {
    const match = /^(https?):\/\/([^/?#\s@]+)((?:\/[^#\s]*|\?[^#\s]*))?(?:#[^\s]*)?$/i.exec(url);
    if (!match) throw new TypeError(`Invalid HTTP URL: ${url}`);
    const [, scheme, authority, path = '/'] = match;
    return { scheme: scheme.toLowerCase(), authority, path: path.startsWith('?') ? `/${path}` : path };
}

function isClosed(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('payload' in error)) return false;
    const payload = error.payload;
    return typeof payload === 'object' && payload !== null && 'tag' in payload && payload.tag === 'closed';
}
