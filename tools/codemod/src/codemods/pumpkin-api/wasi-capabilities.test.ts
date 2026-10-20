import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { runCodemod } from '../../runner.js';
import { migratePumpkinApiTs } from '../migrate-pumpkin-api.js';
import { API_VERSION_RANGE, BUILD_VERSION_RANGE } from './constants.js';

describe('WASI capability inference', () => {
    it('infers WASI capabilities through inherited tsconfig path mappings', async () => {
        const source = `{
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

            expect(manifest.dependencies).toEqual({
                'other-package': '1.2.3',
                '@pumpkin-plugins/pumpkin-api': API_VERSION_RANGE,
                '@pumpkin-plugins/build': BUILD_VERSION_RANGE,
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
});
