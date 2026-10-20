import { expect, it } from 'vitest';
import { parseWitToolsJson, type WitToolsDocument } from './model.ts';
import { resolvePluginApi, resolveWitDocument } from './resolver.ts';

const document = {
    worlds: [
        { name: 'plugin', package: 0, imports: { 'interface-0': { interface: { id: 0 } } } },
        { name: 'unused', package: 1, imports: {} },
    ],
    interfaces: [
        {
            name: 'api',
            package: 0,
            types: { id: 0, payload: 1, stream: 2, externalAlias: 6 },
            functions: {
                ping: { name: 'ping', kind: 'freestanding', params: [{ name: 'value', type: 6 }], result: null },
                maybe: { name: 'maybe', kind: 'freestanding', params: [], result: 7 },
                '[constructor]stream': { name: '[constructor]stream', kind: { constructor: 2 }, params: [], result: 2 },
                '[method]stream.read': {
                    name: '[method]stream.read',
                    kind: { method: 2 },
                    params: [{ name: 'self', type: 3 }],
                    result: 4,
                },
            },
        },
        { name: 'types', package: 1, types: { external: 6 }, functions: {} },
    ],
    types: [
        { name: 'id', kind: { type: 'u32' }, owner: { interface: 0 } },
        { name: 'payload', kind: { record: { fields: [{ name: 'id', type: 0 }] } }, owner: { interface: 0 } },
        { name: 'stream', kind: 'resource', owner: { interface: 0 } },
        { name: null, kind: { handle: { borrow: 2 } }, owner: null },
        { name: null, kind: { list: 'u8' }, owner: null },
        { name: null, kind: { option: 'string' }, owner: null },
        { name: 'external', kind: { record: { fields: [] } }, owner: { interface: 1 } },
        { name: null, kind: { result: { ok: 4, err: null } }, owner: null },
    ],
    packages: [
        { name: 'example:api@1.0.0', interfaces: { api: 0 }, worlds: { plugin: 0 } },
        { name: 'example:types@1.0.0', interfaces: { types: 1 }, worlds: { unused: 1 } },
    ],
};

it('resolves type aliases, imported type names, records, and resource operation kinds', () => {
    const resolved = resolveWitDocument(parseWitToolsJson(JSON.stringify(document)));
    const apiPackage = resolved.packages.find(({ packageName }) => packageName === 'example:api');
    const api = apiPackage?.interfaces[0];

    expect(apiPackage?.version).toBe('1.0.0');
    expect(api?.types).toContainEqual(expect.objectContaining({ name: 'id', type: 'u32' }));
    expect(api?.types.find(({ name }) => name === 'id')?.resolvedType).toEqual({
        kind: 'primitive',
        name: 'u32',
        declaredInterface: 'api',
        aliasName: 'id',
    });
    expect(api?.records[0]?.fields[0]).toMatchObject({
        name: 'id',
        type: 'id',
        resolvedType: { kind: 'primitive', name: 'u32', aliasName: 'id' },
    });
    expect(api?.dependencies).toEqual(['example:types/types@1.0.0']);
    expect(api?.dependencyAliases?.externalAlias).toEqual({
        name: 'external',
        specifier: 'example:types/types@1.0.0',
    });
    expect(api?.functions[0]?.parameters[0]?.resolvedType).toMatchObject({ kind: 'record', name: 'external' });
    expect(api?.resources[0]?.functions.map(({ name, isStatic }) => [name, isStatic])).toEqual([
        ['constructor', false],
        ['read', false],
    ]);
    expect(api?.resources[0]?.functions[1]?.parameters).toEqual([]);
    expect(api?.resources[0]?.functions[1]?.result).toBe('list<u8>');
    expect(api?.resources[0]?.functions[0]?.result).toBe('');
    expect(api?.functions.find(({ name }) => name === 'maybe')?.result).toBe('result<list<u8>>');
    expect(resolvePluginApi(resolved).interfaces.map(({ name }) => name)).toEqual(['api', 'types']);
});

