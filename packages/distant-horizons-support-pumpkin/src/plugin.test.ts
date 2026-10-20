import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL, encodeSection, packet } from './protocol/messages.ts';

// Only the host is fake here: Pumpkin's lifecycle base, WIT imports, the data folder and command
// registration. Sessions, the cache, settings and the PumpkinPIE service are the real modules.

interface LoadedPlugin {
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

type Handler = (server: Server, event?: unknown) => void;

const host = vi.hoisted(() => ({
    plugin: undefined as LoadedPlugin | undefined,
    events: new Map<string, Handler>(),
    commands: undefined as Record<string, (...args: never[]) => string[]> | undefined,
    files: undefined as (MemoryFiles & Disposable) | undefined,
    filesReleased: false,
    logs: [] as { level: string; message: string }[],
    clockNs: 1_000_000_000n,
    ipcReply: undefined as Uint8Array | undefined,
    transitionLogFails: false,
    commandRegistrationFails: false,
}));

vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {
        registerEvent(_ctx: Context, name: string, handler: Handler): void {
            host.events.set(name, handler);
        }
        handleIpcMessage(): Uint8Array {
            return new Uint8Array();
        }
    },
    registerPlugin: (plugin: LoadedPlugin) => {
        host.plugin = plugin;
    },
    handleCommand: vi.fn(),
    handleTask: vi.fn(),
}));
vi.mock('@pumpkin-plugins/pumpkin-api', () => ({}));
vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: () => host.files } }));
vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({
    registerCommands: (_ctx: Context, _tree: unknown, handlers: typeof host.commands) => {
        if (host.commandRegistrationFails) throw new Error('command registration failed');
        host.commands = handlers;
    },
}));
vi.mock('pumpkin:plugin/logging@0.1.0', () => ({
    log: (level: string, message: string) => {
        if (host.transitionLogFails && message.includes('PumpkinPIE provider is')) throw new Error('log unavailable');
        host.logs.push({ level, message });
    },
}));
vi.mock('pumpkin:plugin/scheduler@0.1.0', () => ({}));
vi.mock('pumpkin:plugin/text@0.1.0', () => ({ TextComponent: class {} }));
vi.mock('pumpkin:plugin/world@0.1.0', () => ({
    blockStateToInfo: () => ({ name: 'minecraft:stone', properties: [] }),
}));
// PumpkinPIE is not installed until a test sets the provider's reply.
vi.mock('pumpkin:plugin/ipc@0.1.0', () => ({
    sendIpcMessage: () =>
        host.ipcReply ? { tag: 'ok', val: host.ipcReply } : { tag: 'err', val: 'plugin not loaded' },
}));
vi.mock('wasi:clocks/monotonic-clock@0.2.3', () => ({ now: () => host.clockNs }));

const context = {} as Context;
const server = { getMspt: () => 10, getPlayerByName: () => undefined } as unknown as Server;

function loadedPlugin(): LoadedPlugin {
    if (!host.plugin) throw new Error('Plugin was not registered');
    return host.plugin;
}

function workerTicks(): number {
    const status = host.commands?.['dhs status']?.().join('\n').replaceAll(/§./g, '');
    const ticks = status?.match(/(\d+) worker tick/)?.[1];
    if (ticks === undefined) throw new Error(`No worker tick count in status: ${status}`);
    return Number(ticks);
}

function tickEnd(tickServer = server): void {
    const handler = host.events.get('server-tick-end-event');
    if (!handler) throw new Error('Tick-end handler was not registered');
    handler(tickServer);
}

