import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    beforeEach(() => vi.clearAllMocks());

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
});
