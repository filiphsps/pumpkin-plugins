import { readFileSync } from 'node:fs';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { renderDocs } from './scripts/docs.ts';
import { LIMITS, PROTOCOL_VERSION } from './src/protocol.ts';
import { SESSION_TIMING } from './src/session-timing.ts';
import { PIE_RELEASE } from './test/release.ts';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const blocks = renderDocs({
    release: PIE_RELEASE,
    protocol: PROTOCOL_VERSION,
    limits: LIMITS,
    license: manifest.license,
    timing: SESSION_TIMING,
});
const note = '<!-- Generated from protocol/session constants, test/release.ts and package.json. Run `pnpm readme`. -->';

/** Component document blocks derived from the protocol and integration fixture metadata. */
export const documents = [
    { file: 'README.md', blocks: { overview: blocks.overview }, note },
    { file: 'docs/index.md', blocks, note },
] satisfies DocumentSpec[];
