import type { Endpoint, Ipv4 } from './ipv4.ts';

/** One datagram that arrived. */
export interface Datagram {
    from: Endpoint;
    data: Uint8Array;
}

/** A UDP socket that is never waited on: every call returns at once. */
export interface DatagramSocket {
    /** Sends one datagram. */
    send(to: Endpoint, data: Uint8Array): void;
    /** The next datagram that has arrived, or undefined when there is none. */
    receive(): Datagram | undefined;
    /** Releases the socket. Safe to call twice. */
    close(): void;
}

/** A TCP connection that is never waited on. */
export interface Connection {
    /** The address of this machine on the network the connection uses. */
    readonly localAddress: Ipv4;
    /** Up to `max` bytes, `null` when nothing has arrived yet, `'closed'` when the peer is gone. */
    read(max: number): Uint8Array | null | 'closed';
    /** How many bytes can be written right now. */
    writable(): number;
    /** Queues bytes for sending. At most `writable()` bytes at a time. */
    write(bytes: Uint8Array): void;
    /** Releases the connection. Safe to call twice. */
    close(): void;
}

/** A TCP connection that is still being made. */
export interface Dial {
    /**
     * Moves the connection forward.
     * @returns The connection once it is up, or undefined while it is still being made.
     * @throws {Error} With a message fit for a log when it can't be made.
     */
    poll(): Connection | undefined;
    /** Gives up on a connection that isn't up yet. */
    abort(): void;
}

/** What the port mapping code needs from the host. A plugin implements it over WASI sockets. */
export interface Network {
    /** Opens a UDP socket bound to any free port. */
    openDatagram(): DatagramSocket;
    /** Starts a TCP connection. */
    dial(to: Endpoint): Dial;
    /**
     * The address this machine uses to reach `toward`, or the internet when that is omitted.
     * @returns The address, or undefined when there is no route.
     */
    localAddress(toward?: Ipv4): Ipv4 | undefined;
    /** The current time in milliseconds. */
    now(): number;
}
