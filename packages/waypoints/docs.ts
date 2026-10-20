import { code } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { SESSION_TIMING } from '@pumpkin-plugins/pumpkin-pie-api';
import { formatPlaceholderToken } from './src/info.ts';
import {
    catalogPlaceholders,
    existsPlaceholders,
    waypointFields,
    waypointPlaceholderDefinitions,
} from './src/placeholders/definitions.ts';
import { JAVA_DISPLAY_VERSION } from './src/rendering/java-version.ts';

const javaVersionNote = '<!-- Generated from src/rendering/java-version.ts. Run `pnpm readme`. -->';
const placeholderNote =
    '<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->';

/** Formats a documented retry interval as a short duration. */
function formatDuration(milliseconds: number): string {
    const minutes = milliseconds / 60_000;
    if (Number.isInteger(minutes)) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

    const seconds = milliseconds / 1_000;
    if (Number.isInteger(seconds)) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    return `${milliseconds} ms`;
}

/** Renders a token table for the definitions whose names appear in one placeholder group. */
function tokenTable(group: object): string {
    const rows = waypointPlaceholderDefinitions
        .filter(({ name }) => Object.hasOwn(group, name))
        .map((definition) => `| \`${formatPlaceholderToken(definition)}\` | ${definition.description} |`);
    return ['| Token | Description |', '| --- | --- |', ...rows].join('\n');
}

const fieldRows = Object.entries(waypointFields).map(
    ([name, { description, output }]) => `| \`${name}\` | ${description} | ${output} |`,
);
const retryDelay = formatDuration(SESSION_TIMING.maxRetryMs);
const heartbeat = formatDuration(SESSION_TIMING.defaultPingMs);

/** Waypoints guide blocks generated from the placeholder definitions, Java gate and PumpkinPIE timing. */
export const documents = [
    {
        file: 'docs/index.md',
        blocks: { 'java-display-version': `Required Java version: ${code(JAVA_DISPLAY_VERSION)}.` },
        note: javaVersionNote,
    },
    {
        file: 'docs/placeholders.md',
        blocks: {
            catalog: tokenTable(catalogPlaceholders),
            exists: tokenTable(existsPlaceholders),
            fields: ['| Field | Meaning | Output |', '| --- | --- | --- |', ...fieldRows].join('\n'),
            timing: [
                `PumpkinPIE is optional. Provider retries use bounded exponential backoff capped at ${retryDelay};`,
                `after reaching the cap, probes are no more frequent than once every ${retryDelay}. A ready`,
                `integration sends its registration heartbeat every ${heartbeat} and recovers automatically when`,
                'PumpkinPIE becomes available.',
            ].join('\n'),
        },
        note: placeholderNote,
    },
] satisfies DocumentSpec[];
