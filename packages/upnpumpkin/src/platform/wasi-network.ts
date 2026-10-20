import type { InputStream, OutputStream } from 'wasi:io/streams@0.2.3';
import type { Network as WasiNet } from 'wasi:sockets/network@0.2.3';
import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import type { IncomingDatagram, UdpSocket } from 'wasi:sockets/udp@0.2.3';
import { wasiErrorCode } from '@pumpkin-plugins/plugin-kit/wasi-error';
import { toSafeNumber } from '@pumpkin-plugins/plugin-kit/wasi-number';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { fromIpSocketAddress, settle, toIpSocketAddress } from '@pumpkin-plugins/plugin-kit/wasi-socket';
import type { Connection, Datagram, DatagramSocket, Dial, Endpoint, Ipv4, Network } from '../port-mapping.ts';

/**
 * The host resources the adapter talks to. `plugin.ts` passes the ones WASI gives a plugin; the
 * tests pass fakes, which is the only way to try what the adapter does with a socket.
 */
export interface Sockets {
    /** The network the host routes over. */
    instance(): WasiNet;
    /** Blocks for `ms` milliseconds. */
    pause?(ms: number): void;
    tcp(): TcpSocket;
    udp(): UdpSocket;
}

/** Where to point a connected UDP socket to learn which local address leads to the internet. No packet is sent. */
const INTERNET: Ipv4 = [8, 8, 8, 8];
/** Most datagrams read from a socket in one call. */
const RECEIVE_BATCH = 16;

const REASONS: Record<string, string> = {
    'access-denied': 'the plugin is not allowed to use the network that way (are the network.* permissions granted?)',
    'connection-refused': 'the connection was refused',
    timeout: 'the connection timed out',
    'network-unreachable': 'the network is unreachable',
    'host-unreachable': 'the host is unreachable',
};

function describe(err: unknown): string {
    const code = wasiErrorCode(err);
    if (code) return REASONS[code] ?? code;
    return err instanceof Error ? err.message : String(err);
}

function bindAnyPort(socket: UdpSocket, network: WasiNet): void {
    socket.startBind(network, toIpSocketAddress({ address: [0, 0, 0, 0], port: 0 }));
    settle(() => socket.finishBind());
}

class WasiDatagramSocket implements DatagramSocket {
    private closed = false;
    private pending: IncomingDatagram[] = [];

    constructor(
        private readonly socket: UdpSocket,
        private readonly incoming: ReturnType<UdpSocket['stream']>[0],
        private readonly outgoing: ReturnType<UdpSocket['stream']>[1],
    ) {}

    send(to: Endpoint, data: Uint8Array): void {
        // A datagram may only be sent after check-send allowed it; sending without asking traps.
        if (this.outgoing.checkSend() < 1n) throw new Error('the socket cannot send right now');
        this.outgoing.send([{ data, remoteAddress: toIpSocketAddress(to) }]);
    }

    receive(): Datagram | undefined {
        if (this.closed) return undefined;
        if (this.pending.length === 0) this.pending = this.incoming.receive(BigInt(RECEIVE_BATCH));
        for (let packet = this.pending.shift(); packet; packet = this.pending.shift()) {
            const from = fromIpSocketAddress(packet.remoteAddress);
            if (from) return { from, data: packet.data };
        }
        return undefined;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.pending = [];
        for (const resource of [this.incoming, this.outgoing, this.socket]) {
            try {
                disposeWasiResource(resource);
            } catch {
                // Already released.
            }
        }
    }
}

class WasiConnection implements Connection {
    private closed = false;

    constructor(
        private readonly socket: TcpSocket,
        private readonly input: InputStream,
        private readonly output: OutputStream,
        readonly localAddress: Ipv4,
    ) {}

    read(max: number): Uint8Array | null | 'closed' {
        try {
            const bytes = this.input.read(BigInt(max));
            return bytes.length > 0 ? bytes : null;
        } catch (err) {
            if (wasiErrorCode(err) === 'closed') return 'closed';
            throw err;
        }
    }

    writable(): number {
        return toSafeNumber(this.output.checkWrite(), 'WASI writable byte count');
    }

    write(bytes: Uint8Array): void {
        this.output.write(bytes);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const resource of [this.input, this.output, this.socket]) {
            try {
                disposeWasiResource(resource);
            } catch {
                // Already released.
            }
        }
    }
}

class WasiDial implements Dial {
    private socket: TcpSocket | undefined;

    constructor(sockets: Sockets, to: Endpoint) {
        const socket = sockets.tcp();
        try {
            socket.startConnect(sockets.instance(), toIpSocketAddress(to));
        } catch (err) {
            disposeWasiResource(socket);
            throw new Error(describe(err));
        }
        this.socket = socket;
    }

    poll(): Connection | undefined {
        const socket = this.socket;
        if (!socket) return undefined;
        let streams: [InputStream, OutputStream] | undefined;
        try {
            streams = socket.finishConnect();
            const local = fromIpSocketAddress(socket.localAddress())?.address ?? [0, 0, 0, 0];
            const connection = new WasiConnection(socket, streams[0], streams[1], local);
            this.socket = undefined;
            return connection;
        } catch (err) {
            if (!streams && wasiErrorCode(err) === 'would-block') return undefined;
            for (const stream of streams ?? []) {
                try {
                    disposeWasiResource(stream);
                } catch {
                    // Already released.
                }
            }
            this.abort();
            throw new Error(describe(err));
        }
    }

    abort(): void {
        const socket = this.socket;
        this.socket = undefined;
        try {
            disposeWasiResource(socket);
        } catch {
            // Already released.
        }
    }
}

/**
 * The `Network` the port mapping code runs on, over WASI UDP and TCP sockets. A UDP socket lets the
 * operating system choose the local interface without sending a packet.
 *
 * @param sockets - The host's sockets, from `wasiSockets` on a real server.
 */
export class WasiNetwork implements Network {
    constructor(private readonly sockets: Sockets) {}

    /** {@inheritDoc port-mapping!Network#now} */
    now(): number {
        return Date.now();
    }

    /** {@inheritDoc port-mapping!Network#pause} */
    pause(ms: number): void {
        this.sockets.pause?.(ms);
    }

    /** {@inheritDoc port-mapping!Network#openDatagram} */
    openDatagram(): DatagramSocket {
        const socket = this.sockets.udp();
        try {
            bindAnyPort(socket, this.sockets.instance());
            const [incoming, outgoing] = socket.stream(undefined);
            return new WasiDatagramSocket(socket, incoming, outgoing);
        } catch (err) {
            disposeWasiResource(socket);
            throw new Error(describe(err));
        }
    }

    /** {@inheritDoc port-mapping!Network#dial} */
    dial(to: Endpoint): Dial {
        return new WasiDial(this.sockets, to);
    }

    /** {@inheritDoc port-mapping!Network#localAddress} */
    localAddress(toward: Ipv4 = INTERNET): Ipv4 | undefined {
        const socket = this.sockets.udp();
        try {
            bindAnyPort(socket, this.sockets.instance());
            const [incoming, outgoing] = socket.stream(toIpSocketAddress({ address: toward, port: 9 }));
            try {
                const local = fromIpSocketAddress(socket.localAddress())?.address;
                return local?.[0] === 0 ? undefined : local;
            } finally {
                disposeWasiResource(incoming);
                disposeWasiResource(outgoing);
            }
        } catch {
            return undefined;
        } finally {
            disposeWasiResource(socket);
        }
    }
}