/** Java players in one loaded overworld, counting server lookups and the host handles still open. */
function javaPlayers(names: readonly string[]) {
    const lookups = new Map<string, number>();
    let open = 0;
    const handle = <T extends object>(value: T): T => {
        open++;
        return Object.assign(value, { [Symbol.dispose]: () => open-- });
    };
    const player = (name: string) =>
        handle({
            getName: () => name,
            getPosition: () => [0, 64, 0],
            asJava: () => handle({ sendCustomPayload: () => {} }),
            getWorld: () =>
                handle({
                    getName: () => 'world',
                    getDimension: () => 'minecraft:overworld',
                    getMinY: () => 0,
                    getWorldBorder: () =>
                        handle({ getCenterX: () => 0, getCenterZ: () => 0, getSize: () => 60_000_000 }),
                    getChunk: () => handle({}),
                    getBlockStateId: () => 1,
                    getBiome: () => 'plains',
                    getTopBlockY: () => 0,
                    getSkyLight: () => 15,
                    getBlockLight: () => 0,
                }),
        });
    const server = {
        getMspt: () => 10,
        getPlayerByName: (name: string) => {
            lookups.set(name, (lookups.get(name) ?? 0) + 1);
            return names.includes(name) ? player(name) : undefined;
        },
    } as unknown as Server;
    const send = (name: string, data: Uint8Array) => {
        const handler = host.events.get('player-custom-payload-event');
        if (!handler) throw new Error('Custom payload handler was not registered');
        handler(server, { channel: CHANNEL, player: player(name), data });
    };
    const reset = () => {
        lookups.clear();
        open = 0;
    };
    return { server, lookups, send, reset, open: () => open };
}

function lodRequest(tracker: number, x: number, z: number): Uint8Array {
    const section = encodeSection(x, z);
    return packet(7).int(tracker).string('world').words(section.high, section.low).bool(false).finish();
}

describe('DistantHorizonsSupportPumpkin lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        host.plugin = undefined;
        host.events.clear();
        host.commands = undefined;
        host.logs.length = 0;
        host.clockNs = 1_000_000_000n;
        host.ipcReply = undefined;
        host.transitionLogFails = false;
        host.commandRegistrationFails = false;
        host.filesReleased = false;
        host.files = Object.assign(new MemoryFiles(), {
            [Symbol.dispose]: () => {
                host.filesReleased = true;
            },
        });
        await import('./plugin.ts');
    });

    it('keeps processing DH ticks when the PumpkinPIE tick fails', () => {
        const plugin = loadedPlugin();
        plugin.onPluginLoad(context);
        tickEnd();
        expect(workerTicks()).toBe(1);

        // A provider with another protocol answers the next retry, and logging that change throws
        // inside the PumpkinPIE tick. DH sessions use the same clock, so it has to keep working.
        host.ipcReply = new TextEncoder().encode(
            JSON.stringify({
                ok: true,
                ping: { protocol: 1, name: 'PumpkinPIE', version: '9.0.0', placeholders: 0, expansions: 0 },
            }),
        );
        host.transitionLogFails = true;
        host.clockNs += 2_000_000_000n;
        expect(() => tickEnd()).not.toThrow();
        expect(() => tickEnd()).not.toThrow();

        expect(workerTicks()).toBe(3);
        expect(host.logs).toContainEqual({
            level: 'warn',
            message: expect.stringContaining('PumpkinPIE session tick failed: Error: log unavailable'),
        });
        plugin.onPluginUnload(context);
        expect(host.filesReleased).toBe(true);
    });

    it('looks up each DH player once per server tick and releases the handles when it ends', () => {
        const plugin = loadedPlugin();
        plugin.onPluginLoad(context);
        const players = javaPlayers(['Alice', 'Bob', 'Carol']);
        const init = packet(3).string('minecraft:overworld').finish();
        for (const name of ['Alice', 'Bob', 'Carol']) players.send(name, init);
        players.send('Alice', lodRequest(1, 0, 0));
        players.send('Alice', lodRequest(2, 1, 0));
        players.send('Bob', lodRequest(3, 0, 1));
        players.reset();

        tickEnd(players.server);

        expect(Object.fromEntries(players.lookups)).toEqual({ Alice: 1, Bob: 1, Carol: 1 });
        expect(players.open()).toBe(0);
        plugin.onPluginUnload(context);
    });

    it('releases its data folder when loading fails', () => {
        const plugin = loadedPlugin();
        host.commandRegistrationFails = true;

        expect(() => plugin.onPluginLoad(context)).toThrow('command registration failed');
        expect(host.filesReleased).toBe(true);
    });
});
