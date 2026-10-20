import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaypointCommandRuntime } from './commands/handlers.ts';

interface LoadedPlugin {
    handleIpcMessage(sender: string, message: Uint8Array): Uint8Array;
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

const state = vi.hoisted(() => ({
    plugin: undefined as LoadedPlugin | undefined,
    files: undefined as MemoryFiles | undefined,
    commandRuntime: undefined as WaypointCommandRuntime | undefined,
    events: new Map<string, (server: Server, event: unknown) => void>(),
    tasks: new Map<number, (server: Server) => void>(),
    nextTask: 0,
    placeholderService: undefined as
        | { handleIpcMessage(sender: string, message: Uint8Array): Uint8Array; stop(): void; tick(): void }
        | undefined,
    placeholderTicks: 0,
    placeholderStops: 0,
    hudTicks: 0,
    hudUnloads: 0,
    failPlaceholderTick: false,
    failHudTick: false,
    routedMessage: undefined as Uint8Array | undefined,
}));

vi.mock('pumpkin:plugin/item-stack@0.1.0', () => ({ ItemStack: class {} }));
vi.mock('pumpkin:plugin/text@0.1.0', () => ({
    TextComponent: class {
        static fromJson() {
            return new this();
        }

        encode() {
            return new Uint8Array();
        }
    },
}));
vi.mock('pumpkin:plugin/uuid@0.1.0', () => ({
    generate: () => ({ high: 3n, low: 4n }),
    parse: () => ({ high: 1n, low: 2n }),
    toString: () => '11111111-1111-4111-8111-111111111111',
}));
vi.mock('wasi:clocks/monotonic-clock@0.2.3', () => ({ now: () => 0n }));
vi.mock('@pumpkin-plugins/pumpkin-api', () => ({ handleCommand: vi.fn() }));
vi.mock('./placeholders/service.ts', () => ({
    WaypointPlaceholderService: class {
        constructor() {
            state.placeholderService = this;
        }
        tick(): void {
            state.placeholderTicks++;
            if (state.failPlaceholderTick) throw new Error('provider unavailable');
        }
        stop(): void {
            state.placeholderStops++;
        }
        handleIpcMessage(_sender: string, message: Uint8Array): Uint8Array {
            state.routedMessage = message;
            return message;
        }
    },
}));
vi.mock('./rendering/pumpkin-hud.ts', () => ({
    WaypointHudService: class {
        tick(): void {
            state.hudTicks++;
            if (state.failHudTick) throw new Error('hud failed');
        }
        joined(): void {}
        changedWorld(): void {}
        left(): void {}
        unload(): void {
            state.hudUnloads++;
        }
    },
}));
vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {
        registerEvent(_ctx: Context, name: string, run: (server: Server, event: unknown) => void): void {
            state.events.set(name, run);
        }
        registerCommandSuggestionHandler(): number {
            return 0;
        }
    },
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
    handleTask: vi.fn(),
}));
vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: () => state.files } }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({
    hostLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    scheduleRepeating: (_period: number, run: (server: Server) => void) => {
        const id = ++state.nextTask;
        state.tasks.set(id, run);
        return id;
    },
    cancelTask: (id: number) => state.tasks.delete(id),
}));
vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({ registerCommands: vi.fn() }));
vi.mock('./commands/handlers.ts', () => ({
    commandHandlers: (runtime: WaypointCommandRuntime) => {
        state.commandRuntime = runtime;
        return {};
    },
    resetPropertySuggestions: vi.fn(),
    waypointNameSuggestions: vi.fn(() => vi.fn()),
    onlinePlayerNameSuggestions: vi.fn(() => vi.fn()),
}));

await import('./plugin.ts');

describe('Waypoints plugin lifecycle', () => {
    beforeEach(() => {
        state.events.clear();
        state.tasks.clear();
        state.nextTask = 0;
        state.placeholderService = undefined;
        state.placeholderTicks = 0;
        state.placeholderStops = 0;
        state.hudTicks = 0;
        state.hudUnloads = 0;
        state.failPlaceholderTick = false;
        state.failHudTick = false;
        state.routedMessage = undefined;
        state.commandRuntime = undefined;
        state.files = new MemoryFiles();
    });

    it('schedules both services and stops them on unload', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const opManager = { isOp: () => false, [Symbol.dispose]: vi.fn() };
        const server = {
            getAllPlayers: () => [],
            getOpManager: () => opManager,
        } as unknown as Server;
        const context = { getServer: () => server } as Context;

        plugin.onPluginLoad(context);

        expect(state.tasks.size).toBe(1);
        state.tasks.get(1)?.(server);
        expect(state.placeholderTicks).toBe(1);
        expect(state.hudTicks).toBe(1);
        expect(() => plugin.onPluginUnload(context)).not.toThrow();
        expect(state.tasks.size).toBe(0);
        expect(state.placeholderStops).toBe(1);
        expect(state.hudUnloads).toBe(1);
    });

    it('keeps the other scheduled service running when either tick fails', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const server = { getAllPlayers: () => [] } as unknown as Server;
        const context = { getServer: () => server } as Context;
        plugin.onPluginLoad(context);

        state.failPlaceholderTick = true;
        state.tasks.get(1)?.(server);
        expect(state.placeholderTicks).toBe(1);
        expect(state.hudTicks).toBe(1);

        state.failPlaceholderTick = false;
        state.failHudTick = true;
        state.tasks.get(1)?.(server);
        expect(state.placeholderTicks).toBe(2);
        expect(state.hudTicks).toBe(2);
        plugin.onPluginUnload(context);
    });

    it('routes PumpkinPIE callbacks through the plugin instance handler', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const server = { getAllPlayers: () => [] } as unknown as Server;
        const context = { getServer: () => server } as Context;
        plugin.onPluginLoad(context);
        const message = new Uint8Array([1, 2, 3]);

        expect(plugin.handleIpcMessage('PumpkinPIE', message)).toBe(message);
        expect(state.routedMessage).toBe(message);
        plugin.onPluginUnload(context);
    });

    it('provides the selected icon token from the pre-dispatch command events', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const server = { getAllPlayers: () => [] } as unknown as Server;
        const context = { getServer: () => server } as Context;
        plugin.onPluginLoad(context);

        const consume = state.commandRuntime?.consumePendingItemIconInput;
        if (consume === undefined) throw new Error('Command runtime was not registered');
        const playerSender = { isPlayer: () => true, getName: () => 'Alex' } as never;
        state.events.get('player-command-send-event')?.(server, {
            player: { getName: () => 'Alex' },
            command: 'wp set icon Pumpkin minecraft:pumpkin_pie',
        });
        expect(consume(playerSender)).toBe('minecraft:pumpkin_pie');
        expect(consume(playerSender)).toBeUndefined();

        const consoleSender = { isPlayer: () => false, isConsole: () => true, getName: () => 'Server' } as never;
        const rconSender = { isPlayer: () => false, isConsole: () => false, getName: () => 'Rcon' } as never;
        state.events.get('server-command-event')?.(server, { command: 'wp set icon Pumpkin pumpkin_pie' });
        expect(consume(rconSender)).toBeUndefined();
        expect(consume(consoleSender)).toBe('pumpkin_pie');
        expect(consume(consoleSender)).toBeUndefined();
    });
});
