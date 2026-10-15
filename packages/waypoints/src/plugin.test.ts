import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
    handleIpcMessage(sender: string, message: Uint8Array): Uint8Array;
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

const state = vi.hoisted(() => ({
    plugin: undefined as LoadedPlugin | undefined,
    files: undefined as MemoryFiles | undefined,
    commandRuntime: undefined as unknown,
    commandSuggestions: undefined as unknown,
    suggestionHandler: undefined as unknown,
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

vi.mock('pumpkin:plugin/logging@0.1.0', () => ({ log: vi.fn() }));
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
        registerCommandSuggestionHandler(handler: unknown): number {
            state.suggestionHandler = handler;
            return 91;
        }
    },
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
    handleTask: vi.fn(),
}));
vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: () => state.files } }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({
    runCommand: vi.fn(),
    scheduleRepeating: (_period: number, run: (server: Server) => void) => {
        const id = ++state.nextTask;
        state.tasks.set(id, run);
        return id;
    },
    cancelTask: (id: number) => state.tasks.delete(id),
}));
vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({
    registerCommands: (_ctx: unknown, _tree: unknown, _handlers: unknown, suggestions: unknown) => {
        state.commandSuggestions = suggestions;
    },
}));
vi.mock('./commands/handlers.ts', () => ({
    commandHandlers: (runtime: unknown) => {
        state.commandRuntime = runtime;
        return {};
    },
    resetPropertySuggestions: vi.fn(),
    waypointNameSuggestions: vi.fn(() => vi.fn()),
    onlinePlayerNameSuggestions: vi.fn(() => vi.fn()),
}));

describe('Waypoints plugin lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
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
        state.commandSuggestions = undefined;
        state.suggestionHandler = undefined;
        state.files = new MemoryFiles();
        await import('./plugin.ts');
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

        expect([...state.events.keys()]).toEqual([
            'player-join-event',
            'player-changed-world-event',
            'player-command-send-event',
            'server-command-event',
            'player-leave-event',
        ]);
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

        const runtime = state.commandRuntime as {
            consumePendingItemIconInput(sender: never): string | undefined;
        };
        const playerSender = { isPlayer: () => true, getName: () => 'Alex' } as never;
        state.events.get('player-command-send-event')?.(server, {
            player: { getName: () => 'Alex' },
            command: 'wp set icon Pumpkin minecraft:pumpkin_pie',
        });
        expect(runtime.consumePendingItemIconInput(playerSender)).toBe('minecraft:pumpkin_pie');
        expect(runtime.consumePendingItemIconInput(playerSender)).toBeUndefined();

        const consoleSender = { isPlayer: () => false, getName: () => 'Server' } as never;
        state.events.get('server-command-event')?.(server, { command: 'wp set icon Pumpkin pumpkin_pie' });
        expect(runtime.consumePendingItemIconInput(consoleSender)).toBe('pumpkin_pie');
        expect(runtime.consumePendingItemIconInput(consoleSender)).toBeUndefined();
    });

    it('registers the waypoint name suggestion callback with Pumpkin', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const context = { getServer: () => ({ getAllPlayers: () => [] }) } as unknown as Context;
        plugin.onPluginLoad(context);

        const suggestions = state.commandSuggestions as {
            arguments: Record<string, unknown>;
            register(handler: unknown): number;
        };
        const handler = vi.fn();
        expect(suggestions.arguments.name).toEqual(expect.any(Function));
        expect(suggestions.arguments.property).toEqual(expect.any(Function));
        expect(suggestions.arguments.player).toEqual(expect.any(Function));
        expect(suggestions.register(handler)).toBe(91);
        expect(state.suggestionHandler).toBe(handler);
    });
});
