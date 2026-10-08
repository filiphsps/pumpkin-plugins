import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

const state = vi.hoisted(() => ({
    plugin: undefined as LoadedPlugin | undefined,
    files: undefined as MemoryFiles | undefined,
    commandRuntime: undefined as unknown,
    events: new Map<string, (server: Server, event: unknown) => void>(),
    tasks: new Map<number, (server: Server) => void>(),
    nextTask: 0
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
    }
}));
vi.mock('pumpkin:plugin/uuid@0.1.0', () => ({
    generate: () => ({ high: 3n, low: 4n }),
    parse: () => ({ high: 1n, low: 2n }),
    toString: () => '11111111-1111-4111-8111-111111111111'
}));
vi.mock('@pumpkinmc/pumpkin-api-ts', () => ({ handleCommand: vi.fn() }));
vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {
        registerEvent(_ctx: Context, name: string, run: (server: Server, event: unknown) => void): void {
            state.events.set(name, run);
        }
    },
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
    handleTask: vi.fn()
}));
vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: () => state.files } }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({
    runCommand: vi.fn(),
    scheduleRepeating: (_period: number, run: (server: Server) => void) => {
        const id = ++state.nextTask;
        state.tasks.set(id, run);
        return id;
    },
    cancelTask: (id: number) => state.tasks.delete(id)
}));
vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({ registerCommands: vi.fn() }));
vi.mock('./commands/handlers.ts', () => ({
    commandHandlers: (runtime: unknown) => {
        state.commandRuntime = runtime;
        return {};
    }
}));

describe('Waypoints plugin HUD lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        state.events.clear();
        state.tasks.clear();
        state.nextTask = 0;
        state.commandRuntime = undefined;
        state.files = new MemoryFiles();
        await import('./plugin.ts');
    });

    it('schedules HUD updates and cancels the task on unload', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const opManager = { isOp: () => false, [Symbol.dispose]: vi.fn() };
        const server = {
            getAllPlayers: () => [],
            getOpManager: () => opManager
        } as unknown as Server;
        const context = { getServer: () => server } as Context;

        plugin.onPluginLoad(context);

        expect([...state.events.keys()]).toEqual([
            'player-join-event',
            'player-changed-world-event',
            'player-command-send-event',
            'server-command-event',
            'player-leave-event'
        ]);
        expect(state.tasks.size).toBe(1);
        state.tasks.get(1)?.(server);
        expect(() => plugin.onPluginUnload(context)).not.toThrow();
        expect(state.tasks.size).toBe(0);
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
            command: 'wp set icon Pumpkin minecraft:pumpkin_pie'
        });
        expect(runtime.consumePendingItemIconInput(playerSender)).toBe('minecraft:pumpkin_pie');
        expect(runtime.consumePendingItemIconInput(playerSender)).toBeUndefined();

        const consoleSender = { isPlayer: () => false, getName: () => 'Server' } as never;
        state.events.get('server-command-event')?.(server, { command: 'wp set icon Pumpkin pumpkin_pie' });
        expect(runtime.consumePendingItemIconInput(consoleSender)).toBe('pumpkin_pie');
        expect(runtime.consumePendingItemIconInput(consoleSender)).toBeUndefined();
    });
});
