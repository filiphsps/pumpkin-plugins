import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
    apiLoad: vi.fn(),
    apiHandleTask: vi.fn(),
    apiUnload: vi.fn(),
    info: vi.fn(),
    pluginLoad: vi.fn(),
    pluginUnload: vi.fn(),
    registerWithUpdates: vi.fn(),
    runTask: vi.fn(),
    scheduleDelayed: vi.fn()
}));

vi.mock('@pumpkinmc/pumpkin-api-ts', () => ({
    Plugin: class {
        onLoad(ctx: unknown): void {
            calls.apiLoad(ctx);
        }

        onUnload(ctx: unknown): void {
            calls.apiUnload(ctx);
        }
    },
    handleTask: calls.apiHandleTask
}));

vi.mock('@pumpkin-plugins/update-check', () => ({
    registerPluginWithUpdates: calls.registerWithUpdates
}));

vi.mock('./host.ts', () => ({
    hostLogger: { info: calls.info },
    runTask: calls.runTask,
    scheduleDelayed: calls.scheduleDelayed
}));

import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { registerPluginWithUpdates } from '@pumpkin-plugins/update-check';
import { colorLogValue } from './logger.ts';
import { handleTask, PluginBase, registerPlugin } from './plugin.ts';

const info = { name: 'ExamplePlugin', description: 'An example plugin.' };

class ExamplePlugin extends PluginBase {
    constructor() {
        super(info, '1.2.3');
    }

    protected onPluginLoad(ctx: Context): void {
        calls.pluginLoad(ctx);
    }

    protected override onPluginUnload(ctx: Context): void {
        calls.pluginUnload(ctx);
    }
}

describe('PluginBase', () => {
    beforeEach(() => vi.resetAllMocks());

    it('builds metadata from info and the package version', () => {
        expect(new ExamplePlugin().metadata()).toEqual({
            name: 'ExamplePlugin',
            version: '1.2.3',
            authors: [],
            description: 'An example plugin.',
            dependencies: [],
            permissions: ['http.outbound']
        });
    });

    it('runs the common and plugin-specific lifecycle behavior', () => {
        const plugin = new ExamplePlugin();
        const ctx = {} as Context;

        plugin.onLoad(ctx);
        plugin.onUnload(ctx);

        expect(calls.apiLoad).toHaveBeenCalledWith(ctx);
        expect(calls.info).toHaveBeenCalledWith(
            `${colorLogValue('ExamplePlugin', 'cyan')} ${colorLogValue('1.2.3', 'green')} loaded`
        );
        expect(calls.pluginLoad).toHaveBeenCalledWith(ctx);
        expect(calls.apiUnload).toHaveBeenCalledWith(ctx);
        expect(calls.pluginUnload).toHaveBeenCalledWith(ctx);
    });

    it('registers the plugin through the update-check wrapper', () => {
        const plugin = new ExamplePlugin();

        registerPlugin(plugin);

        expect(registerPluginWithUpdates).toHaveBeenCalledWith(
            plugin,
            info,
            expect.objectContaining({ schedule: expect.any(Function) })
        );
    });

    it('routes shared tasks before the API task handler', () => {
        const server = {} as Server;
        calls.runTask.mockReturnValueOnce(true).mockReturnValueOnce(false);

        handleTask(900_000, server);
        handleTask(1, server);

        expect(calls.runTask).toHaveBeenNthCalledWith(1, 900_000, server);
        expect(calls.runTask).toHaveBeenNthCalledWith(2, 1, server);
        expect(calls.apiHandleTask).toHaveBeenCalledTimes(1);
        expect(calls.apiHandleTask).toHaveBeenCalledWith(1, server);
    });
    it('only logs a successful load after the plugin hook completes', () => {
        const plugin = new ExamplePlugin();
        calls.pluginLoad.mockImplementationOnce(() => {
            throw new Error('setup failed');
        });
        expect(() => plugin.onLoad({} as Context)).toThrow('setup failed');
        expect(calls.info).not.toHaveBeenCalled();
        plugin.onLoad({} as Context);
        expect(calls.info).toHaveBeenCalledOnce();
        expect(calls.pluginLoad.mock.invocationCallOrder[1]).toBeLessThan(calls.info.mock.invocationCallOrder[0]);
    });
});
