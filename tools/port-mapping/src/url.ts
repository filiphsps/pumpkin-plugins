import { type Endpoint, parseIpv4 } from './ipv4.ts';

/** An `http://` URL whose host is an IPv4 address, which is how routers describe themselves. */
export interface HttpUrl {
    endpoint: Endpoint;
    /** Path and query, always starting with `/`. */
    path: string;
}

/**
 * Reads an `http://` URL with an IPv4 host.
 * @returns The parts, or undefined for anything else (https, host names, IPv6).
 */
export function parseHttpUrl(text: string): HttpUrl | undefined {
    const match = /^http:\/\/([^/:?#]+)(?::(\d{1,5}))?([^#]*)(?:#.*)?$/i.exec(text.trim());
    if (!match) return undefined;
    const address = parseIpv4(match[1] as string);
    const port = match[2] === undefined ? 80 : Number(match[2]);
    if (!address || port < 1 || port > 65535) return undefined;
    const rest = match[3] ?? '';
    return { endpoint: { address, port }, path: rest.startsWith('/') ? rest : `/${rest}` };
}

/**
 * Resolves a URL that may be relative to the document it was found in.
 * @param reference - A full URL or a path such as `/ctl/IPConn`.
 * @param base - The URL of the document, or the `URLBase` it names.
 */
export function resolveUrl(reference: string, base: string): string {
    if (/^https?:\/\//i.test(reference)) return reference;
    const origin = /^(https?:\/\/[^/?#]+)/i.exec(base)?.[1];
    if (!origin) return reference;
    if (reference.startsWith('/')) return `${origin}${reference}`;
    const directory = base
        .slice(origin.length)
        .replace(/[?#].*$/, '')
        .replace(/[^/]*$/, '');
    return `${origin}${directory || '/'}${reference}`;
}
