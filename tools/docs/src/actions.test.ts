// Tests generation and drift checks for action README inputs and outputs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';

const script = path.join(import.meta.dirname, '../bin/pumpkin-plugins-docs.mjs');
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(actions: Record<string, { action: string; readme: string }>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-action-readmes-'));
    dirs.push(root);
    const actionsRoot = path.join(root, 'actions');
    fs.mkdirSync(actionsRoot);
    for (const [name, { action, readme }] of Object.entries(actions)) {
        const actionDir = path.join(actionsRoot, name);
        fs.mkdirSync(actionDir);
        fs.writeFileSync(path.join(actionDir, 'action.yml'), action);
        fs.writeFileSync(path.join(actionDir, 'README.md'), readme);
    }
    return root;
}

function run(root: string, check = false) {
    const result = spawnSync(process.execPath, [script, 'actions', ...(check ? ['--check'] : [])], {
        cwd: root,
        encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function readme(root: string, name: string) {
    return fs.readFileSync(path.join(root, 'actions', name, 'README.md'), 'utf8');
}

const markers =
    '## Inputs\n\n<!-- action-inputs:start -->\nstale input docs\n<!-- action-inputs:end -->\n\n## Outputs\n\n<!-- action-outputs:start -->\nstale output docs\n<!-- action-outputs:end -->\n';

describe('action README CLI', { timeout: 15000 }, () => {
    it('generates input and output tables from each action.yml', () => {
        const root = repo({
            'market-action': {
                action: 'name: Market action\ninputs:\n  plugin-id:\n    description: Public or numeric ID\n    required: false\n  update-mode:\n    description: Update mode\n    required: false\n    default: patch\noutputs:\n  listing-id:\n    description: Resolved numeric ID\n',
                readme: markers,
            },
            'no-output': {
                action: 'name: No output action\ninputs:\n  value:\n    description: Value input\n    required: true\n',
                readme: markers,
            },
        });

        const result = run(root);
        assert.equal(result.status, 0, result.output);
        const market = readme(root, 'market-action');
        const noOutput = readme(root, 'no-output');
        assert.match(market, /\| `plugin-id` \| No \| {2}\| Public or numeric ID \|/);
        assert.match(market, /\| `update-mode` \| No \| `patch` \| Update mode \|/);
        assert.match(market, /\| `listing-id` \| Resolved numeric ID \|/);
        assert.match(noOutput, /\| `value` \| Yes \| {2}\| Value input \|/);
        assert.match(noOutput, /This action has no outputs\./);
    });

    it('checks for drift without modifying the README', () => {
        const root = repo({
            action: {
                action: 'name: Test\noutputs:\n  result:\n    description: Result value\n',
                readme: markers,
            },
        });
        const before = readme(root, 'action');

        const stale = run(root, true);
        assert.equal(stale.status, 1);
        assert.equal(readme(root, 'action'), before);

        const generated = run(root);
        assert.equal(generated.status, 0, generated.output);
        const generatedReadme = readme(root, 'action');
        assert.match(generatedReadme, /\| `result` \| Result value \|/);
        const unchanged = run(root, true);
        assert.equal(unchanged.status, 0);
        assert.equal(readme(root, 'action'), generatedReadme);
    });

    it('fails when an action README has no generated-section markers', () => {
        const root = repo({ action: { action: 'name: Test\n', readme: '# Test\n' } });
        const before = readme(root, 'action');
        const result = run(root);
        assert.equal(result.status, 1);
        assert.equal(readme(root, 'action'), before);
    });
});
