import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIMITS, PROTOCOL_VERSION } from '../src/protocol.ts';
import { SESSION_TIMING } from '../src/session-timing.ts';
import { PIE_RELEASE } from '../test/provider.ts';
import { renderDocs, updateDoc } from './docs.ts';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check')) throw new Error('Usage: node scripts/generate-docs.ts [--check]');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const blocks = renderDocs({
    release: PIE_RELEASE,
    protocol: PROTOCOL_VERSION,
    limits: LIMITS,
    license: manifest.license,
    timing: SESSION_TIMING
});
const targets = [
    ['../README.md', { overview: blocks.overview }],
    ['../docs/index.md', blocks]
] as const;
for (const [relative, content] of targets) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    if (!updateDoc(file, content, args.includes('--check'))) {
        console.error(`${file}: generated docs are stale; run pnpm readme`);
        process.exitCode = 1;
    }
}
