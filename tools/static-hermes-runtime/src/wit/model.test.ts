import { expect, it } from 'vitest';
import { parseWitToolsJson } from './model.ts';

const document = {
    worlds: [
        {
            name: 'plugin',
            imports: {
                'interface-0': { interface: { id: 0 } },
                context: { type: 0 },
            },
            exports: {},
            package: 0,
        },
    ],
    interfaces: [
        {
            name: 'api',
            types: { payload: 0, state: 1, mode: 2, options: 3, response: 4, bytes: 5 },
            functions: {
                read: {
                    name: '[method]stream.read',
                    kind: { method: 7 },
                    params: [{ name: 'self', type: 7 }],
                    result: 4,
                    stability: { stable: { since: '1.0.0' } },
                },
                create: {
                    name: '[constructor]stream',
                    kind: { constructor: 7 },
                    params: [],
                    result: 6,
                },
                parse: { name: 'parse', kind: 'freestanding', params: [{ name: 'bytes', type: 5 }] },
            },
            package: 0,
        },
    ],
    types: [
        { name: 'payload', kind: { record: { fields: [{ name: 'data', type: 5 }] } }, owner: { interface: 0 } },
        {
            name: 'state',
            kind: {
                variant: {
                    cases: [
                        { name: 'ready', type: null },
                        { name: 'failed', type: 4 },
                    ],
                },
            },
            owner: { interface: 0 },
        },
        { name: 'mode', kind: { enum: { cases: [{ name: 'fast' }, { name: 'safe' }] } }, owner: { interface: 0 } },
        { name: 'options', kind: { flags: { flags: [{ name: 'read' }, { name: 'write' }] } }, owner: { interface: 0 } },
        { name: null, kind: { result: { ok: 5, err: 'string' } }, owner: null },
        { name: null, kind: { list: 'u8' }, owner: null },
        { name: null, kind: { tuple: { types: [0, 5] } }, owner: null },
        { name: 'stream', kind: 'resource', owner: { interface: 0 } },
        { name: null, kind: { handle: { borrow: 7 } }, owner: null },
    ],
    packages: [{ name: 'example:api@1.0.0', interfaces: { api: 0 }, worlds: { plugin: 0 } }],
};

it('decodes resolved WIT type forms and resource operation kinds', () => {
    const parsed = parseWitToolsJson(JSON.stringify(document));

    expect(parsed.packages[0]?.name).toBe('example:api@1.0.0');
    expect(parsed.worlds[0]?.imports['interface-0']).toEqual({ interface: { id: 0 } });
    expect(parsed.worlds[0]?.imports.context).toEqual({ type: 0 });
    expect(parsed.interfaces[0]?.functions.read?.kind).toEqual({ method: 7 });
    expect(parsed.interfaces[0]?.functions.create?.kind).toEqual({ constructor: 7 });
    expect(parsed.types.map((type) => (typeof type.kind === 'string' ? type.kind : Object.keys(type.kind)[0]))).toEqual(
        ['record', 'variant', 'enum', 'flags', 'result', 'list', 'tuple', 'resource', 'handle'],
    );
});

it('rejects a type reference outside the resolved type table', () => {
    const invalid = structuredClone(document);
    const readFunction = invalid.interfaces[0]?.functions.read;
    const firstParameter = readFunction?.params[0];
    if (!firstParameter) throw new Error('WIT fixture is missing the read function parameter');
    firstParameter.type = 99;

    expect(() => parseWitToolsJson(JSON.stringify(invalid))).toThrow('WIT JSON type reference 99 is out of range');
});

it('rejects an unsupported WIT type kind with its type name', () => {
    const invalid = structuredClone(document);
    const firstType = invalid.types[0];
    if (!firstType) throw new Error('WIT fixture is missing its first type');
    Reflect.set(firstType, 'kind', { future: 'u32' });

    expect(() => parseWitToolsJson(JSON.stringify(invalid))).toThrow(
        'Unsupported WIT JSON type kind "future" for payload',
    );
});
