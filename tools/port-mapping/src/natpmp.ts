import type { Gateway, MappingRequest, MappingResult } from './gateway.ts';
import type { Endpoint, Ipv4 } from './ipv4.ts';
import type { Datagram, Network } from './network.ts';
import { udpRequest } from './steps.ts';
import type { Steps } from './task.ts';

/** The port NAT-PMP gateways listen on (RFC 6886). */
export const NAT_PMP_PORT = 5351;

/** Waits between sends, doubling as the RFC suggests but giving up sooner than its full schedule. */
const TIMEOUTS = [250, 500, 1000];

const RESULT_TEXT: Record<number, string> = {
    1: 'the router does not support this NAT-PMP version',
    2: 'the router refused (port mapping is not enabled for this machine)',
    3: 'the router has no connection to the internet',
    4: 'the router is out of mappings',
    5: 'the router does not support this request'
};

/** The request that asks for the router's external address. */
export function externalAddressRequest(): Uint8Array {
    return Uint8Array.of(0, 0);
}

/** The request that opens (or, with a lifetime of 0, closes) a port. */
export function mappingRequest(
    protocol: 'tcp' | 'udp',
    internalPort: number,
    externalPort: number,
    lifetime: number
): Uint8Array {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    bytes[1] = protocol === 'udp' ? 1 : 2;
    view.setUint16(4, internalPort);
    view.setUint16(6, externalPort);
    view.setUint32(8, lifetime);
    return bytes;
}

/**
 * Reads the answer to an external address request.
 * @returns The address, or undefined when the datagram isn't that answer.
 * @throws {Error} When the router answered with an error code.
 */
export function parseExternalAddress(data: Uint8Array): Ipv4 | undefined {
    if (data.length !== 12 || data[0] !== 0 || data[1] !== 128) return undefined;
    checkResult(data);
    return [data[8] as number, data[9] as number, data[10] as number, data[11] as number];
}

/**
 * Reads the answer to a mapping request.
 * @returns The port and lifetime the router gave, or undefined when the datagram isn't that answer.
 * @throws {Error} When the router answered with an error code.
 */
export function parseMapping(
    data: Uint8Array,
    protocol: 'tcp' | 'udp',
    internalPort: number
): { externalPort: number; lifetime: number } | undefined {
    if (data.length !== 16 || data[0] !== 0 || data[1] !== 128 + (protocol === 'udp' ? 1 : 2)) return undefined;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint16(8) !== internalPort) return undefined;
    checkResult(data);
    return { externalPort: view.getUint16(10), lifetime: view.getUint32(12) };
}

function checkResult(data: Uint8Array): void {
    const code = ((data[2] as number) << 8) | (data[3] as number);
    if (code !== 0) throw new Error(RESULT_TEXT[code] ?? `the router answered with code ${code}`);
}

/** A router reached with NAT-PMP. */
export class NatPmpGateway implements Gateway {
    readonly kind = 'nat-pmp';
    private readonly to: Endpoint;

    /** Creates a gateway at the given address. Nothing is sent until it is used. */
    constructor(
        private readonly net: Network,
        readonly address: Ipv4,
        port = NAT_PMP_PORT
    ) {
        this.to = { address, port };
    }

    /** {@inheritDoc gateway!Gateway#externalAddress} */
    *externalAddress(): Steps<Ipv4> {
        return yield* this.ask(externalAddressRequest(), (d) => parseExternalAddress(d.data));
    }

    /** {@inheritDoc gateway!Gateway#addMapping} */
    *addMapping(request: MappingRequest): Steps<MappingResult> {
        const { protocol, internalPort, externalPort, leaseSeconds } = request;
        // NAT-PMP has no permanent mappings; a lifetime of 0 means "delete".
        const lifetime = leaseSeconds > 0 ? leaseSeconds : 7200;
        const got = yield* this.ask(mappingRequest(protocol, internalPort, externalPort, lifetime), (d) =>
            parseMapping(d.data, protocol, internalPort)
        );
        return { externalPort: got.externalPort, leaseSeconds: got.lifetime };
    }

    /** {@inheritDoc gateway!Gateway#deleteMapping} */
    *deleteMapping(request: MappingRequest): Steps<void> {
        const { protocol, internalPort } = request;
        yield* this.ask(mappingRequest(protocol, internalPort, 0, 0), (d) =>
            parseMapping(d.data, protocol, internalPort)
        );
    }

    private *ask<T>(packet: Uint8Array, accept: (datagram: Datagram) => T | undefined): Steps<T> {
        const socket = this.net.openDatagram();
        try {
            return yield* udpRequest(this.net, socket, this.to, packet, accept, TIMEOUTS);
        } finally {
            socket.close();
        }
    }
}
