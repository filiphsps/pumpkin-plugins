import { describe, expect, it } from 'vitest';
import { migratePumpkinApiTs } from '../migrate-pumpkin-api.js';

describe('source migration', () => {
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

    it('flags the legacy package name left in strings it does not rewrite, such as test mocks', async () => {
        const migrate = (source: string) =>
            migratePumpkinApiTs.transform({
                absolutePath: '/project/test/plugin.test.ts',
                projectRoot: '/project',
                relativePath: 'test/plugin.test.ts',
                source,
            });
        const legacyNotes = (messages: readonly string[] = []) =>
            messages.filter((message) => message.includes('@pumpkinmc/pumpkin-api-ts'));

        const mocked = await migrate(
            [
                "import { Plugin } from '@pumpkinmc/pumpkin-api-ts';",
                "vi.mock('@pumpkinmc/pumpkin-api-ts');",
                'jest.mock(`@pumpkinmc/pumpkin-api-ts`);',
            ].join('\n'),
        );
        const imported = await migrate("import { Plugin } from '@pumpkinmc/pumpkin-api-ts';");

        expect(mocked.source).toContain("import { Plugin } from '@pumpkin-plugins/pumpkin-api';");
        expect(mocked.source).toContain("vi.mock('@pumpkinmc/pumpkin-api-ts');");
        expect(legacyNotes(mocked.messages)).toHaveLength(1);
        expect(legacyNotes(imported.messages)).toEqual([]);
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
});
