import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    scheduled: [] as number[],
    scheduledTicks: [] as bigint[][],
    nextTaskId: 40,
    scheduleFailure: false,
    cancelFailure: false,
    cancelled: [] as number[]
}));
vi.mock('pumpkin:plugin/scheduler@0.1.0', () => ({
    scheduleDelayedTask(handlerId: number, delayTicks: bigint) {
        host.scheduled.push(handlerId);
        host.scheduledTicks.push([delayTicks]);
        if (host.scheduleFailure) throw new Error('Host scheduling failed');
        return host.nextTaskId++;
    },
    scheduleRepeatingTask(handlerId: number, delayTicks: bigint, periodTicks: bigint) {
        host.scheduled.push(handlerId);
        host.scheduledTicks.push([delayTicks, periodTicks]);
        if (host.scheduleFailure) throw new Error('Host scheduling failed');
        return host.nextTaskId++;
    },
    cancelTask(taskId: number) {
        if (host.cancelFailure) throw new Error('Host cancellation failed');
        host.cancelled.push(taskId);
    }
}));

import { handleTask, onUnload, registerPlugin } from './core.ts';
import { HostPlugin } from './host-plugin.ts';

class TestPlugin extends HostPlugin {
    metadata() {
        return { name: 'test', version: '1', authors: [], description: '', dependencies: [], permissions: [] };
    }
}
const server = {} as Server;

beforeEach(() => {
    onUnload({} as Context);
    host.scheduled.length = 0;
    host.scheduledTicks.length = 0;
    host.cancelled.length = 0;
    host.scheduleFailure = false;
    host.cancelFailure = false;
    registerPlugin(new TestPlugin());
});

describe('scheduled callback lifetime', () => {
    it.each([
        ['string', '1'],
        ['boolean', true],
        ['null', null],
        ['object with a bigint coercion', { valueOf: () => 1n }]
    ])('rejects a %s tick value before calling the scheduler', (_name, value) => {
        expect(() => new TestPlugin().scheduleDelayedTask(value as never, () => {})).toThrow(RangeError);
        expect(host.scheduled).toEqual([]);
    });

    it.each([
        {
            name: 'unsafe number delay',
            schedule: (plugin: TestPlugin) => plugin.scheduleDelayedTask(Number.MAX_SAFE_INTEGER + 1, () => {})
        },
        {
            name: 'negative bigint delay',
            schedule: (plugin: TestPlugin) => plugin.scheduleDelayedTask(-1n, () => {})
        },
        {
            name: 'delay beyond u64',
            schedule: (plugin: TestPlugin) => plugin.scheduleDelayedTask(1n << 64n, () => {})
        },
        {
            name: 'zero repeating period',
            schedule: (plugin: TestPlugin) => plugin.scheduleRepeatingTask(0, 0, () => {})
        },
        {
            name: 'repeating period beyond u64',
            schedule: (plugin: TestPlugin) => plugin.scheduleRepeatingTask(0, 1n << 64n, () => {})
        }
    ])('rejects $name before calling the scheduler', ({ schedule }) => {
        expect(() => schedule(new TestPlugin())).toThrow(RangeError);
        expect(host.scheduled).toEqual([]);
    });

    it('passes the largest u64 tick values to the scheduler without precision loss', () => {
        const plugin = new TestPlugin();
        const maxU64 = (1n << 64n) - 1n;

        plugin.scheduleDelayedTask(maxU64, () => {});
        plugin.scheduleRepeatingTask(0, 1, () => {});

        expect(host.scheduledTicks).toEqual([[maxU64], [0n, 1n]]);
    });

    it('releases a one-shot callback before invocation, including reentrant dispatch', () => {
        const plugin = new TestPlugin();
        let calls = 0;
        plugin.scheduleDelayedTask(1, () => {
            calls++;
            if (calls === 1) handleTask(host.scheduled[0], server);
        });
        handleTask(host.scheduled[0], server);
        handleTask(host.scheduled[0], server);
        expect(calls).toBe(1);
    });

    it('releases a throwing one-shot callback', () => {
        new TestPlugin().scheduleDelayedTask(1, () => {
            throw new Error('Callback failed');
        });
        expect(() => handleTask(host.scheduled[0], server)).toThrow('Callback failed');
        expect(() => handleTask(host.scheduled[0], server)).not.toThrow();
    });

    it.each(['delayed', 'repeating'])('rolls back a failed %s scheduling registration', (kind) => {
        const handler = vi.fn();
        host.scheduleFailure = true;
        const plugin = new TestPlugin();
        expect(() =>
            kind === 'delayed' ? plugin.scheduleDelayedTask(1, handler) : plugin.scheduleRepeatingTask(1, 2, handler)
        ).toThrow('Host scheduling failed');
        handleTask(host.scheduled[0], server);
        expect(handler).not.toHaveBeenCalled();
    });

    it.each(['delayed', 'repeating'])('cancels a %s task using its host task ID', (kind) => {
        const handler = vi.fn();
        const plugin = new TestPlugin();
        const taskId =
            kind === 'delayed' ? plugin.scheduleDelayedTask(1, handler) : plugin.scheduleRepeatingTask(1, 2, handler);
        plugin.cancelTask(taskId);
        handleTask(host.scheduled[0], server);
        expect(handler).not.toHaveBeenCalled();
        expect(host.cancelled).toEqual([taskId]);
        plugin.cancelTask(taskId);
        expect(host.cancelled).toEqual([taskId]);
    });

    it('retains repeating callbacks across invocations until self-cancellation', () => {
        const plugin = new TestPlugin();
        let calls = 0;
        const taskId = plugin.scheduleRepeatingTask(1, 2, () => {
            calls++;
            if (calls === 2) plugin.cancelTask(taskId);
        });
        handleTask(host.scheduled[0], server);
        handleTask(host.scheduled[0], server);
        handleTask(host.scheduled[0], server);
        expect(calls).toBe(2);
    });

    it('retains the callback when host cancellation fails', () => {
        const plugin = new TestPlugin();
        const handler = vi.fn();
        const taskId = plugin.scheduleRepeatingTask(1, 2, handler);
        host.cancelFailure = true;
        expect(() => plugin.cancelTask(taskId)).toThrow('Host cancellation failed');
        handleTask(host.scheduled[0], server);
        expect(handler).toHaveBeenCalledOnce();
    });

    it.each([false, true])('clears callbacks after unload even when onUnload throws=%s', (throws) => {
        const plugin = new TestPlugin();
        const handler = vi.fn();
        plugin.scheduleRepeatingTask(1, 2, handler);
        plugin.onUnload = () => {
            if (throws) throw new Error('Unload failed');
        };
        registerPlugin(plugin);
        if (throws) expect(() => onUnload({} as Context)).toThrow('Unload failed');
        else onUnload({} as Context);
        handleTask(host.scheduled[0], server);
        expect(handler).not.toHaveBeenCalled();
        registerPlugin(new TestPlugin());
    });
});
