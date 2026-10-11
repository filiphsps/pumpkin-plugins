import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import type { IncomingDatagram, OutgoingDatagram, UdpSocket } from 'wasi:sockets/udp@0.2.3';
import { discover } from '@pumpkin-plugins/port-mapping';
import { FakeIgd, FakeNetwork, runSteps } from '@pumpkin-plugins/port-mapping/testing';
import { describe, expect, it, vi } from 'vitest';
import { type Sockets, WasiNetwork } from './wasi-network.ts';

/** How a WASI socket reports an error, as a thrown value. Stream errors carry an object. */
const wasiError = (code: string): Error => Object.assign(new Error(code), { payload: code });

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** One datagram a socket has ready to read. */
const datagram = (address: [number, number, number, number], port: number, body: string): IncomingDatagram => ({
    data: bytes(body),
    remoteAddress: { tag: 'ipv4', val: { port, address } }
});

interface FakeUdp {
    socket: UdpSocket;
    /** Calls into the incoming host stream. */
    readonly incoming: { receive(max: bigint): IncomingDatagram[] };
    /** The address the socket reports itself as. */
    setLocal(address: [number, number, number, number]): void;
    /** Make the next `finishBind` calls report `would-block`. */
    blockBind(times: number): void;
    /** Make binding fail. */
    failBind(code: string): void;
    /** Make sending without `checkSend` permitted. */
    allowSend(count: number): void;
    /** The datagrams the socket hands out, one batch per call to `receive`. */
    queue(...batches: IncomingDatagram[][]): void;
    /** What was sent, as text and the address it was sent to. */
    readonly sent: { text: string; to: string | undefined }[];
    disposed: { socket: number; incoming: number; outgoing: number };
}

/** A UDP socket that binds, streams, and remembers what it was told. */
function fakeUdp(local: [number, number, number, number] = [192, 168, 1, 50]): FakeUdp {
    let blocks = 0;
    let bindError: string | undefined;
    let allowed = 1n;
    let batches: IncomingDatagram[][] = [];
    const sent: { text: string; to: string | undefined }[] = [];
    const disposed = { socket: 0, incoming: 0, outgoing: 0 };

    const incoming = {
        receive: vi.fn((max: bigint) => (batches.length > 0 ? (batches.shift() ?? []).slice(0, Number(max)) : [])),
        [Symbol.dispose]: vi.fn(() => disposed.incoming++)
    };
    const outgoing = {
        checkSend: vi.fn(() => allowed),
        send: vi.fn((datagrams: OutgoingDatagram[]) => {
            allowed -= BigInt(datagrams.length);
            for (const { data, remoteAddress } of datagrams)
                sent.push({
                    text: text(data),
                    to: remoteAddress?.val.address.join('.')
                });
            return BigInt(datagrams.length);
        }),
        [Symbol.dispose]: vi.fn(() => disposed.outgoing++)
    };
    const socket = {
        startBind: vi.fn(),
        finishBind: vi.fn(() => {
            if (bindError) throw wasiError(bindError);
            if (blocks > 0) {
                blocks -= 1;
                throw wasiError('would-block');
            }
        }),
        stream: vi.fn(() => [incoming, outgoing]),
        localAddress: () => ({ tag: 'ipv4', val: { port: 40000, address: local } }),
        [Symbol.dispose]: vi.fn(() => disposed.socket++)
    };
    return {
        socket: socket as unknown as UdpSocket,
        incoming,
        setLocal: (address) => (local = address),
        blockBind: (times) => (blocks = times),
        failBind: (code) => (bindError = code),
        allowSend: (count) => (allowed = BigInt(count)),
        queue: (...next) => (batches = next),
        sent,
        disposed
    };
}

interface FakeTcp {
    socket: TcpSocket;
    /** Make the next `finishConnect` calls report `would-block`. */
    blockConnect(times: number): void;
    /** Make connecting fail at `startConnect`. */
    failConnect(code: string): void;
    /** Make the connection break once it is made. */
    failFinish(code: string): void;
    /** What `read` gives back, and what it throws when given an error. */
    read(bytesToGive: Uint8Array): void;
    readError(code: string): void;
    disposed: { socket: number; input: number; output: number };
    writable: () => number;
    written: Uint8Array | undefined;
}

