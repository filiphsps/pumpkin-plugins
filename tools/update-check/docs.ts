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

// Each block carries its own source note, so the document-wide note is empty.
const blocks = {
    'http-limits': [
        '<!-- Generated from src/http-limits.ts. Run `pnpm readme`. -->',
        '',
        `Asynchronous requests time out after ${timeoutSeconds} seconds. Response bodies larger than ${responseLimitKiB} KiB are rejected.`,
    ].join('\n'),
};

/** HTTP limits shared by the package README and user guide. */
export const documents = [
    { file: 'README.md', blocks, note: '' },
    { file: 'docs/index.md', blocks, note: '' },
] satisfies DocumentSpec[];
