import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
    log: vi.fn(),
    register: vi.fn(),
    requestAsync: vi.fn()
}));

vi.mock('pumpkin:plugin/logging@0.1.0', () => ({ log: calls.log }));
vi.mock('@pumpkinmc/pumpkin-api-ts', () => ({ registerPlugin: calls.register }));
vi.mock('./http.ts', () => ({ requestMarketJsonAsync: calls.requestAsync }));

import type { Plugin } from '@pumpkinmc/pumpkin-api-ts';
import { registerPluginWithUpdates, type UpdateRegistrationOptions } from './register.ts';

const info = { name: 'ExamplePlugin', description: 'An example plugin.' };

function fixture(): Plugin {
    return {
        onLoad: vi.fn(),
        metadata: () => ({ version: '1.2.0' })
    } as unknown as Plugin;
}

describe('registerPluginWithUpdates', () => {
    beforeEach(() => vi.resetAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('does not check for updates in development mode', () => {
        vi.stubGlobal('__PUMPKIN_DEV_MODE__', true);
        const plugin = fixture();
        const schedule = vi.fn();

        registerPluginWithUpdates(plugin, info, { schedule });
        plugin.onLoad?.({} as never);

        expect(schedule).not.toHaveBeenCalled();
        expect(calls.requestAsync).not.toHaveBeenCalled();
        expect(calls.log).not.toHaveBeenCalled();
    });

    it('schedules the request and reports a result without blocking plugin loading', () => {
        const plugin = fixture();
        const queued: Array<() => void> = [];
        const schedule = (callback: () => void) => queued.push(callback);
        calls.requestAsync.mockImplementation((_url, _schedule, complete) =>
            complete({ ok: true, value: { latest_version: '1.3.0', update_available: true } })
        );

        registerPluginWithUpdates(plugin, info, { schedule });
        plugin.onLoad?.({} as never);

        expect(queued).toHaveLength(1);
        expect(calls.requestAsync).not.toHaveBeenCalled();
        queued.shift()?.();
        expect(calls.requestAsync).toHaveBeenCalledOnce();
        expect(calls.log).toHaveBeenCalledWith('info', 'ExamplePlugin update available: 1.2.0 -> 1.3.0');
    });

    it('does not fall back to a blocking request when the scheduler is missing', () => {
        const plugin = fixture();

        registerPluginWithUpdates(plugin, info, {} as UpdateRegistrationOptions);
        plugin.onLoad?.({} as never);

        expect(calls.requestAsync).not.toHaveBeenCalled();
        expect(calls.log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('A scheduler is required for the automatic update check')
        );
    });
    it('preserves the original load context and registers the same plugin', () => {
        const plugin = fixture();
        const onLoad = plugin.onLoad;
        const ctx = {} as never;
        registerPluginWithUpdates(plugin, info, { request: () => ({ latest_version: null, update_available: false }) });
        plugin.onLoad(ctx);
        expect(onLoad).toHaveBeenCalledExactlyOnceWith(ctx);
        expect(vi.mocked(onLoad).mock.contexts).toEqual([plugin]);
        expect(calls.register).toHaveBeenCalledExactlyOnceWith(plugin);
        expect(calls.log).not.toHaveBeenCalled();
    });

    it('does not check updates when plugin loading fails', () => {
        const plugin = fixture();
        plugin.onLoad = () => {
            throw new Error('load failed');
        };
        const request = vi.fn();
        registerPluginWithUpdates(plugin, info, { request });
        expect(() => plugin.onLoad({} as never)).toThrow('load failed');
        expect(request).not.toHaveBeenCalled();
        expect(calls.log).not.toHaveBeenCalled();
    });

    it('supports deterministic request overrides and the Market base URL', () => {
        const plugin = fixture();
        const request = vi.fn(() => ({ latest_version: '1.3.0', update_available: true }));
        registerPluginWithUpdates(plugin, info, { request, marketplaceUrl: 'http://market.test/' });
        plugin.onLoad({} as never);
        expect(request).toHaveBeenCalledWith(
            'http://market.test/api/v1/rest/check-update?plugin_name=ExamplePlugin&current_version=1.2.0'
        );
        expect(calls.log).toHaveBeenCalledWith('info', 'ExamplePlugin update available: 1.2.0 -> 1.3.0');
        expect(calls.requestAsync).not.toHaveBeenCalled();
    });

    it.each([
        { ok: false, error: new Error('network failed') },
        { ok: true, value: {} },
        { ok: true, value: { latest_version: 'invalid', update_available: true } }
    ])('logs asynchronous failures without interrupting the task: %j', (result) => {
        const plugin = fixture();
        const queued: Array<() => void> = [];
        calls.requestAsync.mockImplementation((_url, _schedule, complete) => complete(result));
        registerPluginWithUpdates(plugin, info, {
            schedule: (callback) => {
                queued.push(callback);
            },
            marketplaceUrl: 'http://market.test'
        });
        plugin.onLoad({} as never);
        expect(() => queued.shift()?.()).not.toThrow();
        expect(calls.requestAsync).toHaveBeenCalledWith(
            'http://market.test/api/v1/rest/check-update?plugin_name=ExamplePlugin&current_version=1.2.0',
            expect.any(Function),
            expect.any(Function)
        );
        expect(calls.log).toHaveBeenCalledWith('warn', expect.stringContaining('ExamplePlugin update check failed:'));
    });

    it('logs scheduler failures after finishing plugin loading', () => {
        const plugin = fixture();
        const onLoad = plugin.onLoad;
        registerPluginWithUpdates(plugin, info, {
            schedule: () => {
                throw new Error('scheduler failed');
            }
        });
        expect(() => plugin.onLoad({} as never)).not.toThrow();
        expect(onLoad).toHaveBeenCalledOnce();
        expect(calls.log).toHaveBeenCalledWith('warn', 'ExamplePlugin update check failed: scheduler failed');
    });

    it('logs request override failures without interrupting loading', () => {
        const plugin = fixture();
        registerPluginWithUpdates(plugin, info, {
            request: () => {
                throw new Error('request failed');
            }
        });
        expect(() => plugin.onLoad({} as never)).not.toThrow();
        expect(calls.log).toHaveBeenCalledWith('warn', 'ExamplePlugin update check failed: request failed');
    });
});
