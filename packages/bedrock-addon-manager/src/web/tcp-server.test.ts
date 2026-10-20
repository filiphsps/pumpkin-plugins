import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import { MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { strToU8 } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFile } from '../../test/transport.ts';
import type { PackLookup } from './session.ts';
import { TcpWebServer } from './tcp-server.ts';

const host = vi.hoisted(() => ({ create: vi.fn(), now: vi.fn(() => 0n) }));
vi.mock('wasi:clocks/monotonic-clock@0.2.3', () => ({ now: host.now }));
vi.mock('wasi:sockets/instance-network@0.2.3', () => ({ instanceNetwork: () => ({}) }));
vi.mock('wasi:sockets/tcp-create-socket@0.2.3', () => ({ createTcpSocket: host.create }));

let clients = 0;

/** A connection from its own address, or from `address` when given. */
function client(address: [number, number, number, number] = [10, 0, (clients >> 8) & 255, clients++ & 255]) {
    const inbound: Uint8Array[] = [];
    const written: number[] = [];
    const disposed = { socket: 0, input: 0, output: 0 };
    const socket = {
        shutdown: vi.fn(),
        remoteAddress: () => ({ tag: 'ipv4', val: { port: 50_000, address } }),
        [Symbol.dispose]: () => disposed.socket++,
    };
    const input = {
        read: vi.fn((max: bigint) => {
            const bytes = inbound.shift() ?? new Uint8Array();
            if (bytes.length > Number(max)) inbound.unshift(bytes.subarray(Number(max)));
            return bytes.subarray(0, Number(max));
        }),
        [Symbol.dispose]: () => disposed.input++,
    };
    const output = {
        checkWrite: vi.fn(() => 1n << 20n),
        write: vi.fn((bytes: Uint8Array) => written.push(bytes.length)),
        flush: vi.fn(),
        [Symbol.dispose]: () => disposed.output++,
    };
    return {
        socket,
        inbound,
        written,
        disposed,
        input,
        output,
        resources: [socket, input, output] as unknown as ReturnType<TcpSocket['accept']>,
    };
}

function setup(open: PackLookup = () => undefined, defaultClock = false) {
    const pending: ReturnType<TcpSocket['accept']>[] = [];
    const listener = {
        startBind: vi.fn(),
        finishBind: vi.fn(),
        setListenBacklogSize: vi.fn(),
        startListen: vi.fn(),
        finishListen: vi.fn(),
        accept: vi.fn(() => {
            const next = pending.shift();
            if (!next) throw { payload: 'would-block' };
            return next;
        }),
        [Symbol.dispose]: vi.fn(),
    };
    host.create.mockReturnValue(listener);
    const clock = { now: 0 };
    const lookup = vi.fn(open);
    const server = new TcpWebServer(lookup, new MemoryLogger(), defaultClock ? undefined : () => clock.now);
    server.start({ bind: '127.0.0.1', port: 8123 });
    return { server, clock, pending, listener, lookup };
}

beforeEach(() => {
    host.create.mockReset();
    host.now.mockReset().mockReturnValue(0n);
});

function metrics(t: ReturnType<typeof setup>, clients: ReturnType<typeof client>[], files: FakeFile[] = []) {
    return {
        bytes: clients.reduce(
            (n, c) =>
                n +
                c.written.reduce((a, b) => a + b, 0) +
                c.input.read.mock.results.reduce((a, r) => a + (r.type === 'return' ? r.value.length : 0), 0),
            0,
        ),
        operations:
            t.listener.accept.mock.calls.length +
            t.lookup.mock.calls.length * 2 +
            files.reduce((n, f) => n + f.reads.length, 0) +
            clients.reduce(
                (n, c) =>
                    n +
                    c.input.read.mock.calls.length +
                    c.output.checkWrite.mock.calls.length +
                    c.output.write.mock.calls.length +
                    c.output.flush.mock.calls.length +
                    c.socket.shutdown.mock.calls.length,
                0,
            ),
    };
}

function admit(t: ReturnType<typeof setup>, clients: ReturnType<typeof client>[]) {
    t.pending.push(...clients.map((c) => c.resources));
    for (let i = 0; i < Math.ceil(clients.length / 8); i++) t.server.tick();
    t.listener.accept.mockClear();
    for (const c of clients) c.input.read.mockClear();
}

