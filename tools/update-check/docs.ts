import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_NS } from './src/http-limits.ts';

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const BYTES_PER_KIBIBYTE = 1024;

if (REQUEST_TIMEOUT_NS <= 0n || REQUEST_TIMEOUT_NS % NANOSECONDS_PER_SECOND !== 0n) {
    throw new Error('REQUEST_TIMEOUT_NS must be a positive whole number of seconds');
}
if (
    !Number.isSafeInteger(MAX_RESPONSE_BYTES) ||
    MAX_RESPONSE_BYTES <= 0 ||
    MAX_RESPONSE_BYTES % BYTES_PER_KIBIBYTE !== 0
) {
    throw new Error('MAX_RESPONSE_BYTES must be a positive whole number of KiB');
}

const timeoutSeconds = REQUEST_TIMEOUT_NS / NANOSECONDS_PER_SECOND;
const responseLimitKiB = MAX_RESPONSE_BYTES / BYTES_PER_KIBIBYTE;
const limitsBlock = `Asynchronous requests time out after ${timeoutSeconds} seconds. Response bodies larger than ${responseLimitKiB} KiB are rejected.`;
const note = '<!-- Generated from src/http-limits.ts. Run `pnpm readme`. -->';
const startMarker = '<!-- docs:begin http-limits -->';
const endMarker = '<!-- docs:end http-limits -->';

function findUniqueAnchor(source: string, text: string, position: string): { index: number; length: number } {
    const words = text
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const matches = [...source.matchAll(new RegExp(words.join('\\s+'), 'g'))];
    const match = matches[0];
    if (matches.length !== 1 || match?.index === undefined) {
        throw new Error(`Expected one documentation anchor ${position}: ${text}`);
    }
    return { index: match.index, length: match[0].length };
}

function updateLimitsBlock(source: string, before: string, after: string, legacySentence: RegExp): string {
    const beforeAnchor = findUniqueAnchor(source, before, 'before the HTTP limits block');
    const afterAnchor = findUniqueAnchor(source, after, 'after the HTTP limits block');
    const blockStart = beforeAnchor.index + beforeAnchor.length;
    const blockEnd = afterAnchor.index;
    if (blockEnd < blockStart) throw new Error('HTTP limits documentation anchors are out of order');

    const startCount = source.split(startMarker).length - 1;
    const endCount = source.split(endMarker).length - 1;
    if (startCount !== endCount || startCount > 1)
        throw new Error('HTTP limits documentation markers are unbalanced or duplicated');

    const existingBlock = source.slice(blockStart, blockEnd).trim();
    if (startCount === 1) {
        const start = source.indexOf(startMarker);
        const end = source.indexOf(endMarker);
        if (start < blockStart || end < start || end > blockEnd) {
            throw new Error('HTTP limits documentation markers are outside their expected section');
        }
    } else if (!legacySentence.test(existingBlock)) {
        throw new Error('Expected the known HTTP limits sentence or its generated block');
    }

    const generatedBlock = `${startMarker}\n${note}\n\n${limitsBlock}\n${endMarker}`;
    return `${source.slice(0, blockStart)}\n\n${generatedBlock}\n\n${source.slice(blockEnd)}`;
}

/** HTTP limits shared by the package README and user guide. */
export const documents = [
    {
        file: 'README.md',
        transform: (source: string) =>
            updateLimitsBlock(
                source,
                'Automatic checks do not block plugin startup or server ticks.',
                'A failed update request is logged and does not interrupt plugin loading.',
                /^Asynchronous\s+requests\s+stop\s+after\s+\d+\s+seconds\s+and\s+reject\s+bodies\s+larger\s+than\s+\d+\s+KiB\.$/,
            ),
    },
    {
        file: 'docs/index.md',
        transform: (source: string) =>
            updateLimitsBlock(
                source,
                'A failed request is logged and does not prevent the plugin from loading.',
                '`marketplaceUrl` can override the Market base URL for tests or alternate environments.',
                /^Requests\s+stop\s+after\s+\d+\s+seconds\s+and\s+response\s+bodies\s+larger\s+than\s+\d+\s+KiB\s+are\s+rejected\.$/,
            ),
    },
] satisfies DocumentSpec[];