/** A TCP socket that connects once the host says so. */
function fakeTcp(local: [number, number, number, number] = [192, 168, 1, 50]): FakeTcp {
    let blocks = 0;
    let connectError: string | undefined;
    let finishError: string | undefined;
    let readResult: Uint8Array | undefined;
    let readFailure: string | undefined;
    let written: Uint8Array | undefined;
    const disposed = { socket: 0, input: 0, output: 0 };

    const input = {
        read: vi.fn(() => {
            if (readFailure) throw Object.assign(new Error(readFailure), { payload: { tag: readFailure } });
            return readResult ?? new Uint8Array();
        }),
        [Symbol.dispose]: vi.fn(() => disposed.input++)
    };
    const output = {
        checkWrite: () => 1024n,
        write: vi.fn((data: Uint8Array) => {
            written = data;
        }),
        [Symbol.dispose]: vi.fn(() => disposed.output++)
    };
    const socket = {
        startConnect: vi.fn(() => {
            if (connectError) throw wasiError(connectError);
        }),
        finishConnect: vi.fn(() => {
            if (finishError) throw wasiError(finishError);
            if (blocks > 0) {
                blocks -= 1;
                throw wasiError('would-block');
            }
            return [input, output];
        }),
        localAddress: () => ({ tag: 'ipv4', val: { port: 50000, address: local } }),
        [Symbol.dispose]: vi.fn(() => disposed.socket++)
    };
    return {
        socket: socket as unknown as TcpSocket,
        blockConnect: (times) => (blocks = times),
        failConnect: (code) => (connectError = code),
        failFinish: (code) => (finishError = code),
        read: (given) => (readResult = given),
        readError: (code) => (readFailure = code),
        disposed,
        writable: () => Number(output.checkWrite()),
        get written() {
            return written;
        }
    };
}

/** Wires the adapter up to the given sockets. `plugin.ts` passes the host's own. */
function adapter(tcp: FakeTcp, udp: FakeUdp = fakeUdp()): WasiNetwork {
    const sockets: Sockets = {
        instance: () => ({}) as never,
        tcp: () => tcp.socket,
        udp: () => udp.socket
    };
    return new WasiNetwork(sockets);
}

describe('a datagram socket', () => {
    const router = { address: [192, 168, 1, 1] as [number, number, number, number], port: 1900 };

    it('binds before it streams, and sends where it is told', () => {
        const udp = fakeUdp();
        const socket = adapter(fakeTcp(), udp).openDatagram();

        socket.send(router, bytes('M-SEARCH'));
        expect(udp.sent).toEqual([{ text: 'M-SEARCH', to: '192.168.1.1' }]);
    });

    it('refuses to send when the stream may not, because WASI traps then', () => {
        const udp = fakeUdp();
        udp.allowSend(0);
        const socket = adapter(fakeTcp(), udp).openDatagram();

        expect(() => socket.send(router, bytes('M-SEARCH'))).toThrow('cannot send right now');
        expect(udp.sent).toEqual([]);
    });

    it('delivers every datagram in a received batch in order', () => {
        const udp = fakeUdp();
        udp.queue([datagram([192, 168, 1, 1], 1900, 'first'), datagram([10, 0, 0, 1], 1900, 'second')]);
        const socket = adapter(fakeTcp(), udp).openDatagram();

        expect(socket.receive()).toEqual({ from: router, data: bytes('first') });
        expect(socket.receive()).toEqual({ from: { address: [10, 0, 0, 1], port: 1900 }, data: bytes('second') });
        expect(socket.receive()).toBeUndefined();
    });

    it('skips an unsupported address family without losing the valid packet behind it', () => {
        const udp = fakeUdp();
        udp.queue([
            {
                data: bytes('ipv6'),
                remoteAddress: {
                    tag: 'ipv6',
                    val: { port: 1900, flowInfo: 0, scopeId: 0, address: [0, 0, 0, 0, 0, 0, 0, 1] }
                }
            },
            datagram([192, 168, 1, 1], 1900, 'valid')
        ]);
        const socket = adapter(fakeTcp(), udp).openDatagram();
        expect(socket.receive()).toEqual({ from: router, data: bytes('valid') });
        expect(socket.receive()).toBeUndefined();
    });

    it('delivers a valid SSDP response behind an unrelated packet to discovery', () => {
        const igd = new FakeIgd({ natPmp: false });
        const fake = new FakeNetwork([igd]);
        const udp = fakeUdp();
        udp.allowSend(100);
        const reply = igd.handleDatagram(
            { address: [239, 255, 255, 250], port: 1900 },
            bytes('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n')
        )[0];
        expect(reply).toBeDefined();
        udp.queue([
            datagram([192, 168, 1, 1], 1900, 'unrelated'),
            {
                data: reply ?? new Uint8Array(),
                remoteAddress: { tag: 'ipv4', val: { address: [192, 168, 1, 1], port: 1900 } }
            }
        ]);
        const socket = adapter(fakeTcp(), udp).openDatagram();
        fake.openDatagram = () => socket;
        const found = runSteps(fake, discover(fake, { upnp: true, natPmp: false }));
        expect(found.gateway.address).toEqual([192, 168, 1, 1]);
        expect(udp.disposed.incoming).toBe(1);
        expect(fake.leaks).toBe(0);
    });

    it('discards retained bytes on close and does not read disposed resources', () => {
        const udp = fakeUdp();
        udp.queue([datagram([192, 168, 1, 1], 1900, 'first'), datagram([192, 168, 1, 1], 1900, 'second')]);
        const socket = adapter(fakeTcp(), udp).openDatagram();
        expect(socket.receive()?.data).toEqual(bytes('first'));
        socket.close();
        expect(socket.receive()).toBeUndefined();
        expect(udp.incoming.receive).toHaveBeenCalledTimes(1);
        expect(udp.incoming.receive).toHaveBeenCalledWith(16n);
    });

    it('releases the streams and the socket, and can be closed twice', () => {
        const udp = fakeUdp();
        const socket = adapter(fakeTcp(), udp).openDatagram();
        socket.close();
        socket.close();

        expect(udp.disposed).toEqual({ socket: 1, incoming: 1, outgoing: 1 });
    });

    it('waits while the host says binding would block', () => {
        const udp = fakeUdp();
        udp.blockBind(3);
        expect(adapter(fakeTcp(), udp).openDatagram()).toBeDefined();
        expect(udp.disposed.socket).toBe(0);
    });

    it('gives up on binding that never settles, and releases the socket', () => {
        const udp = fakeUdp();
        udp.blockBind(1000);
        expect(() => adapter(fakeTcp(), udp).openDatagram()).toThrow('would-block');
        expect(udp.disposed.socket).toBe(1);
    });

    it('explains a bind it was not allowed to make, and releases the socket', () => {
        const udp = fakeUdp();
        udp.failBind('access-denied');
        expect(() => adapter(fakeTcp(), udp).openDatagram()).toThrow('network.* permissions');
        expect(udp.disposed.socket).toBe(1);
    });
});

