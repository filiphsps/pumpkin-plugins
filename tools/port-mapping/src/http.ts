import { strFromU8, strToU8 } from 'fflate';
import type { Endpoint, Ipv4 } from './ipv4.ts';
import { formatIpv4 } from './ipv4.ts';
import type { Connection, Network } from './network.ts';
import type { Steps } from './task.ts';

/** A request for `httpRequest`. */
export interface HttpRequest {
    method: 'GET' | 'POST';
    path: string;
    headers?: Record<string, string>;
    body?: string;
}

/** What came back. */
export interface HttpResponse {
    status: number;
    body: string;
    /** The address of this machine on the connection, which is the address the router sees. */
    localAddress: Ipv4;
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
        for (connection = dial.poll(); !connection; connection = dial.poll()) {
            if (net.now() > deadline) throw new Error(`could not connect to ${formatIpv4(to.address)}:${to.port}`);
            yield;
        }
        yield* send(net, connection, serialize(to, request), deadline);

        let received: Uint8Array = new Uint8Array(0);
        for (;;) {
            const chunk = connection.read(READ_CHUNK);
            if (chunk === 'closed') break;
            if (chunk) {
                received = concat(received, chunk);
                if (received.length > MAX_RESPONSE_BYTES) throw new Error('the response is too large');
                if (isComplete(received)) break;
                continue;
            }
            if (net.now() > deadline) throw new Error('the response took too long');
            yield;
        }
        return { ...parseResponse(received), localAddress: connection.localAddress };
    } finally {
        if (connection) connection.close();
        else dial.abort();
    }
}

function* send(net: Network, connection: Connection, bytes: Uint8Array, deadline: number): Steps<void> {
    let sent = 0;
    while (sent < bytes.length) {
        const room = Math.min(connection.writable(), bytes.length - sent);
        if (room > 0) {
            connection.write(bytes.subarray(sent, sent + room));
            sent += room;
        } else if (net.now() > deadline) {
            throw new Error('could not send the request');
        } else {
            yield;
        }
    }
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

function headEnd(bytes: Uint8Array): number {
    for (let i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    }
    return -1;
}

function headers(head: string): { status: number; fields: Record<string, string> } {
    const [statusLine = '', ...lines] = head.split('\r\n');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
    if (!status) throw new Error('the answer is not HTTP');
    const fields: Record<string, string> = {};
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { status, fields };
}

/** Whether the bytes hold a whole response, so the read can stop without waiting for the peer to close. */
function isComplete(bytes: Uint8Array): boolean {
    const end = headEnd(bytes);
    if (end === -1) return false;
    const { fields } = headers(strFromU8(bytes.subarray(0, end), true));
    const bodyLength = bytes.length - end - 4;
    if (fields['transfer-encoding']?.toLowerCase() === 'chunked')
        return decodeChunked(bytes.subarray(end + 4)) !== undefined;
    const expected = contentLength(fields);
    return expected !== undefined && bodyLength >= expected;
}

function parseResponse(bytes: Uint8Array): { status: number; body: string } {
    const end = headEnd(bytes);
    if (end === -1) throw new Error('the answer is not HTTP');
    const { status, fields } = headers(strFromU8(bytes.subarray(0, end), true));
    let body = bytes.subarray(end + 4);
    if (fields['transfer-encoding']?.toLowerCase() === 'chunked') {
        const decoded = decodeChunked(body);
        if (decoded === undefined) throw new Error('truncated chunked body');
        body = decoded;
    } else {
        const expected = contentLength(fields);
        if (expected !== undefined) {
            if (body.length < expected) throw new Error('truncated Content-Length body');
            body = body.subarray(0, expected);
        }
    }
    return { status, body: strFromU8(body) };
}

function contentLength(fields: Record<string, string>): number | undefined {
    const token = fields['content-length'];
    if (token === undefined) return undefined;
    if (!/^[0-9]+$/.test(token) || !Number.isSafeInteger(Number(token))) {
        throw new Error('invalid Content-Length');
    }
    return Number(token);
}

/** Joins the pieces of a chunked body, or returns undefined while the last chunk hasn't arrived. */
function decodeChunked(bytes: Uint8Array): Uint8Array | undefined {
    const pieces: Uint8Array[] = [];
    let at = 0;
    for (;;) {
        let lineEnd = at;
        while (lineEnd + 1 < bytes.length && !(bytes[lineEnd] === 13 && bytes[lineEnd + 1] === 10)) lineEnd++;
        if (lineEnd + 1 >= bytes.length) return undefined;
        const token = strFromU8(bytes.subarray(at, lineEnd)).split(';')[0] ?? '';
        if (!/^[0-9a-fA-F]+$/.test(token)) throw new Error('invalid chunk size');
        const size = Number.parseInt(token, 16);
        if (!Number.isSafeInteger(size)) throw new Error('invalid chunk size');
        if (size === 0) {
            let trailer = lineEnd + 2;
            for (;;) {
                let end = trailer;
                while (end + 1 < bytes.length && !(bytes[end] === 13 && bytes[end + 1] === 10)) end++;
                if (end + 1 >= bytes.length) return undefined;
                if (end === trailer) return pieces.reduce(concat, new Uint8Array(0));
                const line = strFromU8(bytes.subarray(trailer, end));
                if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e]*$/.test(line)) {
                    throw new Error('invalid chunk trailer');
                }
                trailer = end + 2;
            }
        }
        const start = lineEnd + 2;
        if (start + size + 2 > bytes.length) return undefined;
        if (bytes[start + size] !== 13 || bytes[start + size + 1] !== 10) {
            throw new Error('invalid chunk delimiter');
        }
        pieces.push(bytes.subarray(start, start + size));
        at = start + size + 2;
    }
}
