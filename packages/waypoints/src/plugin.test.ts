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
    events: new Map<string, (server: Server, event: unknown) => void>()
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
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({ runCommand: vi.fn() }));
vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({ registerCommands: vi.fn() }));

describe('Waypoints plugin HUD lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        state.events.clear();
        state.files = new MemoryFiles();
        await import('./plugin.ts');
    });

    it('registers tick, join, world-change, and leave handlers and unloads cleanly', () => {
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
            'server-tick-end-event',
            'player-join-event',
            'player-changed-world-event',
            'player-leave-event'
        ]);
        state.events.get('server-tick-end-event')?.(server, {});
        expect(() => plugin.onPluginUnload(context)).not.toThrow();
    });
});
