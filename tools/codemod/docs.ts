import { readFileSync } from 'node:fs';
import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { availableCodemods } from './src/codemods/available.ts';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    engines?: { node?: string };
};
const nodeRequirement = manifest.engines?.node;
if (typeof nodeRequirement !== 'string') throw new Error('package.json must define engines.node');

const codemodTable = table(
    ['Codemod', 'Description'],
    availableCodemods.map(({ id, description }) => [code(id), description]),
);
const note = '<!-- Generated from package.json and the registered codemods. Run `pnpm readme`. -->';

/** Package documentation blocks derived from package metadata and the CLI registry. */
export const documents = [
    {
        file: 'README.md',
        blocks: {
            'available-codemods': codemodTable,
            'node-requirement': `Requires Node.js ${code(nodeRequirement)}.`,
        },
        note,
    },
    {
        file: 'docs/using-codemods.md',
        blocks: {
            'available-codemods': codemodTable,
            'node-requirement': `Requires Node.js ${code(nodeRequirement)}.`,
        },
        note,
    },
] satisfies DocumentSpec[];
