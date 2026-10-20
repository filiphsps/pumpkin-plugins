import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

const state = vi.hoisted(() => ({
    plugin: undefined as LoadedPlugin | undefined,
    files: undefined as { [Symbol.dispose](): void } | undefined,
    startForwarder: vi.fn(),
    stopForwarder: vi.fn(),
    handleForwarderMessage: vi.fn(),
    createNetwork: vi.fn(),
    registerCommands: vi.fn(),
    scheduleRepeating: vi.fn(() => 1),
    cancelTask: vi.fn(),
    apiReply: new Uint8Array([2]),
}));

vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {},
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
    handleCommand: vi.fn(),
    handleTask: vi.fn(),
}));
vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: () => state.files } }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({
    cancelTask: state.cancelTask,
    hostLogger: { error: vi.fn() },
    scheduleRepeating: state.scheduleRepeating,
}));
vi.mock('@pumpkin-plugins/pumpkin-api', () => ({
    handleIpcMessage: vi.fn(() => state.apiReply),
}));
vi.mock('./commands/register.ts', () => ({ registerCommands: state.registerCommands }));
vi.mock('./forwarder.ts', () => ({
    PortForwarder: class {
        start(): void {
            state.startForwarder();
        }

        stop(): void {
            state.stopForwarder();
        }

        tick(): void {}

        handleMessage(): Uint8Array {
            return state.handleForwarderMessage();
        }
    },
}));
vi.mock('./platform/wasi-network.ts', () => ({
    WasiNetwork: class {
        constructor() {
            state.createNetwork();
        }
    },
}));
vi.mock('./platform/wasi-sockets.ts', () => ({ wasiSockets: {} }));

describe('UPnPumpkin lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        state.plugin = undefined;
        state.files = { [Symbol.dispose]: vi.fn() };
        state.handleForwarderMessage.mockReturnValue(new Uint8Array([1]));
        await import('./plugin.ts');
    });

    it('stops the forwarder and disposes its data directory once on unload', async () => {
        const plugin = state.plugin;
        const files = state.files;
        if (plugin === undefined || files === undefined) throw new Error('Missing plugin fixture');
        const module = await import('./plugin.ts');
        const context = {} as Context;

        plugin.onPluginLoad(context);
        expect(module.handleIpcMessage('TestPlugin', new Uint8Array())).toEqual(new Uint8Array([1]));
        plugin.onPluginUnload(context);
        plugin.onPluginUnload(context);
        expect(module.handleIpcMessage('TestPlugin', new Uint8Array())).toBe(state.apiReply);

        expect.soft(state.stopForwarder).toHaveBeenCalledOnce();
        expect.soft(state.cancelTask).toHaveBeenCalledOnce();
        expect.soft(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('stops a started forwarder and disposes its data directory when command registration fails', () => {
        const plugin = state.plugin;
        const files = state.files;
        if (plugin === undefined || files === undefined) throw new Error('Missing plugin fixture');
        state.registerCommands.mockImplementationOnce(() => {
            throw new Error('registration failed');
        });

        expect(() => plugin.onPluginLoad({} as Context)).toThrow('registration failed');

        expect.soft(state.stopForwarder).toHaveBeenCalledOnce();
        expect.soft(state.cancelTask).toHaveBeenCalledOnce();
        expect.soft(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('retries task cancellation after a failure without repeating resource cleanup', () => {
        const plugin = state.plugin;
        const files = state.files;
        if (plugin === undefined || files === undefined) throw new Error('Missing plugin fixture');
        state.cancelTask.mockImplementationOnce(() => {
            throw new Error('cancellation failed');
        });
        const context = {} as Context;
        plugin.onPluginLoad(context);

        expect(() => plugin.onPluginUnload(context)).toThrow('cancellation failed');
        expect(state.stopForwarder).toHaveBeenCalledOnce();
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();

        plugin.onPluginUnload(context);
        plugin.onPluginUnload(context);

        expect(state.cancelTask).toHaveBeenCalledTimes(2);
        expect(state.cancelTask).toHaveBeenNthCalledWith(1, 1);
        expect(state.cancelTask).toHaveBeenNthCalledWith(2, 1);
        expect(state.stopForwarder).toHaveBeenCalledOnce();
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('stops a partially started forwarder and disposes its data directory when startup fails', () => {
        const plugin = state.plugin;
        const files = state.files;
        if (plugin === undefined || files === undefined) throw new Error('Missing plugin fixture');
        state.startForwarder.mockImplementationOnce(() => {
            throw new Error('start failed');
        });

        expect(() => plugin.onPluginLoad({} as Context)).toThrow('start failed');

        expect.soft(state.stopForwarder).toHaveBeenCalledOnce();
        expect(state.cancelTask).not.toHaveBeenCalled();
        expect.soft(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('disposes the data directory when network setup fails after opening it', () => {
        const plugin = state.plugin;
        const files = state.files;
        if (plugin === undefined || files === undefined) throw new Error('Missing plugin fixture');
        state.createNetwork.mockImplementationOnce(() => {
            throw new Error('network setup failed');
        });

        expect(() => plugin.onPluginLoad({} as Context)).toThrow('network setup failed');

        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
