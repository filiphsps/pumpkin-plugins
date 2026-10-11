import type { TcpSocket } from 'wasi:sockets/tcp@0.2.3';
import { MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { strToU8 } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TcpWebServer } from './tcp-server.ts';

const host = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('wasi:sockets/instance-network@0.2.3', () => ({ instanceNetwork: () => ({}) }));
vi.mock('wasi:sockets/tcp-create-socket@0.2.3', () => ({ createTcpSocket: host.create }));

function client() {
    const inbound: Uint8Array[] = [];
    const written: number[] = [];
    const disposed = { socket: 0, input: 0, output: 0 };
    const socket = { shutdown: vi.fn(), [Symbol.dispose]: () => disposed.socket++ };
    const input = {
        read: vi.fn(() => inbound.shift() ?? new Uint8Array()),
        [Symbol.dispose]: () => disposed.input++
    };
    const output = {
        checkWrite: vi.fn(() => 1n << 20n),
        write: vi.fn((bytes: Uint8Array) => written.push(bytes.length)),
        flush: vi.fn(),
        [Symbol.dispose]: () => disposed.output++
    };
    return {
        inbound,
        written,
        disposed,
        input,
        output,
        resources: [socket, input, output] as unknown as ReturnType<TcpSocket['accept']>
    };
}

function setup() {
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
        [Symbol.dispose]: vi.fn()
    };
    host.create.mockReturnValue(listener);
    const clock = { now: 0 };
    const lookup = vi.fn(() => undefined);
    const server = new TcpWebServer(lookup, new MemoryLogger(), () => clock.now);
    server.start({ bind: '127.0.0.1', port: 8123 });
    return { server, clock, pending, listener, lookup };
}

beforeEach(() => host.create.mockReset());

describe('TcpWebServer', () => {
    it('releases trickled head slots at the absolute deadline and admits a replacement client', () => {
        const t = setup();
        const clients = Array.from({ length: 64 }, client);
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
            true
        );
        expect(t.lookup).not.toHaveBeenCalled();
        expect(replacement.disposed.socket).toBe(0);
        t.server.stop();
        expect(replacement.disposed).toEqual({ socket: 1, input: 1, output: 1 });
    });
});
