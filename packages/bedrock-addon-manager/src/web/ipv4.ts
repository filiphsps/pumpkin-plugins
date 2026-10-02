/** An IPv4 address as the four numbers WASI sockets take. */
export type Ipv4 = [number, number, number, number];

/**
 * Reads a dotted IPv4 address.
 * @param text - For example `0.0.0.0`.
 * @returns The four octets, or undefined when the text isn't a dotted quad.
 */
export function parseIpv4(text: string): Ipv4 | undefined {
    const parts = text.split('.');
    if (parts.length !== 4) return undefined;
    const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
    return octets.every((n) => n >= 0 && n <= 255) ? (octets as Ipv4) : undefined;
}
