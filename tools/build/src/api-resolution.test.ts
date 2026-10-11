import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { bundlePlugin } from './bundle.ts';
import { run } from './cli.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const dirs: string[] = [];
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-code-'));
    dirs.push(dir);
    const api = path.join(dir, 'api');
    fs.mkdirSync(path.join(api, 'wit/v0.1'), { recursive: true });
    fs.writeFileSync(
        path.join(api, 'package.json'),
        JSON.stringify({ name: '@pumpkinmc/pumpkin-api-ts', main: 'index.ts' })
    );
    fs.writeFileSync(path.join(api, 'index.ts'), 'export function onlySelectedAPI() { return 42; }');
    fs.writeFileSync(path.join(api, 'wit/v0.1/plugin.wit'), 'world plugin {}');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', pumpkinPlugin: { wasi: [] } }));
    vi.stubEnv('PUMPKIN_API_TARGET', 'release');
    vi.stubEnv('PUMPKIN_API_ENTRY', undefined);
    vi.stubEnv('PUMPKIN_API_DIR', api);
    vi.stubEnv('PUMPKIN_WIT_DIR', path.join(api, 'wit/v0.1'));
    return { dir, api };
}
it('bundles the selected API helper even when the fixture has no installed API dependency', async () => {
    const { dir, api } = fixture();
    const entry = path.join(dir, 'plugin.ts');
    const output = path.join(dir, 'plugin.mjs');
    fs.writeFileSync(
        entry,
        "import { onlySelectedAPI } from '@pumpkinmc/pumpkin-api-ts'; export const result = onlySelectedAPI();"
    );
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
        if (!args) throw new Error('missing arguments');
        const bundle = args[args.indexOf('--js') + 1];
        const component = args[args.indexOf('--output') + 1];
        fs.copyFileSync(bundle, component);
        return Buffer.alloc(0);
    });
    await bundlePlugin({ entry, output, witDir: 'wit', version: '1.0.0', apiEntry: path.join(api, 'index.ts') });
    expect((await import(pathToFileURL(output).href)).result).toBe(42);
});
it('generates a TypeScript API forwarding module from the same selected checkout', async () => {
    const { dir } = fixture();
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
        if (!args) throw new Error('missing arguments');
        fs.writeFileSync(path.join(args[args.indexOf('-o') + 1], 'index.d.ts'), '');
        return Buffer.alloc(0);
    });
    await run(['--types-only'], dir);
    const source = path.join(dir, 'consumer.ts');
    fs.writeFileSync(
        source,
        "import { onlySelectedAPI } from '@pumpkinmc/pumpkin-api-ts'; const result: number = onlySelectedAPI();"
    );
    const program = ts.createProgram([source], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: [],
        paths: { '@pumpkinmc/pumpkin-api-ts': [path.join(dir, 'build/types/api.ts')] }
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual(
        []
    );
});
