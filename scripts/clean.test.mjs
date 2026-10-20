import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanWorkspace } from './clean.mjs';

const temporaryRoots = [];
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('cleanWorkspace', () => {
    it('removes outputs of every workspace package while preserving unrelated files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-clean-'));
        temporaryRoots.push(root);

        const files = {
            'extensions/minecraft-terms/package.json': '{}',
            'benchmarks/engine-comparison/package.json': '{}',
            'tools/apis/pumpkin-pie-api/package.json': '{}',
            'extensions/minecraft-terms/dist/extension.js': 'generated extension',
            'tools/apis/pumpkin-pie-api/dist/index.js': 'generated api',
            'tools/apis/pumpkin-pie-api/.turbo/cache/task.tar.zst': 'cached task',
            'benchmarks/engine-comparison/build/engine-comparison/report.json': 'generated benchmark',
            'extensions/minecraft-terms/src/extension.ts': 'extension source',
            'benchmarks/engine-comparison/results/manual.json': 'user result',
            '.cache/pumpkin/user-config.json': 'user config',
        };

        for (const [relativePath, contents] of Object.entries(files)) {
            const filePath = path.join(root, relativePath);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, contents);
        }

        cleanWorkspace(root);

        assert.equal(fs.existsSync(path.join(root, 'extensions/minecraft-terms/dist')), false);
        assert.equal(fs.existsSync(path.join(root, 'benchmarks/engine-comparison/build')), false);
        assert.equal(fs.existsSync(path.join(root, 'tools/apis/pumpkin-pie-api/dist')), false);
        assert.equal(fs.existsSync(path.join(root, 'tools/apis/pumpkin-pie-api/.turbo/cache')), false);
        assert.equal(
            fs.readFileSync(path.join(root, 'extensions/minecraft-terms/src/extension.ts'), 'utf8'),
            'extension source',
        );
        assert.equal(
            fs.readFileSync(path.join(root, 'benchmarks/engine-comparison/results/manual.json'), 'utf8'),
            'user result',
        );
        assert.equal(fs.readFileSync(path.join(root, '.cache/pumpkin/user-config.json'), 'utf8'), 'user config');
    });

    it('runs from a workspace without node_modules, as after pnpm purge', () => {
        // The script runs its CLI only when argv[1] matches its real path, and macOS links the temp folder.
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-clean-')));
        temporaryRoots.push(root);
        for (const file of ['scripts/clean.mjs', 'tools/docs/src/discovery.ts']) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.copyFileSync(path.join(workspaceRoot, file), path.join(root, file));
        }
        fs.mkdirSync(path.join(root, 'packages/example/dist'), { recursive: true });
        fs.writeFileSync(path.join(root, 'packages/example/package.json'), '{}');

        const result = spawnSync(process.execPath, [path.join(root, 'scripts/clean.mjs')], { encoding: 'utf8' });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(path.join(root, 'packages/example/dist')), false);
        assert.equal(fs.existsSync(path.join(root, 'packages/example/package.json')), true);
    });
});
