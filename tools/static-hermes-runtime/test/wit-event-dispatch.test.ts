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
