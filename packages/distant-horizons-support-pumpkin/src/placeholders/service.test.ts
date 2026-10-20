import { describe, expect, it, vi } from 'vitest';
import type { LodCacheStats } from '../lod/cache.ts';
import type { SessionPlaceholderSnapshot } from '../session.ts';
import { dhsPlaceholderDefinitions, dhsPlaceholderNames } from './definitions.ts';
import { DistantHorizonsPlaceholderService } from './service.ts';

vi.mock('@pumpkin-plugins/plugin-kit/ipc', () => ({ ipcSend: vi.fn() }));

const expectedNames = [
    'client_connected',
    'clients',
    'pending_requests',
    'worker_ticks',
    'served',
    'rejected',
    'cancelled',
    'packet_bytes_sent',
    'cache_refreshes',
    'memory_entries',
    'memory_bytes',
    'memory_limit',
    'memory_byte_limit',
    'disk_entries',
    'disk_bytes',
    'disk_limit',
];

function encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}

function decode(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function callback(name: string, viewer?: string, argument?: string): Uint8Array {
    return encode({
        op: 'on_request',
        namespace: 'dhs',
        id: `dhs_${name}`,
        name,
        ...(viewer === undefined ? {} : { viewer }),
        ...(argument === undefined ? {} : { argument }),
    });
}

function setup() {
    let now = 0;
    let providerAvailable = true;
    let cacheReads = 0;
    const messages: Record<string, unknown>[] = [];
    const transitions: string[] = [];
    const activeClients = new Set(['Alex']);
    const snapshot: SessionPlaceholderSnapshot = {
        clients: 2,
        pendingRequests: 3,
        workerTicks: 4,
        served: 5,
        rejected: 6,
        cancelled: 0,
        packetBytesSent: 8192,
        cacheRefreshes: 0,
    };
    const stats: LodCacheStats = {
        memoryEntries: 10,
        memoryBytes: 2048,
        memoryLimit: -1,
        memoryByteLimit: 67_108_864,
        diskEntries: 11,
        diskBytes: 4096,
        diskLimit: 0,
    };
    const service = new DistantHorizonsPlaceholderService({
        sessions: {
            placeholderSnapshot: () => snapshot,
            hasClient: (name) => activeClients.has(name),
        },
        cache: {
            stats: () => {
                cacheReads++;
                return stats;
            },
        },
        now: () => now,
        send: (_recipient, bytes) => {
            const request = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
            messages.push(request);
            if (!providerAvailable) throw new Error('provider unavailable');
            if (request.op === 'ping')
                return encode({
                    ok: true,
                    ping: {
                        protocol: 0,
                        name: 'PumpkinPIE',
                        version: '0.2.3',
                        placeholders: 15,
                        expansions: 0,
                    },
                });
            if (request.op === 'register_expansion')
                return encode({
                    ok: true,
                    registered_expansion: {
                        namespace: request.namespace,
                        placeholders: request.placeholders,
                        cache: { kind: 'never' },
                    },
                });
            throw new Error(`Unexpected PumpkinPIE operation: ${String(request.op)}`);
        },
        onTransition: (state) => transitions.push(state.kind),
    });
    return {
        service,
        messages,
        transitions,
        cacheReads: () => cacheReads,
        playerLeft: (name: string) => activeClients.delete(name),
        time: (value: number) => {
            now = value;
        },
        providerAvailable: (value: boolean) => {
            providerAvailable = value;
        },
    };
}

function reply(f: ReturnType<typeof setup>, name: string, viewer?: string, argument?: string, sender = 'PumpkinPIE') {
    return decode(f.service.handleIpcMessage(sender, callback(name, viewer, argument)));
}

describe('Distant Horizons PumpkinPIE placeholders', () => {
    it('derives exactly the documented names from descriptions', () => {
        expect(dhsPlaceholderDefinitions.map(({ name }) => name)).toEqual(expectedNames);
        expect(dhsPlaceholderNames).toEqual(expectedNames);
        expect(dhsPlaceholderDefinitions.every(({ description }) => description.length > 0)).toBe(true);
    });

    it('resolves scalar values as decimal strings and reads cache stats only on cache requests', () => {
        const f = setup();
        f.service.tick();

        expect(f.messages).toHaveLength(2);
        expect(f.messages[1]).toMatchObject({
            op: 'register_expansion',
            namespace: 'dhs',
            placeholders: expectedNames,
            cache: { kind: 'never' },
        });
        expect(f.cacheReads()).toBe(0);

        const values = {
            clients: '2',
            pending_requests: '3',
            worker_ticks: '4',
            served: '5',
            rejected: '6',
            cancelled: '0',
            packet_bytes_sent: '8192',
            cache_refreshes: '0',
            memory_entries: '10',
            memory_bytes: '2048',
            memory_limit: '-1',
            memory_byte_limit: '67108864',
            disk_entries: '11',
            disk_bytes: '4096',
            disk_limit: '0',
        };
        for (const [name, value] of Object.entries(values)) {
            expect(reply(f, name)).toEqual({ ok: true, on_request: { value } });
        }
        expect(f.cacheReads()).toBe(7);
        expect(reply(f, 'client_connected')).toEqual({ ok: true, on_request: {} });
        expect(reply(f, 'client_connected', 'Alex')).toEqual({ ok: true, on_request: { value: 'true' } });
        expect(reply(f, 'client_connected', 'alex')).toEqual({ ok: true, on_request: { value: 'false' } });
        expect(f.cacheReads()).toBe(7);
    });

    it('declines unexpected arguments and unknown names without reading cache stats', () => {
        const f = setup();
        f.service.tick();

        for (const name of expectedNames) {
            expect(reply(f, name, 'Alex', '')).toEqual({ ok: true, on_request: {} });
        }
        expect(reply(f, 'unknown')).toEqual({ ok: true, on_request: {} });
        expect(reply(f, 'clients', undefined, undefined, 'UntrustedPlugin')).toEqual({
            ok: false,
            error: 'Expansion callback refused',
        });
        expect(f.cacheReads()).toBe(0);
    });

    it('uses the current client map and reports only session transitions while recovering', () => {
        const f = setup();
        f.providerAvailable(false);
        f.service.tick();
        f.service.tick();
        expect(f.messages).toEqual([{ op: 'ping' }]);
        expect(f.transitions).toEqual([]);

        f.playerLeft('Alex');
        expect(reply(f, 'client_connected', 'Alex')).toEqual({ ok: true, on_request: { value: 'false' } });

        f.time(999);
        f.service.tick();
        expect(f.messages).toHaveLength(1);
        f.providerAvailable(true);
        f.time(1000);
        f.service.tick();
        expect(f.transitions).toEqual(['ready']);
        f.time(31000);
        f.service.tick();
        expect(f.transitions).toEqual(['ready']);

        f.providerAvailable(false);
        f.time(61000);
        f.service.tick();
        f.time(62000);
        f.service.tick();
        expect(f.transitions).toEqual(['ready', 'unavailable']);
        f.service.stop();
    });
});
