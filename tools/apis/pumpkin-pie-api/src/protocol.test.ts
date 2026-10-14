import { strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { PieClient } from './client.ts';
import {
    decodeCallback,
    decodeJson,
    decodeResult,
    encodeCallbackReply,
    InputError,
    type OperationResults,
    type PlaceholderValue,
    ProtocolError,
    type Request,
    type ResolvedLine,
    type ResultFor,
} from './protocol.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Associations = [
    Expect<Equal<ResultFor<{ op: 'set_placeholders'; text: string }>, ResolvedLine>>,
    Expect<Equal<ResultFor<{ op: 'get_placeholder_value'; id: string }>, PlaceholderValue>>,
    Expect<
        Equal<ResultFor<{ op: 'on_request'; namespace: string; name: string; id: string }>, { readonly value?: string }>
    >,
    Expect<Equal<ResultFor<Request>, OperationResults[Request['op']]>>,
];
const associations: Associations = [true, true, true, true];
it('keeps request/result associations and rejects invalid public arguments at compile time', () => {
    expect(associations.every(Boolean)).toBe(true);
    const check = (client: PieClient) => {
        // @ts-expect-error viewer context is a player name, not a number
        client.resolve('text', 42);
        // @ts-expect-error batch lines require text
        client.resolveBatch([{ viewer: 'Steve' }]);
        // @ts-expect-error cache TTL must be numeric
        client.registerExpansion({ namespace: 'ranks', cache: { kind: 'ttl', ms: '1000' } });
        // @ts-expect-error arguments are text
        client.getValue('id', 'Steve', []);
    };
    void check;
});
it('decodes scalar Unicode and rejects malformed UTF-8 in every byte range', () => {
    expect(decodeJson(strToU8('"ö😀"'))).toBe('ö😀');
    for (const bytes of [
        [0x80],
        [0xc2],
        [0xe0, 0x80, 0x80],
        [0xe2, 0x28, 0xa1],
        [0xf0, 0x80, 0x80, 0x80],
        [0xf5, 0x80, 0x80, 0x80],
    ])
        expect(() => decodeJson(new Uint8Array(bytes))).toThrow(ProtocolError);
});
it('accepts exact message size with additive fields and rejects an extra byte', () => {
    const prefix = '{"ok":true,"value":{"known":false},"extra":"';
    const suffix = '"}';
    const bytes = strToU8(prefix + 'x'.repeat(1048576 - prefix.length - suffix.length) + suffix);
    expect(decodeResult(bytes, { op: 'get_placeholder_value', id: 'unknown' })).toEqual({ known: false });
    expect(() => decodeResult(new Uint8Array(1048577), { op: 'ping' })).toThrow(ProtocolError);
});
it('round trips callback replies with known empty values and declines', () => {
    const request = decodeCallback(
        strToU8('{"op":"on_request","namespace":"waypoints","id":"waypoints_count","name":"count","viewer":"Steve"}'),
    );
    expect(decodeResult(encodeCallbackReply(), request)).toEqual({});
    expect(decodeResult(encodeCallbackReply(''), request)).toEqual({ value: '' });
    expect(() => encodeCallbackReply('x'.repeat(32769))).toThrow(ProtocolError);
    expect(() => new PieClient(() => new Uint8Array()).registerExpansion({ namespace: 'player' })).toThrow(InputError);
});
