import { type Endpoint, sameIpv4 } from './ipv4.ts';
import type { Datagram, DatagramSocket, Network } from './network.ts';
import type { Steps } from './task.ts';

/** Waits for `ms` milliseconds. */
export function* sleep(net: Network, ms: number): Steps<void> {
    const until = net.now() + ms;
    while (net.now() < until) yield;
}

/**
 * Sends a datagram and waits for an answer, sending again after each timeout.
 * @param accept - Reads a datagram that arrived, returning undefined for ones that aren't the answer.
 * @param timeouts - How long to wait after each send, in milliseconds. One send per entry.
 * @throws {Error} When none of the sends was answered.
 */
export function* udpRequest<T>(
    net: Network,
    socket: DatagramSocket,
    to: Endpoint,
    packet: Uint8Array,
    accept: (datagram: Datagram) => T | undefined,
    timeouts: readonly number[]
): Steps<T> {
    for (const timeout of timeouts) {
        socket.send(to, packet);
        const until = net.now() + timeout;
        while (net.now() < until) {
            for (let d = socket.receive(); d; d = socket.receive()) {
                if (!sameIpv4(d.from.address, to.address)) continue;
                const value = accept(d);
                if (value !== undefined) return value;
            }
            yield;
        }
    }
    throw new Error('no answer');
}
