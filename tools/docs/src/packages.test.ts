import { describe, expect, it } from 'vitest';
import { renderPackagesBlock } from './packages.ts';

describe('renderPackagesBlock', () => {
    it('makes one linked row per package, sorted by folder', () => {
        const out = renderPackagesBlock(
            [
                { dir: 'packages/b-plugin', name: 'BPlugin', description: 'B | pipes', license: 'MIT' },
                { dir: 'packages/a-plugin', name: 'APlugin', description: 'A', license: 'MIT' }
            ],
            [{ dir: 'tools/build', name: '@x/build', description: 'Builds', license: 'MIT' }],
            [
                { dir: 'actions/zeta', name: 'Zeta', description: 'Second action' },
                { dir: 'actions/alpha', name: 'Alpha', description: 'First action' }
            ]
        );
        const plugins = out.split('**Tools**')[0];
        expect(plugins.indexOf('[APlugin](packages/a-plugin)')).toBeLessThan(
            plugins.indexOf('[BPlugin](packages/b-plugin)')
        );
        expect(out).toContain('| Plugin | Description | License |');
        expect(out).toContain('| Package | Description | License |');
        expect(out).toContain('| Action | Description |');
        expect(out.indexOf('[Alpha](actions/alpha)')).toBeLessThan(out.indexOf('[Zeta](actions/zeta)'));
        expect(out).toContain('| [Alpha](actions/alpha) | First action |');
        expect(out).toContain('| [BPlugin](packages/b-plugin) | B \\| pipes | MIT |');
        expect(out).toContain('| [@x/build](tools/build) | Builds | MIT |');
    });

    it('links package-specific licenses for plugins and tools', () => {
        const out = renderPackagesBlock(
            [
                {
                    dir: 'packages/dh',
                    name: 'DH',
                    description: 'LOD',
                    license: 'LGPL-3.0-only',
                    licenseFile: 'packages/dh/LICENSE'
                }
            ],
            [
                {
                    dir: 'tools/helper',
                    name: 'Helper',
                    description: 'Helps',
                    license: 'MIT',
                    licenseFile: 'tools/helper/LICENSE.md'
                }
            ]
        );
        expect(out).toContain('| [DH](packages/dh) | LOD | [LGPL-3.0-only](packages/dh/LICENSE) |');
        expect(out).toContain('| [Helper](tools/helper) | Helps | [MIT](tools/helper/LICENSE.md) |');
    });
});
