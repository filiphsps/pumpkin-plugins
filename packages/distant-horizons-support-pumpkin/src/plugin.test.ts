import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

const state = vi.hoisted(() => ({
    files: undefined as unknown,
    plugin: undefined as LoadedPlugin | undefined,
    openDataDir: vi.fn(() => state.files),
    readSettings: vi.fn(),
    registerCommands: vi.fn(),
}));

vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: state.openDataDir } }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({ hostLogger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('@pumpkin-plugins/pumpkin-api', () => ({ handleCommand: vi.fn(), handleTask: vi.fn() }));
vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {
        registerEvent(): void {}

        onPluginUnload(): void {}
    },
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
}));
vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({ registerCommands: state.registerCommands }));
vi.mock('./commands/handlers.ts', () => ({ commandHandlers: vi.fn(() => ({})) }));
vi.mock('./commands/spec.ts', () => ({ commands: [] }));
vi.mock('./config/load.ts', () => ({ readSettings: state.readSettings }));
vi.mock('./info.ts', () => ({ info: { name: 'DistantHorizonsSupportPumpkin' } }));
vi.mock('./lod/cache.ts', () => ({ LodCache: class {} }));
vi.mock('./name.ts', () => ({ PLUGIN_NAME: 'DistantHorizonsSupportPumpkin' }));
vi.mock('./platform/peers.ts', () => ({ serverPeers: vi.fn(), withPlayer: vi.fn() }));
vi.mock('./platform/world-mutations.ts', () => ({ invalidateBlockGrow: vi.fn(), invalidateBlockSpread: vi.fn() }));
vi.mock('./protocol/messages.ts', () => ({ CHANNEL: 'dh', PROTOCOL: 16 }));
vi.mock('./session.ts', () => ({ Sessions: class {} }));

describe('DistantHorizonsSupportPumpkin lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        state.plugin = undefined;
        state.files = { [Symbol.dispose]: vi.fn() };
        state.readSettings.mockReturnValue({});
        await import('./plugin.ts');
    });

    it('disposes the data directory on unload after using it for initialization', () => {
        const plugin = state.plugin;
        if (!plugin) throw new Error('Plugin was not registered');
        const files = state.files as { [Symbol.dispose](): void };
        const context = {} as Context;

        plugin.onPluginLoad(context);
        plugin.onPluginUnload(context);

        expect(state.readSettings).toHaveBeenCalledWith(files, expect.any(Object));
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('disposes the data directory when initialization fails after opening it', () => {
        const plugin = state.plugin;
        if (!plugin) throw new Error('Plugin was not registered');
        const files = state.files as { [Symbol.dispose](): void };
        const context = {} as Context;
        const failure = new Error('command registration failed');
        state.registerCommands.mockImplementationOnce(() => {
            throw failure;
        });

        expect(() => plugin.onPluginLoad(context)).toThrow(failure);
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