describe('TcpWebServer', () => {
    it('uses monotonic time for default deadlines when the wall clock moves backwards', () => {
        const wallClock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
        const t = setup(undefined, true);
        const c = client();
        try {
            t.pending.push(c.resources);
            t.server.tick();
            host.now.mockReturnValue(15_000_000_000n);
            wallClock.mockReturnValue(50_000);
            t.server.tick();
            expect(c.disposed).toEqual({ socket: 1, input: 1, output: 1 });
        } finally {
            t.server.stop();
            wallClock.mockRestore();
        }
    });

    it.each([1, 16, 64])('caps aggregate HTTP bytes and I/O with %s active downloads', (count) => {
        const files: FakeFile[] = [];
        const data = new Uint8Array(2 << 20);
        const t = setup(() => {
            const file = new FakeFile(data);
            files.push(file);
            return file;
        });
        const clients = Array.from({ length: count }, () => client());
        admit(t, clients);
        for (const c of clients) c.inbound.push(strToU8('GET /packs/a.mcpack HTTP/1.1\r\n\r\n'));
        t.server.tick();
        const work = metrics(t, clients, files);
        expect.soft(work.bytes).toBeLessThanOrEqual(1 << 20);
        expect.soft(work.operations).toBeLessThanOrEqual(64);
        t.server.stop();
        expect(files.every((f) => f.closed === 1)).toBe(true);
    });

    it('bounds one-byte writable loops with the shared operation quota', () => {
        const t = setup();
        const c = client();
        c.output.checkWrite.mockReturnValue(1n);
        admit(t, [c]);
        c.inbound.push(strToU8('GET /packs/missing.mcpack HTTP/1.1\r\n\r\n'));
        t.server.tick();
        const work = metrics(t, [c]);
        expect(work.operations).toBeLessThanOrEqual(64);
        t.server.stop();
    });

    it('rotates fairly among slow and fast clients while respecting both quotas until completion', () => {
        const files: FakeFile[] = [];
        const data = new Uint8Array(2 << 20);
        const t = setup(() => {
            const file = new FakeFile(data);
            files.push(file);
            return file;
        });
        const clients = Array.from({ length: 64 }, () => client());
        clients[0].output.checkWrite.mockReturnValue(0n);
        admit(t, clients);
        for (const c of clients) c.inbound.push(strToU8('GET /packs/a.mcpack HTTP/1.1\r\n\r\n'));
        for (let tick = 0; tick < 500; tick++) {
            const before = metrics(t, clients, files);
            t.server.tick();
            const after = metrics(t, clients, files);
            expect(after.bytes - before.bytes).toBeLessThanOrEqual(1 << 20);
            expect(after.operations - before.operations).toBeLessThanOrEqual(64);
            if (tick === 63) expect(clients.slice(1).every((c) => c.written.length > 0)).toBe(true);
            t.clock.now += 10;
            if (clients.slice(1).every((c) => c.disposed.socket === 1)) break;
        }
        expect(clients.slice(1).every((c) => c.disposed.socket === 1)).toBe(true);
        expect(files.filter((f) => f.closed === 1)).toHaveLength(63);
        expect(clients[0].disposed.socket).toBe(0);
        t.clock.now += 15_001;
        t.server.tick();
        expect(files.every((f) => f.closed === 1)).toBe(true);
        expect(clients[0].disposed.socket).toBe(1);
        t.server.stop();
    });

    it('releases trickled head slots at the absolute deadline and admits a replacement client', () => {
        const t = setup();
        const clients = Array.from({ length: 64 }, () => client());
        t.pending.push(...clients.map((c) => c.resources));
        for (let i = 0; i < 8; i++) t.server.tick();
        t.clock.now = 14_000;
        for (const c of clients) c.inbound.push(strToU8('G'));
        t.server.tick();
        const replacement = client();
        t.pending.push(replacement.resources);
        t.clock.now = 15_000;
        t.server.tick();
        t.server.tick();
        expect(t.pending).toEqual([]);
        expect(clients.every((c) => c.disposed.socket === 1 && c.disposed.input === 1 && c.disposed.output === 1)).toBe(
            true,
        );
        expect(t.lookup).not.toHaveBeenCalled();
        expect(replacement.disposed.socket).toBe(0);
        t.server.stop();
        expect(replacement.disposed).toEqual({ socket: 1, input: 1, output: 1 });
    });

    it('limits how many downloads one address can hold at once', () => {
        const t = setup();
        const same = Array.from({ length: 9 }, () => client([203, 0, 113, 7]));
        const other = client([203, 0, 113, 8]);
        t.pending.push(...same.map((c) => c.resources), other.resources);
        t.server.tick();
        t.server.tick();
        expect(same.slice(0, 8).every((c) => c.disposed.socket === 0)).toBe(true);
        expect(same[8]?.disposed).toEqual({ socket: 1, input: 1, output: 1 });
        expect(other.disposed.socket).toBe(0);

        same[0]?.inbound.push(strToU8('GET /packs/missing.mcpack HTTP/1.1\r\n\r\n'));
        for (let i = 0; i < 5; i++) t.server.tick();
        expect(same[0]?.disposed.socket).toBe(1);
        const next = client([203, 0, 113, 7]);
        t.pending.push(next.resources);
        t.server.tick();
        expect(next.disposed.socket).toBe(0);
        t.server.stop();
    });

    it('does not limit loopback, where a reverse proxy on this machine connects from', () => {
        const t = setup();
        const proxied = Array.from({ length: 12 }, () => client([127, 0, 0, 1]));
        t.pending.push(...proxied.map((c) => c.resources));
        t.server.tick();
        t.server.tick();
        expect(proxied.every((c) => c.disposed.socket === 0)).toBe(true);
        t.server.stop();
    });
});
