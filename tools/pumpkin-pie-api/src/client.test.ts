import { strFromU8, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as api from './index.ts';

const ping = { ok: true, ping: { protocol: 0, name: 'PumpkinPIE', version: '0.2.3', placeholders: 11, expansions: 2 } };
const fixtures = [
    ['ping', [], '{"op":"ping"}', ping, ping.ping],
    [
        'resolve',
        ['%player_name%', 'Steve'],
        '{"op":"set_placeholders","text":"%player_name%","viewer":"Steve"}',
        { ok: true, resolved: { text: 'Steve', unresolved: [] } },
        { text: 'Steve', unresolved: [] }
    ],
    [
        'resolveBatch',
        [[{ text: '%player_ping%ms', viewer: 'Steve' }, { text: '%server_online% online' }]],
        '{"op":"set_placeholders_batch","requests":[{"text":"%player_ping%ms","viewer":"Steve"},{"text":"%server_online% online"}]}',
        {
            ok: true,
            resolved_batch: {
                results: [
                    { text: '42ms', unresolved: [] },
                    { text: '5 online', unresolved: [] }
                ]
            }
        },
        [
            { text: '42ms', unresolved: [] },
            { text: '5 online', unresolved: [] }
        ]
    ],
    [
        'getValue',
        ['player_has_permission', 'Steve', 'Example:use'],
        '{"op":"get_placeholder_value","id":"player_has_permission","viewer":"Steve","argument":"Example:use"}',
        { ok: true, value: { known: false } },
        { known: false }
    ],
    [
        'list',
        [],
        '{"op":"get_registered_placeholders"}',
        {
            ok: true,
            registered: {
                placeholders: [{ id: 'player_name', description: 'Name', namespace: 'player', source: 'PumpkinPIE' }]
            }
        },
        [{ id: 'player_name', description: 'Name', namespace: 'player', source: 'PumpkinPIE' }]
    ],
    [
        'registerExpansion',
        [{ namespace: 'ranks', placeholders: ['prefix'], cache: { kind: 'ttl', ms: 90000 } }],
        '{"op":"register_expansion","namespace":"ranks","placeholders":["prefix"],"cache":{"kind":"ttl","ms":90000}}',
        {
            ok: true,
            registered_expansion: { namespace: 'ranks', placeholders: ['prefix'], cache: { kind: 'ttl', ms: 60000 } }
        },
        { namespace: 'ranks', placeholders: ['prefix'], cache: { kind: 'ttl', ms: 60000 } }
    ],
    [
        'unregisterExpansions',
        [],
        '{"op":"unregister_expansion"}',
        { ok: true, unregistered: { namespaces: ['ranks'] } },
        ['ranks']
    ]
] as const;

function client(reply: unknown, sent: string[] = []) {
    expect(api.PieClient).toBeTypeOf('function');
    return new api.PieClient((recipient, bytes) => {
        expect(recipient).toBe('PumpkinPIE');
        sent.push(strFromU8(bytes));
        return reply instanceof Uint8Array ? reply : strToU8(JSON.stringify(reply));
    });
}

describe('literal protocol interoperability', () => {
    for (const [method, args, request, reply, result] of fixtures) {
        it(`sends and validates ${method}`, () => {
            const sent: string[] = [];
            const c = client(reply, sent);
            // Fixture arguments intentionally cover each concrete public method.
            expect(Reflect.apply(c[method], c, args)).toEqual(result);
            expect(sent).toEqual([request]);
        });
        it(`rejects a wrong wrapper for ${method}`, () => {
            const c = client({ ok: true, on_request: {} });
            expect(() => Reflect.apply(c[method], c, args)).toThrow(api.ProtocolError);
        });
    }
    it('keeps unknown separate from known empty and preserves unresolved tokens', () => {
        expect(client({ ok: true, value: { known: true, value: '' } }).getValue('empty')).toEqual({
            known: true,
            value: ''
        });
        expect(
            client({ ok: true, resolved: { text: '%unknown%', unresolved: ['unknown'] }, extra: 1 }).resolve(
                '%unknown%'
            )
        ).toEqual({ text: '%unknown%', unresolved: ['unknown'] });
    });
    it('classifies transport, rejection and incompatible failures', () => {
        expect(api.PieClient).toBeTypeOf('function');
        expect(() =>
            new api.PieClient(() => {
                throw new Error('host');
            }).ping()
        ).toThrow(api.UnavailableError);
        expect(() => client({ ok: false, error: 'reserved' }).ping()).toThrow(api.RejectedError);
        expect(() => client({ ...ping, ping: { ...ping.ping, protocol: 1 } }).ping()).toThrow(api.IncompatibleError);
    });
    it.each([
        null,
        [],
        {},
        { ok: true },
        { ok: false },
        { ok: true, ping: { ...ping.ping, expansions: 1.5 } },
        { ok: true, ping: { ...ping.ping, protocol: -1 } },
        { ok: true, ping: { ...ping.ping, name: null } },
        strToU8('{'),
        new Uint8Array([0xc0, 0xaf]),
        new Uint8Array([0xed, 0xa0, 0x80]),
        new Uint8Array([0xf4, 0x90, 0x80, 0x80]),
        new Uint8Array(1048577)
    ])('rejects malformed ping %j', (reply) => {
        expect(() => client(reply).ping()).toThrow(api.ProtocolError);
    });
    it.each([
        { known: false, value: '' },
        { known: true },
        { known: true, value: null },
        { known: 'true', value: 'x' }
    ])('rejects contradictory values %j', (value) => {
        expect(() => client({ ok: true, value }).getValue('id')).toThrow(api.ProtocolError);
    });
    it.each(
        [
            [],
            [
                { text: 'a', unresolved: [] },
                { text: 'b', unresolved: [] }
            ],
            [{ text: 'a', unresolved: [1] }],
            [{ text: 'a' }],
            [{ text: 'é'.repeat(16385), unresolved: [] }]
        ].map((results) => ({ results }))
    )('discards invalid or mismatched batches %j', ({ results }) => {
        expect(() => client({ ok: true, resolved_batch: { results } }).resolveBatch([{ text: 'a' }])).toThrow(
            api.ProtocolError
        );
    });
    it('preflights Unicode, JSON escaping, full batches and exact boundaries', () => {
        const sent: string[] = [];
        const c = client({ ok: true, resolved: { text: '', unresolved: [] } }, sent);
        c.resolve('é'.repeat(16384), 'é'.repeat(64));
        expect(sent).toHaveLength(1);
        for (const action of [
            () => c.resolve('é'.repeat(16385)),
            () => c.resolve('', 'é'.repeat(65)),
            () => c.getValue('é'.repeat(65)),
            () => c.getValue('id', undefined, 'é'.repeat(65)),
            () => c.resolve('\ud800'),
            () => c.resolveBatch([{ text: 'ok' }, { text: 'x'.repeat(32769) }]),
            () => c.resolveBatch(Array.from({ length: 8193 }, () => ({ text: '' }))),
            () => c.resolveBatch(Array.from({ length: 6 }, () => ({ text: '\u0000'.repeat(32768) })))
        ]) {
            expect(action).toThrow(api.InputError);
        }
        expect(sent).toHaveLength(1);
        const empty = Array.from({ length: 8192 }, () => ({ text: '' }));
        expect(
            client({
                ok: true,
                resolved_batch: { results: empty.map(() => ({ text: '', unresolved: [] })) }
            }).resolveBatch(empty)
        ).toHaveLength(8192);
    });
    it('partitions by bytes and count, preserving order and preflighting later lines', () => {
        expect(api.PieClient).toBeTypeOf('function');
        const sizes: number[] = [];
        const c = new api.PieClient((_recipient, bytes) => {
            sizes.push(bytes.length);
            const request = JSON.parse(strFromU8(bytes));
            return strToU8(
                JSON.stringify({
                    ok: true,
                    resolved_batch: {
                        results: request.requests.map((line: { text: string }) => ({ text: line.text, unresolved: [] }))
                    }
                })
            );
        });
        const lines = Array.from({ length: 35 }, (_, i) => ({ text: String(i) + 'x'.repeat(32000) }));
        expect(c.resolveMany(lines).map((line) => line.text.slice(0, 2))).toEqual(
            lines.map((line) => line.text.slice(0, 2))
        );
        expect(sizes).toHaveLength(2);
        expect(sizes.every((size) => size <= 1048576)).toBe(true);
        expect(c.resolveMany(Array.from({ length: 8193 }, () => ({ text: '' })))).toHaveLength(8193);
        const before = sizes.length;
        expect(() => c.resolveMany([{ text: 'ok' }, { text: 'bad'.repeat(32768) }])).toThrow(api.InputError);
        expect(sizes).toHaveLength(before);
    });
    it('never returns partial results when a later chunk fails', () => {
        expect(api.PieClient).toBeTypeOf('function');
        let count = 0;
        const c = new api.PieClient(() =>
            strToU8(
                JSON.stringify(
                    ++count === 1
                        ? {
                              ok: true,
                              resolved_batch: {
                                  results: Array.from({ length: 8192 }, () => ({ text: '', unresolved: [] }))
                              }
                          }
                        : { ok: true, resolved_batch: { results: [] } }
                )
            )
        );
        expect(() => c.resolveMany(Array.from({ length: 8193 }, () => ({ text: '' })))).toThrow(api.ProtocolError);
    });
});

it('accepts provider normalization, deduplication and sorting of advertised names', () => {
    expect(
        client({
            ok: true,
            registered_expansion: { namespace: 'ranks', placeholders: ['count', 'prefix'], cache: { kind: 'never' } }
        }).registerExpansion({ namespace: 'Ranks', placeholders: ['Prefix', 'Count', 'prefix'] })
    ).toEqual({ namespace: 'ranks', placeholders: ['count', 'prefix'], cache: { kind: 'never' } });
});
it('rejects malformed fields in every remaining result operation', () => {
    const cases: {
        method: 'list' | 'registerExpansion' | 'unregisterExpansions' | 'resolve';
        args: unknown[];
        reply: unknown;
    }[] = [
        { method: 'list', args: [], reply: { ok: true, registered: { placeholders: [null] } } },
        {
            method: 'list',
            args: [],
            reply: { ok: true, registered: { placeholders: [{ id: 'id', namespace: 'player', source: 'PumpkinPIE' }] } }
        },
        { method: 'unregisterExpansions', args: [], reply: { ok: true, unregistered: { namespaces: [1] } } },
        {
            method: 'registerExpansion',
            args: [{ namespace: 'ranks' }],
            reply: {
                ok: true,
                registered_expansion: { namespace: 'other', placeholders: [], cache: { kind: 'never' } }
            }
        },
        {
            method: 'registerExpansion',
            args: [{ namespace: 'ranks' }],
            reply: {
                ok: true,
                registered_expansion: { namespace: 'ranks', placeholders: [], cache: { kind: 'ttl', ms: 60001 } }
            }
        },
        {
            method: 'registerExpansion',
            args: [{ namespace: 'ranks' }],
            reply: {
                ok: true,
                registered_expansion: { namespace: 'ranks', placeholders: [], cache: { kind: 'ttl', ms: 0.5 } }
            }
        },
        { method: 'resolve', args: ['a'], reply: { ok: true, resolved: { text: 'a', unresolved: null } } },
        {
            method: 'resolve',
            args: ['a'],
            reply: { ok: true, resolved: { text: 'a', unresolved: [] }, value: { known: false } }
        }
    ];
    for (const { method, args, reply } of cases) {
        const c = client(reply);
        expect(() => Reflect.apply(c[method], c, args)).toThrow(api.ProtocolError);
    }
});
it('enforces the exact encoded message limit, including escaping overhead', () => {
    const request = {
        op: 'set_placeholders_batch',
        requests: Array.from({ length: 32 }, () => ({ text: 'x'.repeat(32768) }))
    } as const;
    expect(() => api.encodeRequest(request)).toThrow(api.InputError);
    const exact = {
        op: 'set_placeholders_batch' as const,
        requests: Array.from({ length: 31 }, () => ({ text: '\u0000'.repeat(5500) }))
    };
    // Establish exact size with ASCII padding within the final line's text limit.
    const padding = 1048576 - strToU8(JSON.stringify(exact)).length;
    exact.requests[30].text += 'x'.repeat(padding);
    expect(api.encodeRequest(exact)).toHaveLength(1048576);
    exact.requests[30].text += 'x';
    expect(() => api.encodeRequest(exact)).toThrow(api.InputError);
});