describe('the local address', () => {
    it('asks the operating system by streaming a socket toward the internet', () => {
        const udp = fakeUdp([10, 0, 0, 7]);
        expect(adapter(fakeTcp(), udp).localAddress()).toEqual([10, 0, 0, 7]);
        expect(udp.disposed).toEqual({ socket: 1, incoming: 1, outgoing: 1 });
    });

    it('streams toward a given destination instead', () => {
        const udp = fakeUdp();
        adapter(fakeTcp(), udp).localAddress([192, 168, 1, 1]);
        expect(udp.sent).toEqual([]);
        expect(udp.disposed.socket).toBe(1);
    });

    it('offers nothing when the host cannot bind, and still releases the socket', () => {
        const udp = fakeUdp();
        udp.failBind('address-not-bindable');
        expect(adapter(fakeTcp(), udp).localAddress()).toBeUndefined();
        expect(udp.disposed.socket).toBe(1);
    });

    it('offers nothing when the socket was left unbound', () => {
        expect(adapter(fakeTcp(), fakeUdp([0, 0, 0, 0])).localAddress()).toBeUndefined();
    });
});

describe('a connection', () => {
    const router = { address: [192, 168, 1, 1] as [number, number, number, number], port: 80 };

    it('waits while the host is still connecting', () => {
        const tcp = fakeTcp();
        tcp.blockConnect(2);
        const dial = adapter(tcp).dial(router);

        expect(dial.poll()).toBeUndefined();
        expect(dial.poll()).toBeUndefined();
        expect(dial.poll()).toBeDefined();
    });

    it('reads, writes, and tells the address the router sees', () => {
        const tcp = fakeTcp([192, 168, 1, 50]);
        tcp.read(bytes('HTTP/1.1 200 OK'));
        const connection = adapter(tcp).dial(router).poll();

        expect(connection?.localAddress).toEqual([192, 168, 1, 50]);
        expect(text(connection?.read(64) as Uint8Array)).toBe('HTTP/1.1 200 OK');
        expect(connection?.writable()).toBe(1024);
        connection?.write(bytes('GET /'));
        expect(text(tcp.written as Uint8Array)).toBe('GET /');
    });

    it('turns a closed stream into a closed connection rather than an error', () => {
        const tcp = fakeTcp();
        tcp.readError('closed');
        const connection = adapter(tcp).dial(router).poll();

        expect(connection?.read(64)).toBe('closed');
    });

    it('lets other read errors through', () => {
        const tcp = fakeTcp();
        tcp.readError('network-unreachable');
        const connection = adapter(tcp).dial(router).poll();

        expect(() => connection?.read(64)).toThrow('network-unreachable');
    });

    it('releases the streams and the socket, and can be closed twice', () => {
        const tcp = fakeTcp();
        const connection = adapter(tcp).dial(router).poll();
        connection?.close();
        connection?.close();

        expect(tcp.disposed).toEqual({ socket: 1, input: 1, output: 1 });
    });

    it('releases the socket and explains itself when connecting is refused', () => {
        const tcp = fakeTcp();
        tcp.failConnect('connection-refused');
        expect(() => adapter(tcp).dial(router)).toThrow('the connection was refused');
        expect(tcp.disposed.socket).toBe(1);
    });

    it('names the missing permission in words an operator can act on', () => {
        const tcp = fakeTcp();
        tcp.failConnect('access-denied');
        expect(() => adapter(tcp).dial(router)).toThrow('network.* permissions');
    });

    it('releases the socket when a connection that started breaks', () => {
        const tcp = fakeTcp();
        tcp.failFinish('timeout');
        const dial = adapter(tcp).dial(router);

        expect(() => dial.poll()).toThrow('the connection timed out');
        expect(tcp.disposed.socket).toBe(1);
    });

    it('gives up on a dial that is aborted, without throwing', () => {
        const tcp = fakeTcp();
        tcp.blockConnect(5);
        const dial = adapter(tcp).dial(router);
        dial.abort();

        expect(dial.poll()).toBeUndefined();
        expect(tcp.disposed.socket).toBe(1);
    });
});
