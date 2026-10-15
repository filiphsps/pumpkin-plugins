import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { FakeClock, FakeTransport } from '@pumpkin-plugins/pumpkin-pie-api/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@pumpkin-plugins/plugin-kit/ipc', () => ({ ipcSend: vi.fn() }));
vi.mock('pumpkin:plugin/uuid@0.1.0', () => ({ toString: (id: string) => id }));

import { decodeJson, encodeRequest } from '@pumpkin-plugins/pumpkin-pie-api';
import { WaypointCatalog } from '../waypoints/catalog.ts';
import { WaypointStore } from '../waypoints/store.ts';
import { waypointPlaceholderNames } from './definitions.ts';
import type { WaypointCatalogReader } from './resolver.ts';
import { WaypointPlaceholderService } from './service.ts';

const waypointId = '11111111-1111-4111-8111-111111111111';
const viewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup() {
    const catalog = new WaypointCatalog(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
    catalog.create({
        id: waypointId,
        name: 'Home',
        dimension: 'world',
        position: { x: 0, y: 64, z: 0 },
        access: { mode: 'public', grants: [] },
    });
    const player = {
        getId: () => viewerId,
        getName: () => 'Alex',
        getWorld: () => ({ getName: () => 'world' }),
        getPosition: () => [0, 64, 0],
        getYaw: () => 0,
        hasPermission: () => false,
    };
    const server = {
        getPlayerByName: (name: string) => (name === 'Alex' ? player : undefined),
        getOpManager: () => ({ isOp: () => false }),
    } as unknown as Server;
    return { catalog, server };
}

function request(name: string, viewer?: string, argument?: string): Uint8Array {
    return encodeRequest({
        op: 'on_request',
        namespace: 'waypoints',
        id: `waypoints_${name}`,
        name,
        ...(viewer === undefined ? {} : { viewer }),
        ...(argument === undefined ? {} : { argument }),
    });
}

function reply(service: WaypointPlaceholderService, name: string, viewer?: string, argument?: string) {
    return decodeJson(service.handleIpcMessage('PumpkinPIE', request(name, viewer, argument)));
}

describe('waypoint placeholder service', () => {
    it('routes authenticated callbacks through a never-cache namespace and declines missing viewers', () => {
        const { catalog, server } = setup();
        const service = new WaypointPlaceholderService(server, catalog, { now: () => 0, send: () => new Uint8Array() });

        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: { value: '1' } });
        expect(reply(service, 'count')).toEqual({ ok: true, on_request: {} });
        expect(reply(service, 'count', 'Not online')).toEqual({ ok: true, on_request: {} });
        expect(decodeJson(service.handleIpcMessage('UntrustedPlugin', request('count', 'Alex')))).toEqual({
            ok: false,
            error: 'Expansion callback refused',
        });
    });

    it('reads current ACLs for every callback instead of retaining resolved values', () => {
        const { catalog, server } = setup();
        const service = new WaypointPlaceholderService(server, catalog, { now: () => 0, send: () => new Uint8Array() });

        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: { value: '1' } });
        catalog.update('Home', {
            access: { mode: 'restricted', grants: [{ type: 'player', playerId: viewerId }] },
        });
        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: { value: '1' } });
        catalog.update('Home', {
            access: { mode: 'restricted', grants: [{ type: 'player', playerId: waypointId }] },
        });
        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: { value: '0' } });
        expect(reply(service, 'closest_name', 'Alex')).toEqual({ ok: true, on_request: { value: '' } });
    });

    it('logs only one bounded diagnostic per consecutive query-failure transition', () => {
        const { server } = setup();
        let fail = true;
        const catalog: WaypointCatalogReader = {
            get isAvailable() {
                return true;
            },
            getById() {
                if (fail) throw new Error('stored private waypoint text');
                return undefined;
            },
            list() {
                if (fail) throw new Error('stored private waypoint text');
                return [];
            },
        };
        const onFailure = vi.fn();
        const service = new WaypointPlaceholderService(server, catalog, {
            now: () => 0,
            send: () => new Uint8Array(),
            onFailure,
        });

        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: {} });
        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: {} });
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledWith('count', 'query_failed');

        fail = false;
        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: { value: '0' } });
        fail = true;
        expect(reply(service, 'count', 'Alex')).toEqual({ ok: true, on_request: {} });
        expect(onFailure).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(onFailure.mock.calls)).not.toContain('stored private waypoint text');
    });

    it('negotiates recovery and stops without sending unregister during host shutdown', () => {
        const { catalog, server } = setup();
        const clock = new FakeClock();
        const transport = new FakeTransport();
        const transitions: string[] = [];
        const service = new WaypointPlaceholderService(server, catalog, {
            now: clock.now,
            send: transport.send,
            onTransition: (state) => transitions.push(state.kind),
        });

        transport.enqueue(new Error('provider absent'));
        service.tick();
        clock.advance(1000);
        transport.enqueue({
            ok: true,
            ping: { protocol: 0, name: 'PumpkinPIE', version: '0.2.3', placeholders: 1, expansions: 0 },
        });
        transport.enqueue({
            ok: true,
            registered_expansion: {
                namespace: 'waypoints',
                placeholders: waypointPlaceholderNames,
                cache: { kind: 'never' },
            },
        });
        service.tick();

        expect(transitions).toEqual(['ready']);
        expect(transport.messages.map(({ request: sent }) => sent)).toEqual([
            { op: 'ping' },
            { op: 'ping' },
            {
                op: 'register_expansion',
                namespace: 'waypoints',
                placeholders: waypointPlaceholderNames,
                cache: { kind: 'never' },
            },
        ]);

        service.stop();
        service.stop();
        expect(transport.messages).toHaveLength(3);
        expect(transitions).toEqual(['ready', 'unavailable']);
    });

    it('returns to unavailable if the provider rejects the namespace registration', () => {
        const { catalog, server } = setup();
        const clock = new FakeClock();
        const transport = new FakeTransport();
        const transitions: string[] = [];
        const service = new WaypointPlaceholderService(server, catalog, {
            now: clock.now,
            send: transport.send,
            onTransition: (state) => transitions.push(state.kind),
        });

        transport.enqueue({
            ok: true,
            ping: { protocol: 0, name: 'PumpkinPIE', version: '0.2.3', placeholders: 1, expansions: 0 },
        });
        transport.enqueue({
            ok: true,
            registered_expansion: {
                namespace: 'waypoints',
                placeholders: waypointPlaceholderNames,
                cache: { kind: 'never' },
            },
        });
        service.tick();
        clock.advance(30_000);
        transport.enqueue({
            ok: true,
            ping: { protocol: 0, name: 'PumpkinPIE', version: '0.2.3', placeholders: 1, expansions: 0 },
        });
        transport.enqueue({ ok: false, error: 'namespace already owned' });
        service.tick();

        expect(transitions).toEqual(['ready', 'unavailable']);
        expect(transport.messages.map(({ request: sent }) => sent)).toEqual([
            { op: 'ping' },
            {
                op: 'register_expansion',
                namespace: 'waypoints',
                placeholders: waypointPlaceholderNames,
                cache: { kind: 'never' },
            },
            { op: 'ping' },
            {
                op: 'register_expansion',
                namespace: 'waypoints',
                placeholders: waypointPlaceholderNames,
                cache: { kind: 'never' },
            },
        ]);
        service.stop();
    });
});
