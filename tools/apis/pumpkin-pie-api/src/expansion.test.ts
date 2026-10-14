import { strFromU8, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import * as api from './index.ts';

const callback = (patch = {}) =>
    strToU8(
        JSON.stringify({
            op: 'on_request',
            namespace: 'ranks',
            id: 'ranks_prefix',
            name: 'prefix',
            viewer: 'Steve',
            argument: null,
            ...patch,
        }),
    );
function setup() {
    expect(api.CallbackGuard).toBeTypeOf('function');
    const guard = new api.CallbackGuard();
    const router = new api.ExpansionRouter(guard);
    return { guard, router, reply: (bytes: Uint8Array) => JSON.parse(strFromU8(bytes)) };
}

it('authenticates the provider and dispatches only owned registered handlers', () => {
    const { router, reply } = setup();
    router.register('Ranks', {
        prefix: (context) => `${context.viewer}:${context.argument ?? 'none'}`,
        empty: () => '',
    });
    expect(reply(router.handle('PumpkinPIE', callback()))).toEqual({ ok: true, on_request: { value: 'Steve:none' } });
    expect(reply(router.handle('spoof', callback())).ok).toBe(false);
    for (const patch of [
        { name: 'unlisted', id: 'ranks_unlisted' },
        { namespace: 'other', id: 'other_prefix' },
        { name: 'tostring', id: 'ranks_tostring' },
    ]) {
        expect(reply(router.handle('PumpkinPIE', callback(patch)))).toEqual({ ok: true, on_request: {} });
    }
    expect(reply(router.handle('PumpkinPIE', callback({ name: 'empty', id: 'ranks_empty' })))).toEqual({
        ok: true,
        on_request: { value: '' },
    });
    router.remove('ranks');
    expect(reply(router.handle('PumpkinPIE', callback()))).toEqual({ ok: true, on_request: {} });
});
it('rejects malformed callbacks and invalid namespace registrations', () => {
    const { router, reply } = setup();
    for (const namespace of ['player', 'server', 'pie', 'my_plugin', '1rank', '', 'é'])
        expect(() => router.register(namespace, {})).toThrow(api.InputError);
    expect(() => router.register('ranks', { 'bad-name': () => '' })).toThrow(api.InputError);
    for (const patch of [
        { op: 'ping' },
        { name: 1 },
        { viewer: [] },
        { argument: 'é'.repeat(65) },
        { id: 'wrong_prefix' },
    ])
        expect(reply(router.handle('PumpkinPIE', callback(patch))).ok).toBe(false);
    expect(reply(router.handle('PumpkinPIE', new Uint8Array([255]))).ok).toBe(false);
});
it('blocks provider re-entry and releases the guard after handler errors', () => {
    const { router, guard, reply } = setup();
    let sends = 0;
    const client = new api.PieClient(
        () => {
            sends++;
            return strToU8('{"ok":true,"value":{"known":false}}');
        },
        { guard },
    );
    router.register('ranks', {
        prefix: () => {
            client.getValue('server_online');
            return 'bad';
        },
    });
    expect(reply(router.handle('PumpkinPIE', callback())).ok).toBe(false);
    expect(sends).toBe(0);
    expect(client.getValue('server_online')).toEqual({ known: false });
    router.register('ranks', {
        prefix: () => {
            throw new Error('private secret');
        },
    });
    expect(strFromU8(router.handle('PumpkinPIE', callback()))).not.toContain('private secret');
    expect(client.getValue('server_online')).toEqual({ known: false });
    router.register('ranks', { prefix: (() => Promise.resolve('bad')) as unknown as api.ExpansionHandler });
    expect(reply(router.handle('PumpkinPIE', callback())).ok).toBe(false);
});
it('normalizes callback namespace case while preserving the raw placeholder id', () => {
    const { router, reply } = setup();
    router.register('ranks', { prefix: (context) => context.id });
    expect(reply(router.handle('PumpkinPIE', callback({ namespace: 'Ranks', id: 'Ranks_PREFIX' })))).toEqual({
        ok: true,
        on_request: { value: 'Ranks_PREFIX' },
    });
});
