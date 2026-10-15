import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { JAVA_DISPLAY_VERSION } from './src/model.ts';

const capabilityTable = table(
    ['Surface', 'Current behavior'],
    [
        [
            'Java row names',
            `Global subject formatting, gated to ${code(JAVA_DISPLAY_VERSION)}; live client behavior unverified`,
        ],
        [
            'Java header/footer',
            `Per-viewer formatted lines, gated to ${code(JAVA_DISPLAY_VERSION)}; live client behavior unverified`,
        ],
        ['Java sorting', 'Disabled; config rejects non-empty rules'],
        ['Java numeric objective', `Disabled; config rejects ${code('objective.enabled = true')}`],
        ['Bedrock roster', 'Left unchanged; objective and row formatting unsupported'],
        ['Per-viewer row names, fake rows and fixed slots', 'Not implemented'],
    ],
);

/** TabDisplay guide content generated from the adapter's version gate. */
export const documents = [
    {
        file: 'docs/index.md',
        blocks: { capabilities: capabilityTable },
        note: '<!-- Generated from src/model.ts and docs.ts. Run `pnpm readme`. -->',
    },
] satisfies DocumentSpec[];
