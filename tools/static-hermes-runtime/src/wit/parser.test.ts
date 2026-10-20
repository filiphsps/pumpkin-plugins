import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readInterfaceDeclarationOrder, readWitToolsDocument } from './parser.ts';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('parses wasm-tools JSON for a WIT package and passes the resolved absolute input path', () => {
    const witDir = fixture('package example:api@1.0.0; interface api { enum mode { fast, safe } }');
    const calls: Array<{ executable: string; args: string[] }> = [];
    const document = readWitToolsDocument(witDir, {
        executable: 'wasm-tools-test',
        run: (executable, args) => {
            calls.push({ executable, args });
            return JSON.stringify({
                worlds: [{ name: 'plugin', package: 0, imports: { api: { interface: { id: 0 } } } }],
                interfaces: [
                    {
                        name: 'api',
                        package: 0,
                        types: { mode: 0 },
                        functions: {},
                    },
                ],
                types: [
                    {
                        name: 'mode',
                        kind: { enum: { cases: [{ name: 'fast' }, { name: 'safe' }] } },
                        owner: { interface: 0 },
                    },
                ],
                packages: [{ name: 'example:api@1.0.0', interfaces: { api: 0 }, worlds: { plugin: 0 } }],
            });
        },
    });

    expect(document.packages.map(({ name }) => name)).toContain('example:api@1.0.0');
    expect(document.worlds.map(({ name }) => name)).toContain('plugin');
    expect(document.interfaces.map(({ name }) => name)).toContain('api');
    expect(
        document.types.some((type) => type.name === 'mode' && typeof type.kind !== 'string' && 'enum' in type.kind),
    ).toBe(true);
    expect(calls).toEqual([
        { executable: 'wasm-tools-test', args: ['component', 'wit', path.resolve(witDir), '--json', '--all-features'] },
    ]);
});

it('includes wasm-tools diagnostics when WIT parsing fails', () => {
    const witDir = fixture('package example:api@1.0.0; interface incomplete {');

    expect(() =>
        readWitToolsDocument(witDir, {
            executable: 'wasm-tools-test',
            run: () => {
                throw Object.assign(new Error('process failed'), { stderr: 'invalid WIT syntax' });
            },
        }),
    ).toThrow(/wasm-tools component wit .* --json --all-features failed: invalid WIT syntax/);
});

it('captures only source declaration order omitted by wasm-tools JSON maps', () => {
    const witDir = fixture(`package example:api@1.0.0;
interface api {
    record z-last { value: u32 }
    type alias = string;
    resource stream { read: func(); }
    record a-first { value: u8 }
}`);

    expect(readInterfaceDeclarationOrder(witDir).get('example:api/api@1.0.0')).toEqual({
        resources: ['stream'],
        records: ['z-last', 'a-first'],
        variants: [],
        enums: [],
        flags: [],
        types: ['alias'],
        escapedNames: [],
    });
});

it('uses the root package declaration for sibling WIT files', () => {
    const witDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-root-package-'));
    directories.push(witDir);
    fs.writeFileSync(path.join(witDir, 'plugin.wit'), 'package example:api@1.0.0; world plugin { import api; }');
    fs.writeFileSync(path.join(witDir, 'api.wit'), 'interface api { record value { id: u32 } }');

    expect(readInterfaceDeclarationOrder(witDir).get('example:api/api@1.0.0')?.records).toEqual(['value']);
});

function fixture(source: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-tools-'));
    directories.push(root);
    fs.writeFileSync(path.join(root, 'api.wit'), `${source}\n`);
    return root;
}
