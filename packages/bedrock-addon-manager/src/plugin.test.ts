import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

const state = vi.hoisted(() => ({
    plugin: undefined as LoadedPlugin | undefined,
    files: undefined as unknown,
    managerStart: vi.fn(),
    managerStop: vi.fn(),
    cancelTask: vi.fn(),
}));

vi.mock('@pumpkin-plugins/plugin-kit/ipc', () => ({ ipcSend: vi.fn() }));
vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {},
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
}));
vi.mock('@pumpkin-plugins/pumpkin-api', () => ({ handleCommand: vi.fn() }));
vi.mock('./commands/register.ts', () => ({ registerCommands: vi.fn() }));
vi.mock('./manager.ts', () => ({
    PackManager: class {
        start(): void {
            state.managerStart();
        }

        stop(options: unknown): void {
            state.managerStop(options);
        }
    },
}));
vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: () => state.files } }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({
    cancelTask: state.cancelTask,
    hostLogger: { error: vi.fn() },
    scheduleRepeating: vi.fn(() => 1),
}));
vi.mock('./web/tcp-server.ts', () => ({ TcpWebServer: class {} }));

describe('BedrockAddonManager lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        state.plugin = undefined;
        state.files = { [Symbol.dispose]: vi.fn() };
        await import('./plugin.ts');
    });

    it('disposes its data directory and stops its manager on unload', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const files = state.files as { [Symbol.dispose](): void };
        const context = {} as Context;

        plugin.onPluginLoad(context);
        plugin.onPluginUnload(context);

        expect(state.managerStop).toHaveBeenCalledWith({ releasePort: false });
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('disposes its data directory when manager shutdown fails', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const files = state.files as { [Symbol.dispose](): void };
        const context = {} as Context;
        state.managerStop.mockImplementationOnce(() => {
            throw new Error('shutdown failed');
        });
        plugin.onPluginLoad(context);

        expect(() => plugin.onPluginUnload(context)).toThrow('shutdown failed');
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('stops the manager and disposes its data directory when task cancellation fails', () => {
        const plugin = state.plugin;
        if (plugin === undefined) throw new Error('Plugin was not registered');
        const files = state.files as { [Symbol.dispose](): void };
        const context = {} as Context;
        state.cancelTask.mockImplementationOnce(() => {
            throw new Error('cancellation failed');
        });
        plugin.onPluginLoad(context);

        expect(() => plugin.onPluginUnload(context)).toThrow('cancellation failed');
        expect(state.managerStop).toHaveBeenCalledWith({ releasePort: false });
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
