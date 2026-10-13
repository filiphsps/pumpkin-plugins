import { expect, it } from 'vitest';
import { generateWitEventDispatch } from '../src/wit/event-dispatch.ts';
import type { WitApiPackage } from '../src/wit/types.ts';

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
                                resolvedType: { kind: 'unsupported', source: 'future-value' }
                            }
                        ]
                    }
                ],
                variants: [{ name: 'event', cases: [{ name: 'custom-event', type: 'event-data' }] }],
                enums: [],
                flags: [],
                types: []
            }
        ]
    };

    expect(() =>
        generateWitEventDispatch(apiPackage, '', [{ event: 'custom-event', record: 'event-data', fields: ['value'] }])
    ).toThrow('future-value');
});

it.each([
    '"custom-event"; const { location: { x } } = data;',
    '"custom-event"; const copy = { ...data.location };',
    '"custom-event"; data.location[field];'
])('preserves nested record fields for JavaScript access: %s', (bundleSource) => {
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
                                        { name: 'y', type: 'f64', resolvedType: { kind: 'primitive', name: 'f64' } }
                                    ]
                                }
                            }
                        ]
                    }
                ]
            }
        ]
    };
    const dispatch = generateWitEventDispatch(apiPackage, bundleSource, [
        { event: 'custom-event', record: 'event-data', fields: ['location'] }
    ]);
    expect(dispatch).toContain('setProperty(runtime, "x", Value(eventData.location.x))');
    expect(dispatch).toContain('setProperty(runtime, "y", Value(eventData.location.y))');
});
