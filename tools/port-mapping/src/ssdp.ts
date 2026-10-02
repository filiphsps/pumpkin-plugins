import { strFromU8, strToU8 } from 'fflate';
import type { Endpoint } from './ipv4.ts';

/** The multicast address and port every UPnP device listens on for searches. */
export const SSDP_ADDRESS: Endpoint = { address: [239, 255, 255, 250], port: 1900 };

/** What to search for: gateways and the WAN connection services they offer. */
export const SEARCH_TARGETS = [
    'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
    'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    'urn:schemas-upnp-org:service:WANIPConnection:2',
    'urn:schemas-upnp-org:service:WANIPConnection:1',
    'urn:schemas-upnp-org:service:WANPPPConnection:1'
];

/** The M-SEARCH message that asks devices of one kind to answer. */
export function searchRequest(target: string, host: Endpoint = SSDP_ADDRESS): Uint8Array {
    const [a, b, c, d] = host.address;
    return strToU8(
        [
            'M-SEARCH * HTTP/1.1',
            `HOST: ${a}.${b}.${c}.${d}:${host.port}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${target}`,
            '',
            ''
        ].join('\r\n')
    );
}

/**
 * Reads a device's answer to a search.
 * @returns Where its description document is, or undefined when this isn't an answer.
 */
export function parseSearchResponse(data: Uint8Array): string | undefined {
    const lines = strFromU8(data).split('\r\n');
    if (!/^HTTP\/1\.1 200/i.test(lines[0] ?? '')) return undefined;
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === 'location') return line.slice(colon + 1).trim();
    }
    return undefined;
}
