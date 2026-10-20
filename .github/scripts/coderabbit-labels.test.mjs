// Tests the label catalog checks and CodeRabbit label generation against throwaway repositories.
// Run with `node --test .github/scripts/*.test.mjs`.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parse } from 'yaml';
import { syncCodeRabbitLabels, writeLabelManifest } from './coderabbit-labels.mjs';

const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const codeRabbitConfig = `# Top comment stays.
reviews:
    suggested_labels: true
    labeling_instructions:
        - label: stale
          instructions: Old text.
    mutually_exclusive_groups:
        status:
            - "status: blocked"
    # Comment after the generated block stays.
    auto_apply_labels: true
    poem: false
`;

const defaultLabels = [
    { name: 'bug', color: 'd73a4a', ai_apply_when: 'Fixes broken behavior.' },
    { name: 'question', color: 'd876e3' },
    {
        name: 'plugin: Waypoints',
        color: '8633aa',
        ai_apply_when: 'Changes specifically related to packages/waypoints/.',
    },
];

/**
 * Creates a repository with a label catalog, a CodeRabbit config and plugin packages.
 */
function repo({ labels = defaultLabels, packages = { waypoints: true } } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderabbit-labels-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.github'));
    fs.mkdirSync(path.join(dir, 'packages'));
    fs.writeFileSync(path.join(dir, '.github/labels.yml'), JSON.stringify(labels));
    fs.writeFileSync(path.join(dir, '.coderabbit.yaml'), codeRabbitConfig);
    for (const [name, isPlugin] of Object.entries(packages)) {
        fs.mkdirSync(path.join(dir, 'packages', name), { recursive: true });
        const manifest = { name, ...(isPlugin ? { pumpkinPlugin: { entry: 'src/plugin.ts' } } : {}) };
        fs.writeFileSync(path.join(dir, 'packages', name, 'package.json'), JSON.stringify(manifest));
    }
    return dir;
}

const readConfig = (dir) => fs.readFileSync(path.join(dir, '.coderabbit.yaml'), 'utf8');

describe('CodeRabbit label guidance', () => {
    it('writes instructions for labels with ai_apply_when and keeps the rest of the config', async () => {
        const dir = repo();
        assert.deepEqual(await syncCodeRabbitLabels({ root: dir }), { errors: [], changed: true });

        const text = readConfig(dir);
        assert.deepEqual(parse(text).reviews.labeling_instructions, [
            { label: 'bug', instructions: 'Fixes broken behavior.' },
            { label: 'plugin: Waypoints', instructions: 'Changes specifically related to packages/waypoints/.' },
        ]);
        assert.equal(parse(text).reviews.poem, false);
        assert.match(text, /# Top comment stays\./);
        assert.match(text, /# Comment after the generated block stays\./);
        assert.deepEqual(await syncCodeRabbitLabels({ root: dir, check: true }), { errors: [], changed: false });
    });

    it('reports stale guidance in check mode without writing', async () => {
        const dir = repo();
        const result = await syncCodeRabbitLabels({ root: dir, check: true });
        assert.equal(result.changed, true);
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0], /\.coderabbit\.yaml/);
        assert.equal(readConfig(dir), codeRabbitConfig);
    });

    it('rejects an invalid label catalog', async () => {
        const dir = repo({
            labels: [
                ...defaultLabels,
                { name: 'bug', color: 'ffffff' },
                { name: 'typo', color: 'ffffff', colour: 'ffffff' },
                { name: 'empty', color: 'ffffff', ai_apply_when: '' },
                { name: 'long', color: 'ffffff', ai_apply_when: 'x'.repeat(3001) },
            ],
        });
        const { errors } = await syncCodeRabbitLabels({ root: dir });
        assert.equal(errors.length, 4);
        assert.equal(readConfig(dir), codeRabbitConfig);
    });

    it('requires one plugin label per plugin package', async () => {
        const missing = repo({ packages: { waypoints: true, 'tab-display': true, 'shared-lib': false } });
        const { errors } = await syncCodeRabbitLabels({ root: missing });
        assert.equal(errors.length, 1);
        assert.match(errors[0], /packages\/tab-display/);

        const extra = repo({ packages: {} });
        assert.equal((await syncCodeRabbitLabels({ root: extra })).errors.length, 1);
    });

    it('writes a sync manifest without the CodeRabbit field', async () => {
        const dir = repo();
        const manifest = path.join(dir, 'manifest.yml');
        assert.deepEqual(await writeLabelManifest({ root: dir, file: manifest }), []);
        const labels = parse(fs.readFileSync(manifest, 'utf8'));
        assert.deepEqual(
            labels.map((label) => label.name),
            defaultLabels.map((label) => label.name),
        );
        assert.ok(labels.every((label) => !('ai_apply_when' in label)));
    });
});
