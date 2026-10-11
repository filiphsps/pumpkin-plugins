import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverComponents, walkMarkdown } from './discovery.ts';

it('discovers sorted components by metadata and walks Markdown with explicit exclusions', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-discovery-'));
    function put(file: string) {
        const target = join(root, file);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, '');
    }
    try {
        put('tools/z/package.json');
        put('tools/a/package.json');
        put('tools/_scratch/package.json');
        put('tools/other/README.md');
        put('actions/y/action.yaml');
        put('actions/x/action.yml');
        put('docs/index.md');
        put('docs/nested/guide.md');
        put('docs/api/generated.md');
        put('docs/node_modules/hidden.md');
        expect(discoverComponents(root, 'tools').map((item) => item.slug)).toEqual(['a', 'z']);
        expect(discoverComponents(root, 'actions').map((item) => item.slug)).toEqual(['x', 'y']);
        expect(discoverComponents(root, 'packages')).toEqual([]);
        expect(walkMarkdown(join(root, 'docs'), { exclude: [join(root, 'docs/api')] })).toEqual([
            join(root, 'docs/index.md'),
            join(root, 'docs/nested/guide.md')
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
