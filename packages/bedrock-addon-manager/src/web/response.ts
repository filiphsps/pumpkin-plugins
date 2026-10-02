import { strToU8 } from 'fflate';
import type { RandomAccessFile } from '../platform/files.ts';
import { type ByteRange, type HttpRequest, parseRange, responseHead, routePack } from './http.ts';

/** An open pack file. */
export type PackFile = RandomAccessFile;

/** Opens the pack registered under a file name. Returns undefined when there is no such pack. */
export type PackLookup = (fileName: string) => PackFile | undefined;

/** The part of a pack still to be sent. */
export interface ResponseBody {
    /** The open pack file. The session closes it. */
    file: PackFile;
    /** Next offset to read. */
    offset: number;
    /** Bytes still to send. */
    remaining: number;
}

/** What to send for a request. */
export interface ResponsePlan {
    /** The status line, headers and, for small error responses, the whole body. */
    head: Uint8Array;
    /** A pack to stream after the head. Absent for errors, `HEAD` requests and empty ranges. */
    body?: ResponseBody;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

function textResponse(status: number, extra: Record<string, string> = {}): ResponsePlan {
    const body = strToU8(`${status}\n`);
    const head = responseHead(status, { 'Content-Type': 'text/plain', 'Content-Length': body.length, ...extra });
    return { head: concat(head, body) };
}

/**
 * Decides what to send for a request. Only `GET` and `HEAD` for `/packs/<name>` succeed, and
 * only for a name the lookup knows, so no request can reach any other file.
 * @param request - The parsed request, or undefined when it was malformed.
 * @param lookup - Opens a pack by file name.
 * @returns The response head and, when there is one, the pack to stream.
 */
export function planResponse(request: HttpRequest | undefined, lookup: PackLookup): ResponsePlan {
    if (!request) return textResponse(400);
    if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, { Allow: 'GET, HEAD' });

    const name = routePack(request.target);
    const file = name === null ? undefined : lookup(name);
    if (!file) return textResponse(404);

    const range = parseRange(request.headers.range, file.size);
    if (range === 'unsatisfiable') {
        file.close();
        return { head: responseHead(416, { 'Content-Range': `bytes */${file.size}`, 'Content-Length': 0 }) };
    }

    const slice: ByteRange = range ?? { start: 0, end: file.size - 1 };
    const length = file.size === 0 ? 0 : slice.end - slice.start + 1;
    const headers: Record<string, string | number> = {
        'Content-Type': 'application/zip',
        'Content-Length': length,
        'Accept-Ranges': 'bytes'
    };
    if (range) headers['Content-Range'] = `bytes ${slice.start}-${slice.end}/${file.size}`;
    const head = responseHead(range ? 206 : 200, headers);

    if (request.method === 'HEAD' || length === 0) {
        file.close();
        return { head };
    }
    return { head, body: { file, offset: slice.start, remaining: length } };
}
