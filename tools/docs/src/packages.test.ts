import { describe, expect, it } from 'vitest';
import { renderPackagesBlock } from './packages.ts';

describe('renderPackagesBlock', () => {
    it('makes one linked row per package, sorted by folder', () => {
        const out = renderPackagesBlock(
            [
                { dir: 'packages/b-plugin', name: 'BPlugin', description: 'B | pipes' },
                { dir: 'packages/a-plugin', name: 'APlugin', description: 'A' }
            ],
            [{ dir: 'tools/build', name: '@x/build', description: 'Builds' }]
        );
        const plugins = out.split('**Tools**')[0];
        expect(plugins.indexOf('[APlugin](packages/a-plugin)')).toBeLessThan(
            plugins.indexOf('[BPlugin](packages/b-plugin)')
        );
        expect(out).toContain('| [BPlugin](packages/b-plugin) | B \\| pipes |');
        expect(out).toContain('| [@x/build](tools/build) | Builds |');
    });
});
