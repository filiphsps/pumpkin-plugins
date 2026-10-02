import { describe, expect, it } from 'vitest';
import { PortMapClient } from './client.ts';
import { encodeReply, type PortStatus } from './protocol.ts';
import { MappingWatcher, openUrl, type WatchedState } from './watcher.ts';

const request = { key: 'web', protocol: 'tcp', port: 8123, description: 'Packs' } as const;

function setup() {
    let time = 0;
    const world = {
        reply: { ok: true, status: { kind: 'pending' } } as unknown as Parameters<typeof encodeReply>[0] | Error,
        calls: [] as string[]
    };
    const client = new PortMapClient((_, bytes) => {
        world.calls.push((JSON.parse(new TextDecoder().decode(bytes)) as { op: string }).op);
        if (world.reply instanceof Error) throw world.reply;
        return encodeReply(world.reply);
    });
    const changes: WatchedState[] = [];
    const watcher = new MappingWatcher(
        client,
        request,
        (s) => changes.push(s),
        () => time
    );
    const advance = (ms: number) => {
        time += ms;
        watcher.tick();
    };
    const answer = (status: PortStatus) => {
        world.reply = { ok: true, status };
    };
    return { watcher, world, changes, advance, answer };
}

describe('MappingWatcher', () => {
    it('asks at once and reports the first answer', () => {
        const { watcher, changes } = setup();
        watcher.start();
        expect(changes).toEqual([{ kind: 'pending' }]);
        expect(watcher.state).toEqual({ kind: 'pending' });
    });

    it('checks often while pending and reports only changes', () => {
        const { watcher, world, changes, advance, answer } = setup();
        watcher.start();
        advance(500);
        expect(world.calls).toHaveLength(1);
        advance(500);
        expect(world.calls).toHaveLength(2);
        expect(changes).toHaveLength(1);

        answer({ kind: 'open', via: 'upnp', address: '1.2.3.4', port: 8123 });
        advance(1000);
        expect(changes.at(-1)).toEqual({ kind: 'open', via: 'upnp', address: '1.2.3.4', port: 8123 });
        expect(openUrl(watcher.state)).toBe('http://1.2.3.4:8123');
    });

    it('slows down once the port is open and notices when the address changes', () => {
        const { watcher, world, changes, advance, answer } = setup();
        answer({ kind: 'open', via: 'upnp', address: '1.2.3.4', port: 8123 });
        watcher.start();
        advance(29_000);
        expect(world.calls).toHaveLength(1);
        answer({ kind: 'open', via: 'upnp', address: '5.6.7.8', port: 8123 });
        advance(1000);
        expect(changes.map(openUrl)).toEqual(['http://1.2.3.4:8123', 'http://5.6.7.8:8123']);
    });

    it('reports an unreachable UPnPumpkin and recovers when it shows up', () => {
        const { watcher, world, changes, advance, answer } = setup();
        world.reply = new Error('plugin not found');
        watcher.start();
        expect(changes).toEqual([{ kind: 'unavailable', reason: 'plugin not found' }]);

        advance(5000);
        expect(world.calls).toHaveLength(1);
        answer({ kind: 'pending' });
        advance(10_000);
        expect(changes.at(-1)).toEqual({ kind: 'pending' });
    });

    it('reports a refusal as a failure with its reason', () => {
        const { watcher, world, changes } = setup();
        world.reply = { ok: false, error: 'port must be a number' };
        watcher.start();
        expect(changes).toEqual([{ kind: 'failed', reason: 'port must be a number' }]);
    });

    it('releases the port when stopped, stops asking, and survives UPnPumpkin being gone', () => {
        const { watcher, world, advance } = setup();
        watcher.start();
        watcher.stop();
        expect(world.calls).toEqual(['ensure', 'release']);
        advance(60_000);
        expect(world.calls).toHaveLength(2);

        world.reply = new Error('gone');
        watcher.start();
        expect(() => watcher.stop()).not.toThrow();
        watcher.stop();
    });

    it('does not make a URL for a port that is not open', () => {
        expect(openUrl(undefined)).toBeUndefined();
        expect(openUrl({ kind: 'pending' })).toBeUndefined();
        expect(openUrl({ kind: 'unavailable', reason: 'x' })).toBeUndefined();
    });
});
