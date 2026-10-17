import { describe, expect, it } from 'vitest';
import { renderPackagesBlock } from './packages.ts';

describe('renderPackagesBlock', () => {
    it('makes one linked row per package, sorted by folder', () => {
        const out = renderPackagesBlock(
            [
                { dir: 'packages/b-plugin', name: 'BPlugin', description: 'B | pipes', license: 'MIT' },
                { dir: 'packages/a-plugin', name: 'APlugin', description: 'A', license: 'MIT' },
            ],
            [{ dir: 'tools/build', name: '@x/build', description: 'Builds', license: 'MIT' }],
            [
                { dir: 'actions/zeta', name: 'Zeta', description: 'Second action' },
                { dir: 'actions/alpha', name: 'Alpha', description: 'First action' },
            ],
            [
                {
                    dir: 'extensions/minecraft-terms',
                    name: 'Minecraft Terms',
                    description: 'Minecraft vocabulary.',
                    license: 'MIT',
                },
            ],
        );
        const plugins = out.split('**Tools**')[0];
        expect(plugins.indexOf('[APlugin](packages/a-plugin)')).toBeLessThan(
            plugins.indexOf('[BPlugin](packages/b-plugin)'),
        );
        expect(out).toContain('| Plugin | Description | License |');
        expect(out).toContain('| Package | Description | License |');
        expect(out).toContain('| Action | Description |');
        expect(out).toContain('| Extension | Description | License |');
        expect(out).toContain('| [Minecraft Terms](extensions/minecraft-terms) | Minecraft vocabulary. | MIT |');
        expect(out.indexOf('[Alpha](actions/alpha)')).toBeLessThan(out.indexOf('[Zeta](actions/zeta)'));
        expect(out).toContain('| [Alpha](actions/alpha) | First action |');
        expect(out).toContain('| [BPlugin](packages/b-plugin) | B \\| pipes | MIT |');
        expect(out).toContain('| [@x/build](tools/build) | Builds | MIT |');
    });
});
