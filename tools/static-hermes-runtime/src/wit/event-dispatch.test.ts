import { expect, it } from 'vitest';
import { generateWitEventDispatch, generateWitEventResultDispatch } from './event-dispatch.ts';
import type { WitApiPackage } from './types.ts';

it('reports the source of an unsupported resolved event field type', () => {
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        interfaces: [
            {
                name: 'event',
                specifier: 'pumpkin:plugin/event@0.1.0',
                functions: [],
                resources: [],
                records: [
                    {
                        name: 'event-data',
                        fields: [
                            {
                                name: 'value',
                                type: 'future-value',
                                resolvedType: { kind: 'unsupported', source: 'future-value' },
                            },
                        ],
                    },
                ],
                variants: [{ name: 'event', cases: [{ name: 'custom-event', type: 'event-data' }] }],
                enums: [],
                flags: [],
                types: [],
            },
        ],
    };

    expect(() =>
        generateWitEventDispatch(apiPackage, [{ event: 'custom-event', record: 'event-data', fields: ['value'] }]),
    ).toThrow('future-value');
});

it('preserves every nested record field for JavaScript access', () => {
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        interfaces: [
            {
                name: 'event',
                specifier: 'pumpkin:plugin/event@0.1.0',
                functions: [],
                resources: [],
                enums: [],
                flags: [],
                types: [],
                variants: [{ name: 'event', cases: [{ name: 'custom-event', type: 'event-data' }] }],
                records: [
                    {
                        name: 'event-data',
                        fields: [
                            {
                                name: 'location',
                                type: 'position',
                                resolvedType: {
                                    kind: 'record',
                                    name: 'position',
                                    interfaceName: 'event',
                                    packageName: 'pumpkin:plugin',
                                    interfaceSpecifier: 'pumpkin:plugin/event@0.1.0',
                                    interfaceDependencies: [],
                                    fields: [
                                        { name: 'x', type: 'f64', resolvedType: { kind: 'primitive', name: 'f64' } },
                                        { name: 'y', type: 'f64', resolvedType: { kind: 'primitive', name: 'f64' } },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };
    const dispatch = generateWitEventDispatch(apiPackage, [
        { event: 'custom-event', record: 'event-data', fields: ['location'] },
    ]);
    expect(dispatch).toContain('setProperty(runtime, "x", Value(eventData.location.x))');
    expect(dispatch).toContain('setProperty(runtime, "y", Value(eventData.location.y))');
});

it('transfers returned event allocations to Pumpkin instead of freeing them on scope exit', () => {
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        interfaces: [
            {
                name: 'event',
                specifier: 'pumpkin:plugin/event@0.1.0',
                functions: [],
                resources: [],
                records: [
                    {
                        name: 'server-command-event-data',
                        fields: [
                            { name: 'command', type: 'string', resolvedType: { kind: 'primitive', name: 'string' } },
                            { name: 'cancelled', type: 'bool', resolvedType: { kind: 'primitive', name: 'bool' } },
                        ],
                    },
                ],
                variants: [
                    {
                        name: 'event',
                        cases: [
                            {
                                name: 'server-command-event',
                                type: 'server-command-event-data',
                                resolvedType: {
                                    kind: 'record',
                                    name: 'server-command-event-data',
                                    interfaceName: 'event',
                                    packageName: 'pumpkin:plugin',
                                    interfaceSpecifier: 'pumpkin:plugin/event@0.1.0',
                                    interfaceDependencies: [],
                                    fields: [
                                        {
                                            name: 'command',
                                            type: 'string',
                                            resolvedType: { kind: 'primitive', name: 'string' },
                                        },
                                        {
                                            name: 'cancelled',
                                            type: 'bool',
                                            resolvedType: { kind: 'primitive', name: 'bool' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
                enums: [],
                flags: [],
                types: [],
            },
        ],
    };

    const dispatch = generateWitEventResultDispatch(apiPackage, [
        { event: 'server-command-event', record: 'server-command-event-data', fields: ['command', 'cancelled'] },
    ]);

    const transfer = dispatch.indexOf('*ret = returnedEvent;');
    const release = dispatch.indexOf('returnedEventCleanup.release();');
    expect(transfer).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(transfer);
});
