// Tests action README version updates against a throwaway repo. Run with `pnpm test:scripts`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'vitest';

const cli = path.join(import.meta.dirname, '../bin/pumpkin-plugins-docs.mjs');
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(
    actions: Record<string, { component: string; manifestVersion: string; releaseAs?: string; readmeVersion: string }>,
) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-action-readmes-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'actions'), { recursive: true });
    const packages: Record<string, unknown> = {};
    const manifest: Record<string, string> = {};

    for (const [name, action] of Object.entries(actions)) {
        const releasePath = `actions/${name}`;
        const actionDir = path.join(dir, releasePath);
        fs.mkdirSync(actionDir, { recursive: true });
        fs.writeFileSync(path.join(actionDir, 'action.yml'), 'name: Test action\n');
        fs.writeFileSync(path.join(actionDir, 'version.txt'), `${action.manifestVersion}\n`);
        fs.writeFileSync(
            path.join(actionDir, 'README.md'),
            `Use \`filiphsps/pumpkin-plugins/${releasePath}@${action.component}-v${action.readmeVersion}\`.\n`,
        );
        packages[releasePath] = {
            component: action.component,
            'release-type': 'simple',
            ...(action.releaseAs ? { 'release-as': action.releaseAs } : {}),
        };
        manifest[releasePath] = action.manifestVersion;
    }

    fs.writeFileSync(path.join(dir, 'release-please-config.json'), `${JSON.stringify({ packages }, null, 4)}\n`);
    fs.writeFileSync(path.join(dir, '.release-please-manifest.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    return dir;
}

function run(dir: string, check = false) {
    const result = spawnSync(process.execPath, [cli, 'action-versions', ...(check ? ['--check'] : [])], {
        cwd: dir,
        encoding: 'utf8',
    });
    return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

function readme(dir: string, name: string) {
    return fs.readFileSync(path.join(dir, 'actions', name, 'README.md'), 'utf8');
}

describe('action version CLI', { timeout: 15000 }, () => {
    it('updates every action using its own manifest or first-release pin', () => {
        const dir = repo({
            'publish-market': {
                component: 'publish-market',
                manifestVersion: '0.0.0',
                releaseAs: '0.0.1',
                readmeVersion: '0.0.0',
            },
            'another-action': {
                component: 'market-helper',
                manifestVersion: '1.2.3',
                readmeVersion: '1.0.0',
            },
        });

        const result = run(dir);
        assert.ok(result.ok, result.out);
        const generatedReadmes = {
            publishMarket: readme(dir, 'publish-market'),
            anotherAction: readme(dir, 'another-action'),
        };
        assert.match(generatedReadmes.publishMarket, /publish-market-v0\.0\.1/);
        assert.match(generatedReadmes.anotherAction, /market-helper-v1\.2\.3/);
    });

    it('is idempotent when all example tags already match', () => {
        const dir = repo({
            'publish-market': {
                component: 'publish-market',
                manifestVersion: '0.0.0',
                releaseAs: '0.0.1',
                readmeVersion: '0.0.1',
            },
        });

        const before = readme(dir, 'publish-market');
        const result = run(dir);
        assert.ok(result.ok, result.out);
        assert.equal(readme(dir, 'publish-market'), before);

        const checked = run(dir, true);
        assert.ok(checked.ok, checked.out);
        assert.equal(readme(dir, 'publish-market'), before);
    });

    it('checks stale action versions without writing the README', () => {
        const dir = repo({
            'publish-market': {
                component: 'publish-market',
                manifestVersion: '0.2.0',
                readmeVersion: '0.1.0',
            },
        });
        const before = readme(dir, 'publish-market');

        const result = run(dir, true);
        assert.equal(result.ok, false);
        assert.equal(readme(dir, 'publish-market'), before);
    });

    it('rejects an action README without a versioned example tag', () => {
        const dir = repo({
            'publish-market': {
                component: 'publish-market',
                manifestVersion: '0.1.0',
                readmeVersion: '0.0.1',
            },
        });
        fs.writeFileSync(path.join(dir, 'actions', 'publish-market', 'README.md'), 'No usage example.\n');

        const result = run(dir);
        assert.equal(result.ok, false);
        assert.equal(readme(dir, 'publish-market'), 'No usage example.\n');
    });
});
