/** An IPv4 address as four numbers, the form WASI sockets take. */
export type Ipv4 = readonly [number, number, number, number];

/** A host and port on the network. */
export interface Endpoint {
    address: Ipv4;
    port: number;
}

/**
 * Reads a dotted IPv4 address.
 * @param text - For example `192.168.1.1`.
 * @returns The four octets, or undefined when the text isn't a dotted quad.
 */
export function parseIpv4(text: string): Ipv4 | undefined {
    const parts = text.trim().split('.');
    if (parts.length !== 4) return undefined;
    const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
    return octets.every((n) => n >= 0 && n <= 255) ? (octets as unknown as Ipv4) : undefined;
}

/** Writes an address in dotted form. */
export function formatIpv4(address: Ipv4): string {
    return address.join('.');
}

/** Whether two addresses are the same. */
export function sameIpv4(a: Ipv4, b: Ipv4): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Whether the address can be reached from the internet: not private (RFC 1918), shared carrier
 * space (100.64.0.0/10), loopback, link-local, multicast or otherwise reserved.
 */
export function isPublicIpv4(address: Ipv4): boolean {
    const [a, b, c] = address;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
}
