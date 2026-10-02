import { strFromU8, strToU8 } from 'fflate';

/** Longest request head accepted. Anything longer is answered with 400. */
export const MAX_REQUEST_BYTES = 8192;

/** A parsed HTTP request head. The body is never read. */
export interface HttpRequest {
    method: string;
    target: string;
    /** Header names are lowercased. */
    headers: Record<string, string>;
}

const REQUEST_LINE = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/;

/** Parses a request head. `incomplete` until the blank line arrives, `bad` for anything malformed or too big. */
export function parseRequest(buffer: Uint8Array): HttpRequest | 'incomplete' | 'bad' {
    const end = indexOfHeaderEnd(buffer);
    if (end === -1) return buffer.length >= MAX_REQUEST_BYTES ? 'bad' : 'incomplete';

    const lines = strFromU8(buffer.subarray(0, end), true).split('\r\n');
    const match = REQUEST_LINE.exec(lines[0]);
    if (!match) return 'bad';

    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon <= 0) return 'bad';
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { method: match[1], target: match[2], headers };
}

function indexOfHeaderEnd(buffer: Uint8Array): number {
    for (let i = 0; i + 3 < buffer.length; i++) {
        if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) return i;
    }
    return -1;
}

/** The pack file name for `/packs/<name>`, or null when the target is anything else. */
export function routePack(target: string): string | null {
    const path = target.split(/[?#]/)[0];
    if (!path.startsWith('/packs/')) return null;
    let name: string;
    try {
        name = decodeURIComponent(path.slice('/packs/'.length));
    } catch {
        return null;
    }
    if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) return null;
    return name;
}

/** A range of bytes in a file, as asked for by a `Range` header. */
export interface ByteRange {
    /** Inclusive offsets. */
    start: number;
    end: number;
}

/**
 * Reads a single-range `Range` header. Malformed or multi-range headers are ignored (the whole
 * file is served, which HTTP allows); a range past the end is `unsatisfiable`.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
    if (!match || (match[1] === '' && match[2] === '')) return undefined;

    if (match[1] === '') {
        const suffix = Number(match[2]);
        if (suffix === 0 || size === 0) return 'unsatisfiable';
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(match[1]);
    if (start >= size) return 'unsatisfiable';
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    return end < start ? undefined : { start, end };
}

const REASONS: Record<number, string> = {
    200: 'OK',
    206: 'Partial Content',
    400: 'Bad Request',
    404: 'Not Found',
    405: 'Method Not Allowed',
    416: 'Range Not Satisfiable'
};

/** Status line and headers, ending with the blank line. The connection is always closed after a response. */
export function responseHead(status: number, headers: Record<string, string | number>): Uint8Array {
    const lines = [`HTTP/1.1 ${status} ${REASONS[status] ?? 'Unknown'}`];
    for (const [name, value] of Object.entries({ ...headers, Connection: 'close' })) lines.push(`${name}: ${value}`);
    return strToU8(`${lines.join('\r\n')}\r\n\r\n`);
}
