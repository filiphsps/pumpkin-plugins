import { describe, expect, expectTypeOf, it } from 'vitest';
import { type PermissionInfo, type PluginInfo, pluginMetadata, pluginPermissions } from './info.ts';
import { isPumpkinPermission, PUMPKIN_PERMISSIONS, type PumpkinPermission } from './permissions.ts';

describe('isPumpkinPermission', () => {
    it('knows every listed permission and single environment variables', () => {
        for (const name of PUMPKIN_PERMISSIONS) expect(isPumpkinPermission(name)).toBe(true);
        expect(isPumpkinPermission('sys.env.PATH')).toBe(true);
    });

    it('rejects the rest', () => {
        for (const name of ['', 'fs.read', 'fs.read.data ', 'sys.env.', 'network.tcp.bnd', 'Plugin:command'])
            expect(isPumpkinPermission(name)).toBe(false);
    });
});

describe('types', () => {
    it('make the permission names of an info a literal union', () => {
        const info = {
            name: 'Demo',
            description: 'd',
            permissions: [
                { name: 'fs.read.data', reason: 'a' },
                { name: 'network.tcp.bind', reason: 'b' }
            ]
        } satisfies PluginInfo<'Demo'>;
        expectTypeOf<(typeof info.permissions)[number]['name']>().toEqualTypeOf<'fs.read.data' | 'network.tcp.bind'>();
        expectTypeOf<PermissionInfo['name']>().toEqualTypeOf<PumpkinPermission>();
    });

    it('reject a permission Pumpkin does not know', () => {
        const info: PluginInfo = {
            name: 'Demo',
            description: 'd',
            // @ts-expect-error a typo in the permission name
            permissions: [{ name: 'network.tcp.bnd', reason: 'x' }]
        };
        expect(info.name).toBe('Demo');
    });
});

describe('automatic update permission', () => {
    it('adds the outbound HTTP permission to plugin metadata and docs', () => {
        const info: PluginInfo<'Demo'> = { name: 'Demo', description: 'd' };
        expect(pluginPermissions(info).map(({ name }) => name)).toEqual(['http.outbound']);
        expect(pluginMetadata(info, '1.0.0').permissions).toEqual(['http.outbound']);
    });

    it('does not duplicate a manually declared outbound HTTP permission', () => {
        const info: PluginInfo<'Demo'> = {
            name: 'Demo',
            description: 'd',
            permissions: [{ name: 'http.outbound', reason: 'Use an external HTTP service.' }]
        };
        expect(pluginPermissions(info)).toHaveLength(1);
    });
});
