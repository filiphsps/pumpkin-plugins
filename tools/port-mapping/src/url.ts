import { type Endpoint, parseIpv4 } from './ipv4.ts';

/** An `http://` URL whose host is an IPv4 address, which is how routers describe themselves. */
export interface HttpUrl {
    endpoint: Endpoint;
    /** Path and query, always starting with `/`. */
    path: string;
}

/**
 * Reads an `http://` URL with an IPv4 host.
 * Scans delimiters directly to avoid regex denial of service on long, untrusted router URLs.
 * @returns The parts, or undefined for anything else (https, host names, IPv6).
 */
export function parseHttpUrl(text: string): HttpUrl | undefined {
    const input = text.trim();
    const schemeEnd = input.indexOf('://');
    if (schemeEnd < 0 || input.slice(0, schemeEnd).toLowerCase() !== 'http') return undefined;

    const authorityStart = schemeEnd + 3;
    let authorityEnd = input.length;
    for (const delimiter of ['/', '?', '#']) {
        const delimiterIndex = input.indexOf(delimiter, authorityStart);
        if (delimiterIndex >= 0 && delimiterIndex < authorityEnd) authorityEnd = delimiterIndex;
    }

    const authority = input.slice(authorityStart, authorityEnd);
    if (!authority) return undefined;

    const portSeparator = authority.indexOf(':');
    let host = authority;
    let port = 80;
    if (portSeparator >= 0) {
        if (authority.indexOf(':', portSeparator + 1) >= 0) return undefined;
        host = authority.slice(0, portSeparator);
        const portText = authority.slice(portSeparator + 1);
        if (
            portText.length === 0 ||
            portText.length > 5 ||
            ![...portText].every((digit) => digit >= '0' && digit <= '9')
        ) {
            return undefined;
        }
        port = Number(portText);
    }

    const address = parseIpv4(host);
    if (!address || port < 1 || port > 65535) return undefined;
    const fragmentStart = input.indexOf('#', authorityEnd);
    const rest = input.slice(authorityEnd, fragmentStart < 0 ? input.length : fragmentStart);
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
