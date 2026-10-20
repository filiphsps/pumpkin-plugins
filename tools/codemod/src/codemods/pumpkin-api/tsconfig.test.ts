import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runCodemod } from '../../runner.js';
import { migratePumpkinApiTs } from '../migrate-pumpkin-api.js';

describe('tsconfig.json migration', () => {
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

    it('accepts the trailing commas that TypeScript allows in tsconfig.json', async () => {
        const source = '{\n    "include": ["src/**/*.ts",],\n}\n';

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/tsconfig.json',
            projectRoot: '/project',
            relativePath: 'tsconfig.json',
            source,
        });

        expect(result.messages ?? []).toEqual([]);
        expect(ts.parseConfigFileTextToJson('tsconfig.json', result.source).config.include).toEqual([
            'src/**/*.ts',
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