it('retains the owner of anonymous containers nested in imported records', () => {
    const nestedTypes = structuredClone(document) as unknown as WitToolsDocument;
    const apiInterface = nestedTypes.interfaces[0];
    const typeInterface = nestedTypes.interfaces[1];
    if (!apiInterface || !typeInterface) throw new Error('WIT test document is missing an interface');
    const ping = apiInterface.functions.ping;
    if (!ping) throw new Error('WIT test API interface has no ping function');
    Object.assign(apiInterface.types, { importedRecord: 8 });
    Object.assign(typeInterface.types, { importedRecord: 8 });
    ping.params.splice(0, 1, { name: 'value', type: 8 });
    nestedTypes.types.push(
        {
            name: 'imported-record',
            kind: { record: { fields: [{ name: 'items', type: 9 }] } },
            owner: { interface: 1 },
        },
        { name: null, kind: { list: 6 }, owner: null },
    );

    const resolved = resolveWitDocument(parseWitToolsJson(JSON.stringify(nestedTypes)));
    const api = resolved.packages.find(({ packageName }) => packageName === 'example:api')?.interfaces[0];
    const container = api?.functions.find(({ name }) => name === 'ping')?.parameters[0]?.resolvedType;

    expect(container).toMatchObject({
        kind: 'record',
        fields: [
            {
                name: 'items',
                resolvedType: {
                    kind: 'list',
                    packageName: 'example:types',
                    declaredInterface: 'types',
                    interfaceSpecifier: 'example:types/types@1.0.0',
                },
            },
        ],
    });
});

it('retains names for direct list aliases referenced by operations', () => {
    const withListAlias = parseWitToolsJson(JSON.stringify(document));
    const api = withListAlias.interfaces[0];
    if (!api) throw new Error('WIT test document has no API interface');
    api.types.bytes = 8;
    api.functions.consume = {
        name: 'consume',
        kind: 'freestanding',
        params: [{ name: 'value', type: 8 }],
        result: null,
        features: [],
    };
    withListAlias.types.push({ name: 'bytes', kind: { list: 'u8' }, owner: { interface: 0 } });
    const resolved = resolveWitDocument(parseWitToolsJson(JSON.stringify(withListAlias)));
    const parameter = resolved.interfaces[0]?.functions.find(({ name }) => name === 'consume')?.parameters[0];

    expect(parameter?.resolvedType).toEqual({
        kind: 'list',
        item: { kind: 'primitive', name: 'u8' },
        declaredInterface: 'api',
        aliasName: 'bytes',
        packageName: 'example:api',
        interfaceSpecifier: 'example:api/api@1.0.0',
    });
});

it('rejects cyclic type aliases with the involved WIT type name', () => {
    const cyclic = structuredClone(document);
    Object.assign(cyclic.interfaces[0]?.types, { first: 8, second: 9 });
    Reflect.set(cyclic.types, 8, { name: 'first', kind: { type: 9 }, owner: { interface: 0 } });
    Reflect.set(cyclic.types, 9, { name: 'second', kind: { type: 8 }, owner: { interface: 0 } });

    expect(() => resolveWitDocument(parseWitToolsJson(JSON.stringify(cyclic)))).toThrow(/Cyclic WIT type alias/);
});

it('uses source declaration order for declarations stored in unordered JSON maps', () => {
    const ordered = structuredClone(document);
    Object.assign(ordered.interfaces[0]?.types, { 'z-record': 8, 'a-record': 9 });
    ordered.types.push(
        { name: 'z-record', kind: { record: { fields: [] } }, owner: { interface: 0 } },
        { name: 'a-record', kind: { record: { fields: [] } }, owner: { interface: 0 } },
    );
    const resolved = resolveWitDocument(
        parseWitToolsJson(JSON.stringify(ordered)),
        new Map([
            [
                'example:api/api@1.0.0',
                {
                    resources: ['stream'],
                    records: ['z-record', 'a-record'],
                    variants: [],
                    enums: [],
                    flags: [],
                    types: ['id'],
                    escapedNames: [],
                },
            ],
        ]),
    );

    expect(resolved.interfaces[0]?.records.map(({ name }) => name)).toEqual(['z-record', 'a-record', 'payload']);
});
