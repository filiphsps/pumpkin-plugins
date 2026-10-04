import type { InputStream, OutputStream } from 'wasi:io/streams@0.2.3';
import type { IpSocketAddress, Network as WasiNet } from 'wasi:sockets/network@0.2.3';
import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import type { UdpSocket } from 'wasi:sockets/udp@0.2.3';
import { wasiErrorCode } from '@pumpkin-plugins/plugin-kit/wasi-error';
import type {
    Connection,
    Datagram,
    DatagramSocket,
    Dial,
    Endpoint,
    Ipv4,
    Network
} from '@pumpkin-plugins/port-mapping';

/**
 * The host resources the adapter talks to. `plugin.ts` passes the ones WASI gives a plugin; the
 * tests pass fakes, which is the only way to try what the adapter does with a socket.
 */
export interface Sockets {
    /** The network the host routes over. */
    instance(): WasiNet;
    tcp(): TcpSocket;
    udp(): UdpSocket;
}

/** Where to point a connected UDP socket to learn which local address leads to the internet. No packet is sent. */
const INTERNET: Ipv4 = [8, 8, 8, 8];
/** How often to retry a socket step that reports it would block. */
const MAX_SETTLE_ATTEMPTS = 100;
/** Most datagrams read from a socket in one call. */
const RECEIVE_BATCH = 16;

const REASONS: Record<string, string> = {
    'access-denied': 'the plugin is not allowed to use the network that way (are the network.* permissions granted?)',
    'connection-refused': 'the connection was refused',
    timeout: 'the connection timed out',
    'network-unreachable': 'the network is unreachable',
    'host-unreachable': 'the host is unreachable'
};

const address = ({ address, port }: Endpoint): IpSocketAddress => ({
    tag: 'ipv4',
    val: { port, address: [...address] as Ipv4 & [number, number, number, number] }
});

function describe(err: unknown): string {
    const code = wasiErrorCode(err);
    if (code) return REASONS[code] ?? code;
    return err instanceof Error ? err.message : String(err);
}

/** Socket start/finish pairs may report `would-block` while the host works; try again until they settle. */
function settle<T>(step: () => T): T {
    for (let attempt = 1; ; attempt++) {
        try {
            return step();
        } catch (err) {
            if (wasiErrorCode(err) !== 'would-block' || attempt >= MAX_SETTLE_ATTEMPTS) throw err;
        }
    }
}

function bindAnyPort(socket: UdpSocket, network: WasiNet): void {
    socket.startBind(network, { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } });
    settle(() => socket.finishBind());
}

class WasiDatagramSocket implements DatagramSocket {
    private closed = false;

    constructor(
        private readonly socket: UdpSocket,
        private readonly incoming: ReturnType<UdpSocket['stream']>[0],
        private readonly outgoing: ReturnType<UdpSocket['stream']>[1]
    ) {}

    send(to: Endpoint, data: Uint8Array): void {
        // A datagram may only be sent after check-send allowed it; sending without asking traps.
        if (this.outgoing.checkSend() < 1) throw new Error('the socket cannot send right now');
        this.outgoing.send([{ data, remoteAddress: address(to) }]);
    }

    receive(): Datagram | undefined {
        const [first] = this.incoming.receive(RECEIVE_BATCH);
        if (first?.remoteAddress.tag !== 'ipv4') return undefined;
        const { address: from, port } = first.remoteAddress.val;
        return { from: { address: [from[0], from[1], from[2], from[3]], port }, data: first.data };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const resource of [this.incoming, this.outgoing, this.socket]) {
            try {
                resource[Symbol.dispose]();
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
        readonly localAddress: Ipv4
    ) {}

    read(max: number): Uint8Array | null | 'closed' {
        try {
            const bytes = this.input.read(max);
            return bytes.length > 0 ? bytes : null;
        } catch (err) {
            if (wasiErrorCode(err) === 'closed') return 'closed';
            throw err;
        }
    }

    writable(): number {
        return this.output.checkWrite();
    }

    write(bytes: Uint8Array): void {
        this.output.write(bytes);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const resource of [this.input, this.output, this.socket]) {
            try {
                resource[Symbol.dispose]();
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
            socket.startConnect(sockets.instance(), address(to));
        } catch (err) {
            socket[Symbol.dispose]();
            throw new Error(describe(err));
        }
        this.socket = socket;
    }

    poll(): Connection | undefined {
        const socket = this.socket;
        if (!socket) return undefined;
        try {
            const [input, output] = socket.finishConnect();
            this.socket = undefined;
            const local = socket.localAddress();
            const from = local.tag === 'ipv4' ? local.val.address : [0, 0, 0, 0];
            return new WasiConnection(socket, input, output, [from[0] ?? 0, from[1] ?? 0, from[2] ?? 0, from[3] ?? 0]);
        } catch (err) {
            if (wasiErrorCode(err) === 'would-block') return undefined;
            this.abort();
            throw new Error(describe(err));
        }
    }

    abort(): void {
        this.socket?.[Symbol.dispose]();
        this.socket = undefined;
    }
}

/**
 * The `Network` the port mapping code runs on, over WASI UDP and TCP sockets.
 *
 * @param sockets - The host's sockets, from `wasiSockets` on a real server.
 */
export class WasiNetwork implements Network {
    constructor(private readonly sockets: Sockets) {}

    /** {@inheritDoc Network.now} */
    now(): number {
        return Date.now();
    }

    /** {@inheritDoc Network.openDatagram} */
    openDatagram(): DatagramSocket {
        const socket = this.sockets.udp();
        try {
            bindAnyPort(socket, this.sockets.instance());
            const [incoming, outgoing] = socket.stream(undefined);
            return new WasiDatagramSocket(socket, incoming, outgoing);
        } catch (err) {
            socket[Symbol.dispose]();
            throw new Error(describe(err));
        }
    }

    /** {@inheritDoc Network.dial} */
    dial(to: Endpoint): Dial {
        return new WasiDial(this.sockets, to);
    }

    /**
     * {@inheritDoc Network.localAddress}
     * Found by pointing a UDP socket at the destination: the operating system picks the interface
     * and tells which address it would send from, without sending anything.
     */
    localAddress(toward: Ipv4 = INTERNET): Ipv4 | undefined {
        const socket = this.sockets.udp();
        try {
            bindAnyPort(socket, this.sockets.instance());
            const [incoming, outgoing] = socket.stream(address({ address: toward, port: 9 }));
            try {
                const local = socket.localAddress();
                if (local.tag !== 'ipv4') return undefined;
                const [a, b, c, d] = local.val.address;
                return a === 0 ? undefined : [a, b, c, d];
            } finally {
                incoming[Symbol.dispose]();
                outgoing[Symbol.dispose]();
            }
        } catch {
            return undefined;
        } finally {
            socket[Symbol.dispose]();
        }
    }
}
