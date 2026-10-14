import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runCodemod } from '../runner.js';
import { migratePumpkinApiTs } from './migrate-pumpkin-api.js';

describe('migratePumpkinApiTs', () => {
    it('updates static, type-only, dynamic, and CommonJS package references without reformatting source', () => {
        const source = [
            "import { Plugin } from '@pumpkinmc/pumpkin-api-ts';",
            "export type { Api } from '@pumpkinmc/pumpkin-api-ts';",
            "type Api = import('@pumpkinmc/pumpkin-api-ts').Api;",
            "const legacy = require('@pumpkinmc/pumpkin-api-ts');",
            "const lazy = import('@pumpkinmc/pumpkin-api-ts');",
        ].join('\n');

        const result = migratePumpkinApiTs.transform({
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

    it('leaves TypeScript with syntax errors unchanged and reports the parse failure', () => {
        const source = ["import { Plugin } from '@pumpkinmc/pumpkin-api-ts';", 'const broken = ;'].join('\n');

        const result = migratePumpkinApiTs.transform({
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

    it('moves dependencies and derives the new builder config from the old positional build command', () => {
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

        const result = migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source,
        });
        const manifest = parse(result.source) as {
            dependencies: Record<string, string>;
            scripts: Record<string, string>;
            pumpkinPlugin: Record<string, unknown>;
        };

        expect(result.source).toContain('// Keep this project note.');
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
            engine: 'quickjs',
            wasi: [],
        });
        expect(result.messages).toContain('Review pumpkinPlugin.wasi and add the capabilities used by this plugin.');
    });

    it('recognizes the direct and pnpm exec forms with quoted positional paths', () => {
        const source = JSON.stringify({
            scripts: { build: 'pnpm exec pumpkin-plugin-build "src/plugin entry.ts" "build/plugin.wasm"' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
        });

        const result = migratePumpkinApiTs.transform({
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

    it('keeps legacy build commands with unsupported paths for manual review', () => {
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
            const result = migratePumpkinApiTs.transform({
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

    it('does not report an inference failure when scripts.build is absent', () => {
        const source = JSON.stringify({
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
        });

        const result = migratePumpkinApiTs.transform({
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
    });

    it('leaves shell expansions, command chains, flags and other launchers for manual review', () => {
        const commands = [
            'pnpm exec pumpkin-plugin-build "$ENTRY" "$OUTPUT"',
            'pnpm exec pumpkin-plugin-build src/plugin.ts build/plugin.wasm && echo done',
            'pnpm exec pumpkin-plugin-build --entry src/plugin.ts build/plugin.wasm',
            'npx pumpkin-plugin-build src/plugin.ts build/plugin.wasm',
        ];

        for (const command of commands) {
            const source = JSON.stringify({
                scripts: { build: command },
                dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            });
            const result = migratePumpkinApiTs.transform({
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

    it('adds generated type declarations to an explicit tsconfig include list', () => {
        const source = `{
    "compilerOptions": { "strict": true },
    "include": ["src/**/*.ts", "test/**/*.ts"]
}\n`;

        const result = migratePumpkinApiTs.transform({
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

    it('fills missing builder paths without replacing existing runtime or WASI settings', () => {
        const source = JSON.stringify({
            name: 'example-plugin',
            scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm', typecheck: 'tsc --noEmit' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            pumpkinPlugin: { wasi: ['filesystem'], engine: 'static-hermes' },
        });

        const result = migratePumpkinApiTs.transform({
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

    it('leaves custom build scripts intact and reports paths that need manual migration', () => {
        const source = JSON.stringify({
            name: 'example-plugin',
            scripts: { build: 'custom-build src/plugin.ts' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
        });

        const result = migratePumpkinApiTs.transform({
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

    it('leaves the old builder command when an existing pumpkinPlugin value is invalid', () => {
        const source = JSON.stringify({
            name: 'example-plugin',
            scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm' },
            dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            pumpkinPlugin: 'invalid configuration',
        });

        const result = migratePumpkinApiTs.transform({
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

    it('is idempotent after the package manifest and source have migrated', () => {
        const first = migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source: JSON.stringify({
                name: 'example-plugin',
                scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm' },
                dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
            }),
        });
        const second = migratePumpkinApiTs.transform({
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
