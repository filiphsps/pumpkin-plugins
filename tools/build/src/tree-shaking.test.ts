import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import { bundlePlugin } from './bundle.ts';

const dirs: string[] = [];
const componentize = vi.mocked(execFileSync);

afterEach(() => {
    vi.clearAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('production tree shaking', () => {
    it('removes unused exports and development-only branches from plugin bundles', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-tree-shaking-'));
        dirs.push(dir);
        const entry = path.join(dir, 'plugin.ts');
        const dependency = path.join(dir, 'dependency.ts');
        const output = path.join(dir, 'plugin.wasm');
        fs.writeFileSync(
            dependency,
            "export const usedValue = 'PUMPKIN_USED_SENTINEL';\nexport const unusedValue = 'PUMPKIN_UNUSED_SENTINEL';\n",
        );
        fs.writeFileSync(
            entry,
            "import { usedValue } from './dependency.ts';\nif (process.env.NODE_ENV !== 'production') throw new Error('PUMPKIN_DEV_ONLY_SENTINEL');\nexport const value = usedValue;\n",
        );

        let bundledSource = '';
        componentize.mockImplementation((_file, args) => {
            const bundleIndex = args?.indexOf('--js') ?? -1;
            const outputIndex = args?.indexOf('--output') ?? -1;
            const bundle = args?.[bundleIndex + 1];
            const component = args?.[outputIndex + 1];
            if (!bundle || !component) throw new Error('missing componentizer paths');
            bundledSource = fs.readFileSync(bundle, 'utf8');
            fs.writeFileSync(component, 'component');
            return Buffer.alloc(0);
        });

        await bundlePlugin({ entry, output, witDir: 'wit', version: '1.0.0', engine: 'quickjs' });

        expect(bundledSource).toContain('PUMPKIN_USED_SENTINEL');
        expect(bundledSource).not.toContain('PUMPKIN_UNUSED_SENTINEL');
        expect(bundledSource).not.toContain('PUMPKIN_DEV_ONLY_SENTINEL');
    });
});
