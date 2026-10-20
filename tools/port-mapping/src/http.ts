import { strFromU8, strToU8 } from 'fflate';
import type { Endpoint, Ipv4 } from './ipv4.ts';
import { formatIpv4 } from './ipv4.ts';
import type { Connection, Network } from './network.ts';
import type { Steps } from './task.ts';

/** A request for `httpRequest`. */
export interface HttpRequest {
    body?: string;
    headers?: Record<string, string>;
    method: 'GET' | 'POST';
    path: string;
}

/** What came back. */
export interface HttpResponse {
    body: string;
    /** The address of this machine on the connection, which is the address the router sees. */
    localAddress: Ipv4;
    status: number;
}

const READ_CHUNK = 4096;
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Makes one HTTP/1.1 request and reads the whole response. Routers answer small XML documents, so
 * this stays small: no redirects, no keep-alive, no TLS.
 * @param timeoutMs - How long the whole exchange may take.
 * @throws {Error} When the connection can't be made or breaks, or the answer isn't HTTP.
 */
export function* httpRequest(net: Network, to: Endpoint, request: HttpRequest, timeoutMs = 5000): Steps<HttpResponse> {
    const deadline = net.now() + timeoutMs;
    const dial = net.dial(to);
    let connection: Connection | undefined;
    try {
        const connectionError = `could not connect to ${formatIpv4(to.address)}:${to.port}`;
        for (;;) {
            connection = dial.poll();
            throwIfPastDeadline(net, deadline, connectionError);
            if (connection) break;
            yield;
        }
        yield* send(net, connection, serialize(to, request), deadline);

        let received: Uint8Array = new Uint8Array(0);
        let receivedLength = 0;
        const progress: ResponseProgress = { headSearchFrom: 0 };
        for (;;) {
            const chunk = connection.read(READ_CHUNK);
            throwIfPastDeadline(net, deadline, 'the response took too long');
            if (chunk === 'closed') break;
            if (chunk) {
                const nextLength = receivedLength + chunk.length;
                if (nextLength > MAX_RESPONSE_BYTES) throw new Error('the response is too large');
                received = appendResponse(received, receivedLength, chunk, nextLength);
                receivedLength = nextLength;
                if (isComplete(received, receivedLength, progress)) break;
                continue;
            }
            yield;
        }
        return { ...finish(received, receivedLength, progress), localAddress: connection.localAddress };
    } finally {
        if (connection) connection.close();
        else dial.abort();
    }
}

function* send(net: Network, connection: Connection, bytes: Uint8Array, deadline: number): Steps<void> {
    let sent = 0;
    while (sent < bytes.length) {
        const room = Math.min(connection.writable(), bytes.length - sent);
        if (room > 0) connection.write(bytes.subarray(sent, sent + room));
        throwIfPastDeadline(net, deadline, 'could not send the request');
        if (room > 0) sent += room;
        else yield;
    }
}

function throwIfPastDeadline(net: Network, deadline: number, message: string): void {
    if (net.now() > deadline) throw new Error(message);
}

