import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { cleanWorkspace } from './clean.mjs';

const temporaryRoots = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('cleanWorkspace', () => {
    it('removes extension and benchmark outputs while preserving unrelated files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-clean-'));
        temporaryRoots.push(root);

        const files = {
            'extensions/minecraft-terms/dist/extension.js': 'generated extension',
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
});
