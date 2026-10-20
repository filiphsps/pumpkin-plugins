import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { runCodemod } from '../../runner.js';
import { migratePumpkinApiTs } from '../migrate-pumpkin-api.js';

describe('package.json migration', () => {
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

    it('explains the runtime switch only when it adds pumpkinPlugin.engine', async () => {
        const migrate = (pumpkinPlugin: Record<string, unknown>) =>
            migratePumpkinApiTs.transform({
                absolutePath: '/project/package.json',
                projectRoot: '/project',
                relativePath: 'package.json',
                source: JSON.stringify({
                    scripts: { build: 'pumpkin-plugin-build src/plugin.ts build/plugin.wasm' },
                    dependencies: { '@pumpkinmc/pumpkin-api-ts': '^0.1.1' },
                    pumpkinPlugin,
                }),
            });
        const engineNotes = (messages: readonly string[] = []) =>
            messages.filter((message) => message.includes('pumpkinPlugin.engine'));

        const added = await migrate({});
        const kept = await migrate({ engine: 'quickjs' });

        expect(JSON.parse(added.source).pumpkinPlugin.engine).toBe('static-hermes');
        expect(engineNotes(added.messages)).toEqual([expect.stringContaining('quickjs')]);
        expect(JSON.parse(kept.source).pumpkinPlugin.engine).toBe('quickjs');
        expect(engineNotes(kept.messages)).toEqual([]);
    });

    it('skips a package.json that package managers would reject', async () => {
        const source =
            '{\n    // npm and pnpm reject comments here.\n    "dependencies": { "@pumpkinmc/pumpkin-api-ts": "^0.1.1" }\n}\n';

        const result = await migratePumpkinApiTs.transform({
            absolutePath: '/project/package.json',
            projectRoot: '/project',
            relativePath: 'package.json',
            source,
        });

        expect(result.source).toBe(source);
        expect(result.messages).toEqual([expect.stringContaining('package.json')]);
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