function serialize(to: Endpoint, { method, path, headers = {}, body }: HttpRequest): Uint8Array {
    const payload = body === undefined ? undefined : strToU8(body);
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${formatIpv4(to.address)}:${to.port}`, 'Connection: close'];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    if (payload) lines.push(`Content-Length: ${payload.length}`);
    const head = strToU8(`${lines.join('\r\n')}\r\n\r\n`);
    return payload ? concat(head, payload) : head;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const all = new Uint8Array(a.length + b.length);
    all.set(a);
    all.set(b, a.length);
    return all;
}

function appendResponse(buffer: Uint8Array, length: number, chunk: Uint8Array, nextLength: number): Uint8Array {
    if (nextLength > buffer.length) {
        const capacity = Math.min(MAX_RESPONSE_BYTES, Math.max(nextLength, buffer.length * 2));
        const expanded = new Uint8Array(capacity);
        expanded.set(buffer.subarray(0, length));
        buffer = expanded;
    }
    buffer.set(chunk, length);
    return buffer;
}

/** Where the head ends and the body starts. Lines may end in CRLF or, from sloppy devices, a bare LF. */
function headEnd(bytes: Uint8Array, length: number, from: number): { head: number; body: number } | undefined {
    for (let i = from; i + 1 < length; i++) {
        if (bytes[i] !== 10) continue;
        const head = i > 0 && bytes[i - 1] === 13 ? i - 1 : i;
        if (bytes[i + 1] === 10) return { head, body: i + 2 };
        if (i + 2 < length && bytes[i + 1] === 13 && bytes[i + 2] === 10) return { head, body: i + 3 };
    }
    return undefined;
}

function headers(head: string): { status: number; fields: Record<string, string> } {
    const [statusLine = '', ...lines] = head.split(/\r?\n/);
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
    if (!status) throw new Error('the answer is not HTTP');
    const fields: Record<string, string> = {};
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { status, fields };
}

interface ResponseProgress {
    bodyStart?: number;
    chunked?: ChunkedProgress;
    expectedBodyLength?: number;
    headSearchFrom: number;
    status?: number;
}

interface ChunkedProgress {
    chunkSize: number;
    cursor: number;
    lineSearchFrom: number;
    lineStart: number;
    phase: 'size' | 'data' | 'trailer' | 'done';
    /** Where each chunk's data starts and ends in the received bytes. */
    pieces: [number, number][];
}

/** Whether the received prefix completes the response, advancing only over newly arrived bytes. */
function isComplete(bytes: Uint8Array, length: number, progress: ResponseProgress): boolean {
    if (progress.bodyStart === undefined) {
        const end = headEnd(bytes, length, progress.headSearchFrom);
        progress.headSearchFrom = Math.max(0, length - 3);
        if (!end) return false;
        const { status, fields } = headers(strFromU8(bytes.subarray(0, end.head), true));
        progress.status = status;
        progress.bodyStart = end.body;
        if (fields['transfer-encoding']?.toLowerCase() === 'chunked') {
            const cursor = end.body;
            progress.chunked = {
                chunkSize: 0,
                cursor,
                lineSearchFrom: cursor,
                lineStart: cursor,
                pieces: [],
                phase: 'size',
            };
        } else {
            progress.expectedBodyLength = contentLength(fields);
        }
    }

    if (progress.chunked) return isChunkedComplete(bytes, length, progress.chunked);
    const bodyLength = length - progress.bodyStart;
    return progress.expectedBodyLength !== undefined && bodyLength >= progress.expectedBodyLength;
}

function isChunkedComplete(bytes: Uint8Array, length: number, progress: ChunkedProgress): boolean {
    while (progress.phase !== 'done') {
        if (progress.phase === 'size' || progress.phase === 'trailer') {
            const lineEnd = findLineEnd(bytes, length, progress.lineSearchFrom);
            if (lineEnd === -1) {
                progress.lineSearchFrom = Math.max(progress.lineStart, length - 1);
                return false;
            }
            const line = strFromU8(bytes.subarray(progress.lineStart, lineEnd));
            if (progress.phase === 'size') {
                progress.chunkSize = parseChunkSize(line);
                progress.cursor = lineEnd + 2;
                if (progress.chunkSize === 0) {
                    progress.phase = 'trailer';
                    progress.lineStart = progress.cursor;
                    progress.lineSearchFrom = progress.cursor;
                } else {
                    progress.phase = 'data';
                }
            } else {
                if (lineEnd === progress.lineStart) {
                    progress.phase = 'done';
                    return true;
                }
                if (!isChunkTrailer(line)) throw new Error('invalid chunk trailer');
                progress.lineStart = lineEnd + 2;
                progress.lineSearchFrom = progress.lineStart;
            }
            continue;
        }

        const remaining = length - progress.cursor;
        if (remaining < 2 || progress.chunkSize > remaining - 2) return false;
        const delimiter = progress.cursor + progress.chunkSize;
        if (bytes[delimiter] !== 13 || bytes[delimiter + 1] !== 10) {
            throw new Error('invalid chunk delimiter');
        }
        progress.pieces.push([progress.cursor, delimiter]);
        progress.cursor = delimiter + 2;
        progress.lineStart = progress.cursor;
        progress.lineSearchFrom = progress.cursor;
        progress.phase = 'size';
    }
    return true;
}

function findLineEnd(bytes: Uint8Array, length: number, from: number): number {
    for (let end = from; end + 1 < length; end++) {
        if (bytes[end] === 13 && bytes[end + 1] === 10) return end;
    }
    return -1;
}

/** The status and body of a response read to its end, from what `isComplete` worked out on the way. */
function finish(bytes: Uint8Array, length: number, progress: ResponseProgress): { status: number; body: string } {
    const { bodyStart, chunked, expectedBodyLength: expected, status } = progress;
    if (bodyStart === undefined || status === undefined) throw new Error('the answer is not HTTP');
    if (chunked) {
        if (chunked.phase !== 'done') throw new Error('truncated chunked body');
        const body = new Uint8Array(chunked.pieces.reduce((total, [from, to]) => total + to - from, 0));
        let at = 0;
        for (const [from, to] of chunked.pieces) {
            body.set(bytes.subarray(from, to), at);
            at += to - from;
        }
        return { status, body: strFromU8(body) };
    }
    if (expected !== undefined && length - bodyStart < expected) throw new Error('truncated Content-Length body');
    return {
        status,
        body: strFromU8(bytes.subarray(bodyStart, expected === undefined ? length : bodyStart + expected)),
    };
}

function contentLength(fields: Record<string, string>): number | undefined {
    const token = fields['content-length'];
    if (token === undefined) return undefined;
    if (!/^[0-9]+$/.test(token) || !Number.isSafeInteger(Number(token))) {
        throw new Error('invalid Content-Length');
    }
    return Number(token);
}

function parseChunkSize(line: string): number {
    const token = line.split(';')[0] ?? '';
    if (!/^[0-9a-fA-F]+$/.test(token)) throw new Error('invalid chunk size');
    const size = Number.parseInt(token, 16);
    if (!Number.isSafeInteger(size)) throw new Error('invalid chunk size');
    return size;
}

function isChunkTrailer(line: string): boolean {
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e]*$/.test(line);
}
