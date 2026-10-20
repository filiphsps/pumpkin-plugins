import type { IpSocketAddress } from 'wasi:sockets/network@0.2.3';
import { wasiErrorCode } from './wasi-error.ts';

/** How often to retry a socket step that reports it would block. */
const MAX_SETTLE_ATTEMPTS = 100;

/** An IPv4 address and port, with the address as four octets. */
export interface Ipv4Endpoint {
    address: readonly [number, number, number, number];
    port: number;
}

/**
 * Runs a socket step, such as `finishBind` or `finishListen`, again while the host reports
 * `would-block`, which start/finish pairs may do while the host works.
 * @param step - The step to run.
 * @returns What the step returned once it settled.
 * @throws The step's error when it isn't `would-block`, or the last `would-block` after 100 attempts.
 */
export function settle<T>(step: () => T): T {
    for (let attempt = 1; ; attempt++) {
        try {
            return step();
        } catch (err) {
            if (wasiErrorCode(err) !== 'would-block' || attempt >= MAX_SETTLE_ATTEMPTS) throw err;
        }
    }
}

/** Writes an IPv4 endpoint as the socket address WASI sockets take. The address is copied. */
export function toIpSocketAddress({ address, port }: Ipv4Endpoint): IpSocketAddress {
    return { tag: 'ipv4', val: { address: [...address], port } };
}

/**
 * Reads an IPv4 endpoint from a socket address a WASI socket reported.
 * @returns A copy of the address and the port, or undefined for an IPv6 address.
 */
export function fromIpSocketAddress(socketAddress: IpSocketAddress): Ipv4Endpoint | undefined {
    if (socketAddress.tag !== 'ipv4') return undefined;
    const { address, port } = socketAddress.val;
    return { address: [address[0], address[1], address[2], address[3]], port };
}
