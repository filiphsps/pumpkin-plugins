import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runCodemod } from '../runner.js';
import { migratePumpkinApiTs } from './migrate-pumpkin-api.js';
import { mergeJsonStringArray } from './pumpkin-api/jsonc.js';

describe('mergeJsonStringArray', () => {
    it('deduplicates and appends entries without dropping JSONC comments or layout', () => {
        const source = `{
    "pumpkinPlugin": {
        "wasi": [
            // Keep the original capability note.
            "http",
            // Keep this note after deduplicating the grant.
            "http",
            "sockets",
        ]
    }
}`;

        const updated = mergeJsonStringArray(source, ['pumpkinPlugin', 'wasi'], ['filesystem', 'http'], source);

        expect(parse(updated).pumpkinPlugin.wasi).toEqual(['http', 'sockets', 'filesystem']);
        expect(updated).toContain('            // Keep the original capability note.');
        expect(updated).toContain('            // Keep this note after deduplicating the grant.');
        expect(updated).toContain('            "sockets",\n            "filesystem",\n');
    });
});

describe('migratePumpkinApiTs', () => {
    it('updates static, type-only, dynamic, and CommonJS package references without reformatting source', async () => {
        const source = [
            "import { Plugin } from '@pumpkinmc/pumpkin-api-ts';",
            "export type { Api } from '@pumpkinmc/pumpkin-api-ts';",
            "type Api = import('@pumpkinmc/pumpkin-api-ts').Api;",
            "const legacy = require('@pumpkinmc/pumpkin-api-ts');",
            "const lazy = import('@pumpkinmc/pumpkin-api-ts');",
        ].join('\n');

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/src/plugin.ts',
            projectRoot: '/project',
            relativePath: 'src/plugin.ts',
            source,
        });

        expect(result.source).toBe(
            [
                "import { Plugin } from '@pumpkin-plugins/pumpkin-api';",
                "export type { Api } from '@pumpkin-plugins/pumpkin-api';",
                "type Api = import('@pumpkin-plugins/pumpkin-api').Api;",
                "const legacy = require('@pumpkin-plugins/pumpkin-api');",
                "const lazy = import('@pumpkin-plugins/pumpkin-api');",
            ].join('\n'),
        );
    });

    it('leaves TypeScript with syntax errors unchanged and reports the parse failure', async () => {
        const source = ["import { Plugin } from '@pumpkinmc/pumpkin-api-ts';", 'const broken = ;'].join('\n');

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/src/plugin.ts',
            projectRoot: '/project',
            relativePath: 'src/plugin.ts',
            source,
        });

        expect(result.source).toBe(source);
        expect(result.messages).toContain(
            'Skipped source with syntax errors; fix the parse errors and rerun the codemod.',
        );
    });

    it('preserves JSONC comments and infers WASI capabilities from the manifest', async () => {
        const source = `{
    // Keep this project note.
    "name": "example-plugin",
    "scripts": {
        "build": "pnpm exec pumpkin-plugin-build src/plugin.ts build/plugin.wasm"
    },
    "dependencies": {
        "@pumpkinmc/pumpkin-api-ts": "^0.1.1",
        "other-package": "1.2.3"
    }
}\n`;

        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        const root = path.join(workspace, 'plugin');
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.mkdir(path.join(workspace, 'types'), { recursive: true });
            await fs.writeFile(
                path.join(root, 'src/plugin.ts'),
                "import type { Handler } from '@fixture/wasi-types';\nexport type { Handler };\n",
            );
            await fs.writeFile(
                path.join(workspace, 'tsconfig.base.json'),
                JSON.stringify({
                    compilerOptions: {
                        baseUrl: '.',
                        paths: { '@fixture/wasi-types': ['types/wasi-types.d.ts'] },
                    },
                }),
            );
            await fs.writeFile(
                path.join(workspace, 'types/wasi-types.d.ts'),
                "export type Handler = import('wasi:http/outgoing-handler@0.2.3').OutgoingHandler;\n",
            );
            await fs.writeFile(path.join(root, 'tsconfig.json'), '{"extends":"../tsconfig.base.json"}\n');
            await fs.writeFile(path.join(root, 'package.json'), source);
            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const result = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            expect(result).toBeDefined();
            const manifest = parse(result?.after ?? '') as {
                dependencies: Record<string, string>;
                scripts: Record<string, string>;
                pumpkinPlugin: Record<string, unknown>;
            };

            expect(result?.after).toContain('// Keep this project note.');
            expect(manifest.dependencies).toEqual({
                'other-package': '1.2.3',
                '@pumpkin-plugins/pumpkin-api': '^0.1.0',
                '@pumpkin-plugins/build': '^0.1.0',
            });
            expect(manifest.scripts).toEqual({
                build: 'pumpkin-plugins-build',
                typecheck: 'pumpkin-plugins-build --types-only && tsc --noEmit',
            });
            expect(manifest.pumpkinPlugin).toEqual({
                entry: 'src/plugin.ts',
                output: 'build/plugin.wasm',
                engine: 'static-hermes',
                wasi: ['http'],
            });
            expect(report.messages.map(({ text }) => text).join('\n')).not.toContain('JSON does not support comments');
            expect(report.messages.map(({ text }) => text)).toContain(
                'Review inferred pumpkinPlugin.wasi capabilities and any static-analysis notes before building.',
            );
        } finally {
            await fs.rm(workspace, { recursive: true, force: true });
        }
    });

    it('sets an empty WASI array when analysis finds no capabilities', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(path.join(root, 'src/plugin.ts'), 'export {};');
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm' },
                }),
            );

            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            expect(parse(packageChange?.after ?? '').pumpkinPlugin.wasi).toEqual([]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('infers runtime and type-only WASI capabilities only from the configured production graph', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.mkdir(path.join(root, 'test'), { recursive: true });
            const dependencyDirectory = path.join(root, 'node_modules/@fixture/wasi-helper');
            await fs.mkdir(dependencyDirectory, { recursive: true });
            await fs.writeFile(
                path.join(root, 'src/plugin.ts'),
                [
                    "import { handle } from 'wasi:http/outgoing-handler@0.2.3';",
                    "import type { Descriptor } from 'wasi:filesystem/types@0.2.3';",
                    "type Fields = import('wasi:http/types@0.2.3').Fields;",
                    "import './helper.ts';",
                    "import '@fixture/wasi-helper';",
                    "const lazy = import('wasi:filesystem/preopens@0.2.3');",
                    "const preopens = require('wasi:filesystem/preopens@0.2.3');",
                    "import 'wasi:sockets/udp@0.2.3';",
                    'export { handle, Descriptor, Fields, lazy, preopens };',
                ].join('\n'),
            );
            await fs.writeFile(
                path.join(root, 'src/helper.ts'),
                "export type { Descriptor } from 'wasi:filesystem/types@0.2.3';\n",
            );
            await fs.writeFile(
                path.join(dependencyDirectory, 'package.json'),
                JSON.stringify({
                    name: '@fixture/wasi-helper',
                    version: '1.0.0',
                    type: 'module',
                    exports: './index.js',
                }),
            );
            await fs.writeFile(path.join(dependencyDirectory, 'index.js'), "import 'wasi:sockets/tcp@0.2.3';\n");
            await fs.writeFile(path.join(root, 'src/legacy.ts'), "import 'wasi:sockets/udp@0.2.3';\n");
            await fs.writeFile(path.join(root, 'test/plugin.test.ts'), "import 'wasi:sockets/udp@0.2.3';\n");
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    scripts: { build: 'pumpkin-plugin-build src/legacy.ts build/plugin.wasm' },
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin: {
                        entry: 'src/plugin.ts',
                        output: 'build/plugin.wasm',
                        wasi: ['http', 'http', 'custom'],
                    },
                }),
            );

            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            expect(packageChange).toBeDefined();
            expect(parse(packageChange?.after ?? '').pumpkinPlugin.wasi).toEqual([
                'http',
                'custom',
                'filesystem',
                'sockets',
                'udp',
            ]);
            expect(report.messages).toContainEqual({
                relativePath: 'package.json',
                text: 'Existing pumpkinPlugin.entry differs from the path in scripts.build; confirm which entry is correct.',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('suppresses shared-interface notes when a matching capability is inferred elsewhere', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(
                path.join(root, 'src/plugin.ts'),
                [
                    "import 'wasi:io/streams@0.2.3';",
                    "import 'wasi:sockets/network@0.2.3';",
                    "import 'wasi:http/types@0.2.3';",
                    "import 'wasi:sockets/tcp@0.2.3';",
                ].join('\n'),
            );
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm' },
                }),
            );

            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            expect(parse(packageChange?.after ?? '').pumpkinPlugin.wasi).toEqual(['http', 'sockets']);
            expect(report.messages.some(({ text }) => text.includes('is shared by'))).toBe(false);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('keeps known capabilities and reports uncertainty in a partial production graph', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(
                path.join(root, 'src/plugin.ts'),
                [
                    "import 'wasi:filesystem/types@0.2.3';",
                    "import 'wasi:sockets/network@0.2.3';",
                    "import './missing.js';",
                    'const lazy = import(resolveModuleName());',
                ].join('\n'),
            );
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm' },
                }),
            );

            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            const packageMessages = report.messages.filter(({ relativePath }) => relativePath === 'package.json');
            expect(parse(packageChange?.after ?? '').pumpkinPlugin.wasi).toEqual(['filesystem']);
            expect(packageMessages.map(({ text }) => text).join('\n')).toContain(
                'WASI interface "sockets/network" is shared by sockets, udp; no capability was inferred for it.',
            );
            expect(packageMessages.map(({ text }) => text).join('\n')).toContain('Could not resolve "./missing.js"');
            expect(packageMessages.map(({ text }) => text).join('\n')).toContain('computed dynamic-import');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('preserves existing WASI values when the configured production entry cannot be analyzed', async () => {
        const cases = [
            { config: { wasi: ['http', 'http'] } },
            { config: { entry: 'src/missing.ts', wasi: ['http', 'http'] } },
        ];
        for (const { config } of cases) {
            const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
            try {
                await fs.writeFile(
                    path.join(root, 'package.json'),
                    JSON.stringify({
                        dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                        pumpkinPlugin: config,
                    }),
                );
                const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
                const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
                expect(parse(packageChange?.after ?? '').pumpkinPlugin.wasi).toEqual(['http', 'http']);
                expect(
                    report.messages.some(
                        ({ relativePath, text }) =>
                            relativePath === 'package.json' && text.includes('the existing wasi value was preserved'),
                    ),
                ).toBe(true);
            } finally {
                await fs.rm(root, { recursive: true, force: true });
            }
        }
    });

    it('creates an empty WASI array for an incomplete graph with no known mappings', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(
                path.join(root, 'src/plugin.ts'),
                [
                    "import 'wasi:sockets/network@0.2.3';",
                    "import './missing.js';",
                    'const lazy = import(resolveModuleName());',
                ].join('\n'),
            );
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm' },
                }),
            );

            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            expect(parse(packageChange?.after ?? '').pumpkinPlugin.wasi).toEqual([]);
            expect(
                report.messages.some(
                    ({ relativePath, text }) =>
                        relativePath === 'package.json' && text.includes('is shared by sockets, udp'),
                ),
            ).toBe(true);
            expect(
                report.messages.some(
                    ({ relativePath, text }) =>
                        relativePath === 'package.json' && text.includes('Could not resolve "./missing.js"'),
                ),
            ).toBe(true);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('leaves a non-array WASI setting unchanged and reports the limitation', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(path.join(root, 'src/plugin.ts'), "import 'wasi:http/types@0.2.3';\n");
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin: { entry: 'src/plugin.ts', output: 'build/plugin.wasm', wasi: 'http' },
                }),
            );

            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            const manifest = parse(packageChange?.after ?? '');
            expect(manifest.pumpkinPlugin.wasi).toBe('http');
            expect(report.messages).toContainEqual({
                relativePath: 'package.json',
                text: 'pumpkinPlugin.wasi is not an array; its value was left unchanged.',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('is idempotent across runCodemod passes', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(
                path.join(root, 'src/plugin.ts'),
                [
                    "import { Plugin } from '@pumpkinmc/pumpkin-api-ts';",
                    "import 'wasi:http/types@0.2.3';",
                    'export { Plugin };',
                ].join('\n'),
            );
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm' },
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                }),
            );

            const first = await runCodemod(migratePumpkinApiTs, [root], { cwd: root, write: true });
            expect(first.changedFiles.map(({ relativePath }) => relativePath)).toEqual([
                'package.json',
                'src/plugin.ts',
            ]);
            expect(parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).pumpkinPlugin.wasi).toEqual([
                'http',
            ]);

            const second = await runCodemod(migratePumpkinApiTs, [root], { cwd: root, write: true });
            expect(second.changedFiles).toEqual([]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('recognizes the direct and pnpm exec forms with quoted positional paths', async () => {
        const source = JSON.stringify({
            scripts: { build: 'pnpm exec pumpkin-plugin-build "src/plugin entry.ts" "build/plugin.wasm"' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
        });

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source,
        });

        expect(parse(result.source).pumpkinPlugin).toMatchObject({
            entry: 'src/plugin entry.ts',
            output: 'build/plugin.wasm',
        });
    });

    it('uses the legacy entry when an existing configured entry is not a string', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-wasi-'));
        try {
            await fs.mkdir(path.join(root, 'src'), { recursive: true });
            await fs.writeFile(path.join(root, 'src/legacy.ts'), "import 'wasi:http/types@0.2.3';\n");
            await fs.writeFile(
                path.join(root, 'package.json'),
                JSON.stringify({
                    scripts: { build: 'pumpkin-plugin-build src/legacy.ts build/plugin.wasm' },
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin: { entry: 42, wasi: ['custom'] },
                }),
            );

            const report = await runCodemod(migratePumpkinApiTs, [root], { cwd: root });
            const packageChange = report.changedFiles.find(({ relativePath }) => relativePath === 'package.json');
            expect(parse(packageChange?.after ?? '').pumpkinPlugin).toMatchObject({
                entry: 'src/legacy.ts',
                wasi: ['custom', 'http'],
            });
            expect(report.messages).toContainEqual({
                relativePath: 'package.json',
                text: 'Existing pumpkinPlugin.entry is not a string; replaced it with the path from scripts.build.',
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('keeps legacy build commands with unsupported paths for manual review', async () => {
        const commands = [
            'pumpkin-plugin-build /outside/plugin.ts build/plugin.wasm',
            'pumpkin-plugin-build src/plugin.ts ../outside.wasm',
            'pumpkin-plugin-build src/plugin.ts build/plugin.js',
        ];

        for (const command of commands) {
            const source = JSON.stringify({
                scripts: { build: command },
                dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            });
            const result = await migratePumpkinApiTs.transform({
                absolutePath: '/project/package.json',
                projectRoot: '/project',
                relativePath: 'package.json',
                source,
            });

            expect(parse(result.source).scripts.build).toBe(command);
            expect(parse(result.source).pumpkinPlugin).toBeUndefined();
            expect(result.messages).toContain(
                'Could not infer the entry and output paths from scripts.build; configure pumpkinPlugin.entry/output and update the build script manually.',
            );
        }
    });

    it('does not report a build-script inference failure when scripts.build is absent', async () => {
        const source = JSON.stringify({
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
        });

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source,
        });

        expect(result.messages).not.toContain(
            'Could not infer the entry and output paths from scripts.build; configure pumpkinPlugin.entry/output and update the build script manually.',
        );
        expect(result.messages).toContain(
            'After setting pumpkinPlugin.entry/output, add the builder --types-only step to scripts.typecheck.',
        );
        expect(result.messages).toContain(
            'Could not infer pumpkinPlugin.wasi because pumpkinPlugin.entry is missing; the existing wasi value was preserved.',
        );
    });

    it('leaves shell expansions, command chains, flags and other launchers for manual review', async () => {
        const commands = [
            'pnpm exec pumpkin-plugin-build "$ENTRY" "$OUTPUT"',
            'pnpm exec pumpkin-plugin-build src/*.ts build/plugin.wasm',
            'pnpm exec pumpkin-plugin-build ~/plugin.ts build/plugin.wasm',
            'pnpm exec pumpkin-plugin-build src/{plugin,main}.ts build/plugin.wasm',
            'pnpm exec pumpkin-plugin-build src/!(test).ts build/plugin.wasm',
            'pnpm exec pumpkin-plugin-build "src/`echo plugin`.ts" build/plugin.wasm',
            'pnpm exec pumpkin-plugin-build src/plugin.ts build/plugin.wasm && echo done',
            'pnpm exec pumpkin-plugin-build --entry src/plugin.ts build/plugin.wasm',
            'npx pumpkin-plugin-build src/plugin.ts build/plugin.wasm',
        ];

        for (const command of commands) {
            const source = JSON.stringify({
                scripts: { build: command },
                dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            });
            const result = await migratePumpkinApiTs.transform({
                absolutePath: '/project/package.json',
                projectRoot: '/project',
                relativePath: 'package.json',
                source,
            });

            const manifest = parse(result.source) as { scripts: Record<string, string>; pumpkinPlugin?: unknown };
            expect(manifest.scripts.build).toBe(command);
            expect(manifest.pumpkinPlugin).toBeUndefined();
            expect(result.messages).toContain(
                'Could not infer the entry and output paths from scripts.build; configure pumpkinPlugin.entry/output and update the build script manually.',
            );
        }
    });

    it('adds generated type declarations to an explicit tsconfig include list', async () => {
        const source = `{
    "compilerOptions": { "strict": true },
    "include": ["src/**/*.ts", "test/**/*.ts"]
}\n`;

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/tsconfig.json',
            projectRoot: '/project',
            relativePath: 'tsconfig.json',
            source,
        });

        expect(JSON.parse(result.source).include).toEqual([
            'src/**/*.ts',
            'test/**/*.ts',
            'build/types/bindings/**/*.d.ts',
        ]);
    });

    it.each([
        ['the `build` exclude', { exclude: ['build'] }],
        ['the `build/**` exclude', { exclude: ['build/**'] }],
        ['the `**/build` exclude', { exclude: ['**/build'] }],
        ['a nested declaration glob exclude', { exclude: ['build/types/**/*.d.ts'] }],
        ['compilerOptions.outDir', { compilerOptions: { outDir: 'build' } }],
        [
            'compilerOptions.outDir with the default include',
            { include: undefined, compilerOptions: { outDir: 'build' } },
        ],
    ])('reports when %s keeps generated declarations out of the project', async (_reason, settings) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-tsconfig-'));
        const pluginDirectory = path.join(root, 'plugin');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');

        try {
            await fs.mkdir(path.join(pluginDirectory, 'src'), { recursive: true });
            await fs.mkdir(path.join(pluginDirectory, 'build/types/bindings'), { recursive: true });
            await fs.writeFile(
                pluginConfigPath,
                JSON.stringify({ include: ['src/**/*.ts', 'build/types/bindings/**/*.d.ts'], ...settings }),
            );
            await fs.writeFile(path.join(pluginDirectory, 'src/plugin.ts'), 'export {};');
            await fs.writeFile(path.join(pluginDirectory, 'build/types/bindings/api.d.ts'), 'export {};');

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual(['plugin/src/plugin.ts']);

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });

            expect(report.changedFiles).toEqual([]);
            expect(report.messages).toEqual([
                expect.objectContaining({
                    relativePath: 'plugin/tsconfig.json',
                    text: expect.stringContaining('build/types/bindings/**/*.d.ts'),
                }),
            ]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['exclude', { exclude: ['build'] }],
        ['outDir', { compilerOptions: { outDir: 'build' } }],
    ])('reports inherited %s settings that omit generated declarations', async (_setting, settings) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-tsconfig-'));
        const pluginDirectory = path.join(root, 'plugin');
        const baseConfigPath = path.join(pluginDirectory, 'tsconfig.base.json');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');

        try {
            await fs.mkdir(path.join(pluginDirectory, 'src'), { recursive: true });
            await fs.mkdir(path.join(pluginDirectory, 'build/types/bindings'), { recursive: true });
            await fs.writeFile(baseConfigPath, JSON.stringify(settings));
            await fs.writeFile(
                pluginConfigPath,
                JSON.stringify({
                    extends: './tsconfig.base.json',
                    include: ['src/**/*.ts', 'build/types/bindings/**/*.d.ts'],
                }),
            );
            await fs.writeFile(path.join(pluginDirectory, 'src/plugin.ts'), 'export {};');
            await fs.writeFile(path.join(pluginDirectory, 'build/types/bindings/api.d.ts'), 'export {};');

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual(['plugin/src/plugin.ts']);

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });

            expect(report.changedFiles).toEqual([]);
            expect(report.messages.map(({ text }) => text).join('\n')).toContain(
                'tsconfig.json excludes generated declarations under build/types/bindings',
            );
            expect(report.messages.map(({ text }) => text).join('\n')).toContain('build/types/bindings/**/*.d.ts');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('does not report exclusions when files explicitly roots a generated declaration', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-tsconfig-'));
        const pluginDirectory = path.join(root, 'plugin');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');

        try {
            await fs.mkdir(path.join(pluginDirectory, 'build/types/bindings'), { recursive: true });
            await fs.writeFile(
                pluginConfigPath,
                JSON.stringify({
                    files: ['build/types/bindings/api.d.ts'],
                    exclude: ['build'],
                    compilerOptions: { outDir: 'build' },
                }),
            );
            await fs.writeFile(path.join(pluginDirectory, 'build/types/bindings/api.d.ts'), 'export {};');

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual(['plugin/build/types/bindings/api.d.ts']);

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });

            expect(report.messages).toEqual([]);
            expect(report.changedFiles.map(({ relativePath }) => relativePath)).toEqual(['plugin/tsconfig.json']);
            const updated = report.changedFiles[0];
            if (updated) await fs.writeFile(pluginConfigPath, updated.after);
            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual(['plugin/build/types/bindings/api.d.ts']);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('preserves a restrictive inherited include while adding generated declarations locally', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-tsconfig-'));
        const baseDirectory = path.join(root, 'shared');
        const pluginDirectory = path.join(root, 'plugin');
        const basePath = path.join(baseDirectory, 'tsconfig.base.json');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');

        try {
            await fs.mkdir(path.join(baseDirectory, 'src'), { recursive: true });
            await fs.mkdir(path.join(baseDirectory, 'test'), { recursive: true });
            await fs.mkdir(path.join(pluginDirectory, 'build/types/bindings'), { recursive: true });
            await fs.writeFile(basePath, JSON.stringify({ include: ['src/**/*.ts', 'test/**/*.ts'] }));
            await fs.writeFile(pluginConfigPath, JSON.stringify({ extends: '../shared/tsconfig.base.json' }));
            await fs.writeFile(path.join(baseDirectory, 'src/plugin.ts'), 'export {};');
            await fs.writeFile(path.join(baseDirectory, 'test/plugin.test.ts'), 'export {};');
            await fs.writeFile(path.join(pluginDirectory, 'build/types/bindings/api.d.ts'), 'export {};');

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual([
                'shared/src/plugin.ts',
                'shared/test/plugin.test.ts',
            ]);

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });
            const changedConfig = report.changedFiles.find(
                ({ relativePath }) => relativePath === 'plugin/tsconfig.json',
            );
            expect(report.changedFiles.map(({ relativePath }) => relativePath)).toEqual(['plugin/tsconfig.json']);
            if (changedConfig) await fs.writeFile(pluginConfigPath, changedConfig.after);

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual([
                'plugin/build/types/bindings/api.d.ts',
                'shared/src/plugin.ts',
                'shared/test/plugin.test.ts',
            ]);
            expect(JSON.parse(await fs.readFile(basePath, 'utf8'))).toEqual({
                include: ['src/**/*.ts', 'test/**/*.ts'],
            });
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('resolves package tsconfig fields without changing the inherited source set', async () => {
        const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pumpkin-codemod-tsconfig-'));
        const packageDirectory = path.join(root, 'node_modules/@fixture/shared-config');
        const configDirectory = path.join(packageDirectory, 'config');
        const pluginDirectory = path.join(root, 'plugin');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');
        const packageConfigPath = path.join(configDirectory, 'base.json');

        try {
            await fs.mkdir(path.join(configDirectory, 'src'), { recursive: true });
            await fs.mkdir(path.join(pluginDirectory, 'build/types/bindings'), { recursive: true });
            await fs.writeFile(
                path.join(packageDirectory, 'package.json'),
                JSON.stringify({
                    name: '@fixture/shared-config',
                    main: './index.js',
                    tsconfig: './config/base.json',
                }),
            );
            await fs.writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = {};');
            await fs.writeFile(packageConfigPath, JSON.stringify({ include: ['src/**/*.ts'] }));
            await fs.writeFile(pluginConfigPath, JSON.stringify({ extends: '@fixture/shared-config' }));
            await fs.writeFile(path.join(configDirectory, 'src/upstream.ts'), 'export {};');
            await fs.writeFile(path.join(pluginDirectory, 'build/types/bindings/api.d.ts'), 'export {};');

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual([
                'node_modules/@fixture/shared-config/config/src/upstream.ts',
            ]);

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });
            const changedConfig = report.changedFiles.find(
                ({ relativePath }) => relativePath === 'plugin/tsconfig.json',
            );
            expect(report.messages).toEqual([]);
            expect(report.changedFiles.map(({ relativePath }) => relativePath)).toEqual(['plugin/tsconfig.json']);
            if (changedConfig) await fs.writeFile(pluginConfigPath, changedConfig.after);

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual([
                'node_modules/@fixture/shared-config/config/src/upstream.ts',
                'plugin/build/types/bindings/api.d.ts',
            ]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('adds only generated declarations when local files define project roots', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-tsconfig-'));
        const pluginDirectory = path.join(root, 'plugin');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');

        try {
            await fs.mkdir(path.join(pluginDirectory, 'src'), { recursive: true });
            await fs.mkdir(path.join(pluginDirectory, 'build/types/bindings'), { recursive: true });
            await fs.writeFile(pluginConfigPath, JSON.stringify({ files: ['src/entry.ts'] }));
            await fs.writeFile(path.join(pluginDirectory, 'src/entry.ts'), 'export {};');
            await fs.writeFile(path.join(pluginDirectory, 'src/unlisted.ts'), 'export {};');
            await fs.writeFile(path.join(pluginDirectory, 'build/types/bindings/api.d.ts'), 'export {};');

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual(['plugin/src/entry.ts']);

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });
            const changedConfig = report.changedFiles.find(
                ({ relativePath }) => relativePath === 'plugin/tsconfig.json',
            );
            if (changedConfig) await fs.writeFile(pluginConfigPath, changedConfig.after);

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual([
                'plugin/build/types/bindings/api.d.ts',
                'plugin/src/entry.ts',
            ]);
            expect(JSON.parse(await fs.readFile(pluginConfigPath, 'utf8')).files).toEqual(['src/entry.ts']);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('adds only generated declarations when inherited files define project roots', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-tsconfig-'));
        const baseDirectory = path.join(root, 'shared');
        const pluginDirectory = path.join(root, 'plugin');
        const basePath = path.join(baseDirectory, 'tsconfig.base.json');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');

        try {
            await fs.mkdir(path.join(baseDirectory, 'src'), { recursive: true });
            await fs.mkdir(path.join(pluginDirectory, 'build/types/bindings'), { recursive: true });
            await fs.writeFile(basePath, JSON.stringify({ files: ['src/entry.ts'] }));
            await fs.writeFile(pluginConfigPath, JSON.stringify({ extends: '../shared/tsconfig.base.json' }));
            await fs.writeFile(path.join(baseDirectory, 'src/entry.ts'), 'export {};');
            await fs.writeFile(path.join(baseDirectory, 'src/unlisted.ts'), 'export {};');
            await fs.writeFile(path.join(pluginDirectory, 'build/types/bindings/api.d.ts'), 'export {};');

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual(['shared/src/entry.ts']);

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });
            const changedConfig = report.changedFiles.find(
                ({ relativePath }) => relativePath === 'plugin/tsconfig.json',
            );
            if (changedConfig) await fs.writeFile(pluginConfigPath, changedConfig.after);

            expect(readIncludedProjectFiles(pluginConfigPath, root)).toEqual([
                'plugin/build/types/bindings/api.d.ts',
                'shared/src/entry.ts',
            ]);
            expect(JSON.parse(await fs.readFile(basePath, 'utf8')).files).toEqual(['src/entry.ts']);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('reports an unresolved inherited config instead of silently skipping the declaration glob', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pumpkin-codemod-tsconfig-'));
        const pluginDirectory = path.join(root, 'plugin');
        const pluginConfigPath = path.join(pluginDirectory, 'tsconfig.json');

        try {
            await fs.mkdir(pluginDirectory, { recursive: true });
            await fs.writeFile(pluginConfigPath, JSON.stringify({ extends: '../missing/tsconfig.json' }));

            const report = await runCodemod(migratePumpkinApiTs, [pluginDirectory], { cwd: root });

            expect(report.changedFiles).toEqual([]);
            expect(report.messages).toHaveLength(1);
            expect(report.messages[0]?.relativePath).toBe('plugin/tsconfig.json');
            expect(report.messages[0]?.text).toContain('build/types/bindings/**/*.d.ts');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it('fills missing builder paths without replacing existing runtime or WASI settings', async () => {
        const source = JSON.stringify({
            name: 'example-plugin',
            scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm', typecheck: 'tsc --noEmit' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            pumpkinPlugin: { wasi: ['filesystem'], engine: 'static-hermes' },
        });

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source,
        });
        const manifest = JSON.parse(result.source);

        expect(manifest.pumpkinPlugin).toEqual({
            wasi: ['filesystem'],
            engine: 'static-hermes',
            entry: 'src/plugin.ts',
            output: 'build/plugin.wasm',
        });
        expect(manifest.scripts.typecheck).toBe('pumpkin-plugins-build --types-only && tsc --noEmit');
    });

    it('leaves custom build scripts intact and reports paths that need manual migration', async () => {
        const source = JSON.stringify({
            name: 'example-plugin',
            scripts: { build: 'custom-build src/plugin.ts' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
        });

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source,
        });

        expect(JSON.parse(result.source).scripts.build).toBe('custom-build src/plugin.ts');
        expect(JSON.parse(result.source).scripts.typecheck).toBeUndefined();
        expect(result.messages).toContain(
            'Could not infer the entry and output paths from scripts.build; configure pumpkinPlugin.entry/output and update the build script manually.',
        );
    });

    it('leaves the old builder command when an existing pumpkinPlugin value is invalid', async () => {
        const source = JSON.stringify({
            name: 'example-plugin',
            scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            pumpkinPlugin: 'invalid configuration',
        });

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source,
        });

        expect(JSON.parse(result.source).scripts.build).toBe('pumpkin-plugin-build src/plugin.ts build/plugin.wasm');
        expect(result.messages).toContain(
            'pumpkinPlugin is not an object; configure the new builder settings manually.',
        );
    });

    it('is idempotent after the package manifest and source have migrated', async () => {
        const first = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source: JSON.stringify({
                name: 'example-plugin',
                scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm' },
                dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            }),
        });
        const second = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source: first.source,
        });

        expect(second.source).toBe(first.source);
    });
});

function readIncludedProjectFiles(configPath: string, projectRoot: string): string[] {
    const parsed = ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
                throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            },
        },
    );
    if (!parsed) throw new Error(`TypeScript could not parse ${configPath}.`);
    return parsed.fileNames.map((fileName) => path.relative(projectRoot, fileName).split(path.sep).join('/')).sort();
}
