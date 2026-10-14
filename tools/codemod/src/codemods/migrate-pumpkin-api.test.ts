import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
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
