import { code, generatedBlocks } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { SESSION_TIMING } from '../../tools/apis/pumpkin-pie-api/src/session-timing.ts';
import { info } from './src/info.ts';
import {
    catalogPlaceholders,
    existsPlaceholders,
    type PlaceholderDefinition,
    waypointFields,
    waypointPlaceholderDefinitions,
} from './src/placeholders/definitions.ts';
import { JAVA_DISPLAY_VERSION } from './src/rendering/java-version.ts';

const generatedNote = '<!-- Generated from src/rendering/java-version.ts. Run `pnpm readme`. -->';
const previousBedrockClaim =
    'Bedrock support depends on the Pumpkin API and will be added when the API makes it possible.';
const currentBedrockClaim = 'This HUD supports Java clients only. Waypoints does not currently render Bedrock HUDs.';
const placeholderBegin = '<!-- docs:begin placeholders -->';
const placeholderEnd = '<!-- docs:end placeholders -->';
const placeholderNote = '<!-- Generated from src/info.ts and typed definitions. Run `pnpm readme`. -->';
const placeholderTable = info.blocks?.placeholders;
const placeholderGuideNote =
    '<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->';
const placeholderArgumentExamples = {
    rank: '2',
    radius: '128',
    uuid: '11111111-1111-4111-8111-111111111111',
    world: 'world',
} as const satisfies Record<NonNullable<PlaceholderDefinition['argument']>, string>;

/** Formats a documented retry interval as a short duration. */
function formatDuration(milliseconds: number): string {
    const minutes = milliseconds / 60_000;
    if (Number.isInteger(minutes)) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

    const seconds = milliseconds / 1_000;
    if (Number.isInteger(seconds)) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    return `${milliseconds} ms`;
}

/** Formats one placeholder definition as its complete PIE token. */
function formatPlaceholderToken({ name, argument }: PlaceholderDefinition, inline = true): string {
    const suffix = argument === undefined ? '' : `:${placeholderArgumentExamples[argument]}`;
    const token = `%waypoints_${name}${suffix}%`;
    return inline ? `\`${token}\`` : token;
}

/** Renders the contract tables from the same definitions used by the provider and README. */
function renderPlaceholderTables(): { catalog: string; exists: string; fields: string } {
    const catalogNames = new Set(Object.keys(catalogPlaceholders));
    const existsNames = new Set(Object.keys(existsPlaceholders));
    const catalogRows = waypointPlaceholderDefinitions
        .filter(({ name }) => catalogNames.has(name))
        .map((definition) => `| ${formatPlaceholderToken(definition)} | ${definition.description} |`);
    const existsRows = waypointPlaceholderDefinitions
        .filter(({ name }) => existsNames.has(name))
        .map((definition) => `| ${formatPlaceholderToken(definition)} | ${definition.description} |`);
    const fieldRows = Object.entries(waypointFields).map(
        ([name, definition]) => `| \`${name}\` | ${definition.description} | ${definition.output} |`,
    );

    return {
        catalog: ['| Token | Description |', '| --- | --- |', ...catalogRows].join('\n'),
        exists: ['| Token | Description |', '| --- | --- |', ...existsRows].join('\n'),
        fields: ['| Field | Meaning | Output |', '| --- | --- |', ...fieldRows].join('\n'),
    };
}

/** Generates the complete placeholder guide from typed definitions and shared retry timings. */
function renderPlaceholderGuide(): string {
    const tables = renderPlaceholderTables();
    const field = Object.keys(waypointFields)[0];
    if (field === undefined) throw new Error('Waypoints placeholder guide requires at least one waypoint field');
    const sampleTokens = [
        `%waypoints_closest_${field}%`,
        `%waypoints_nearest_${field}:${placeholderArgumentExamples.rank}%`,
        `%waypoints_waypoint_${field}:${placeholderArgumentExamples.uuid}%`,
        ...waypointPlaceholderDefinitions
            .filter(({ name }) => name.endsWith('_exists'))
            .map((definition) => formatPlaceholderToken(definition, false)),
        ...waypointPlaceholderDefinitions
            .filter(({ argument }) => argument === 'world' || argument === 'radius')
            .map((definition) => formatPlaceholderToken(definition, false)),
    ];
    const retryDelay = formatDuration(SESSION_TIMING.maxRetryMs);
    const heartbeat = formatDuration(SESSION_TIMING.defaultPingMs);

    return [
        '# PumpkinPIE placeholders',
        '',
        'Waypoints optionally registers the `waypoints` namespace with [PumpkinPIE](https://github.com/Rennex07/PumpkinPIE).',
        'Install a compatible PumpkinPIE provider beside Waypoints to make these values available to other',
        'plugins. Without the provider, Waypoints still loads and its commands and Java HUD continue to work.',
        "The placeholders are server-side and do not depend on the viewer's Java or Bedrock edition or on a",
        'HUD being enabled.',
        '',
        "Every lookup requires an online viewer resolved by the provider's current player **name**. UUIDs,",
        'name prefixes, console defaults and viewerless global queries are not accepted. Missing or offline',
        'viewers leave every Waypoints token unresolved, including public counts. The consuming server plugin',
        'supplies the viewer name; it is context for access checks, not end-user authentication. Treat this as',
        'trusted server-plugin integration, not as proof of who will see a message.',
        '',
        '## Access and selection',
        '',
        "An accessible waypoint is enabled and passes Waypoints' current access rules for the viewer. Public",
        'records are accessible to everyone; restricted records require a matching player UUID, permission',
        'node or `Waypoints:group.<slug>` marker. Operators bypass those grants, but disabled waypoints remain',
        'excluded. ACL changes, permission changes, movement and catalog edits affect the next lookup; the',
        'namespace uses no value cache.',
        '',
        "“Here” means the viewer's exact current world key. Waypoints does not scale or compare coordinates",
        'between dimensions. Closest and nearest use accessible waypoints in that same world, regardless of',
        'HUD visibility range. Visible means eligible for the existing HUD projection: enabled, accessible,',
        "same world and inside the waypoint's optional 3D visibility range. It does not mean that a client",
        'currently sees a marker on screen; focus, fade, display edition and client state are not considered.',
        'Counts and lists only include records accessible to the supplied viewer. Waypoints does not publish a',
        'private-by-default raw total or aggregate hidden records.',
        '',
        'Closest uses raw 3D distance. Nearest ranks use raw 3D distance before formatting and break exact',
        'ties by lowercase waypoint UUID in lexical order. Explicit UUID lookups can return authorized',
        'metadata from another world, but cross-world distances and directions are unresolved.',
        '',
        '## Catalog values',
        '',
        tables.catalog,
        '',
        "Name lists sort by Waypoints' normalized, case-insensitive name key, then UUID. They are display",
        'text, not escaped identifiers; waypoint names can contain commas. Disabled, denied and',
        'hidden-by-ACL records do not affect counts, names, existence checks or rank positions. A known empty',
        'name list resolves to an empty string.',
        '',
        '## Existence lookups',
        '',
        tables.exists,
        '',
        '## Waypoint fields',
        '',
        'Substitute any field below in a closest, nearest or explicit UUID token. The same field rules apply',
        'to all three families.',
        '',
        tables.fields,
        '',
        'Compass sectors are 45 degrees wide; a boundary belongs to the clockwise sector. Relative direction',
        "uses the viewer's Minecraft yaw convention, where yaw zero faces south. If horizontal displacement",
        'is zero, bearing is a known empty string. Direction fields return `HERE` at the same position,',
        '`UP` above and `DOWN` below.',
        '',
        '## Token forms and arguments',
        '',
        '```text',
        ...sampleTokens,
        '```',
        '',
        'Closest has no argument. Nearest requires a decimal integer rank from 1 through 100. UUID arguments',
        'must use the canonical hyphenated UUID shape; letter case is normalized. Unknown, disabled and',
        'inaccessible UUIDs all return `false` for `waypoint_exists`; metadata fields remain unresolved.',
        '',
        'Catalog arguments:',
        '',
        '- `count_world` requires an exact, nonempty world key of at most 128 UTF-8 bytes.',
        '- `nearby_count` requires a plain decimal radius greater than zero and at most 30,000,000 blocks.',
        '  Exponent, hexadecimal, `Infinity` and `NaN` forms are rejected.',
        '- `nearest_*` and `nearest_exists` require ranks from 1 through 100.',
        '- `waypoint_*` and `waypoint_exists` require a canonical UUID.',
        '- All other tokens reject arguments.',
        '',
        'The PIE token grammar cannot represent every possible world key. For those keys, pass the world key',
        'as the separate API argument rather than embedding it in token text:',
        '',
        '```ts',
        "import { PieClient } from '@pumpkin-plugins/pumpkin-pie-api';",
        "import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';",
        '',
        'const pie = new PieClient(ipcSend);',
        'pie.ping();',
        "const count = pie.getValue('waypoints_count_world', 'Alex', 'custom world key');",
        "const line = pie.resolve('Waypoints here: %waypoints_count_world%', 'Alex', 'world');",
        '```',
        '',
        "`getValue` preserves the distinction between `{ known: false }` and `{ known: true, value: '' }`.",
        '`resolve` and `resolveBatch` retain unresolved tokens in returned text and list their identifiers in',
        '`unresolved`. The caller sends resolved text through its own existing Pumpkin messaging API;',
        'PumpkinPIE resolves placeholders but does not deliver chat or UI messages.',
        '',
        '## Empty, unresolved and failed values',
        '',
        'Zero counts and distances are known values (`0` and `0.0`). A missing closest or valid nearest rank',
        'returns known empty strings for fields and `false` for existence checks. Missing optional description',
        'and icon metadata are known empty strings. Invalid arguments, unknown tokens, inaccessible or',
        'disabled explicit UUIDs, cross-world geometry, missing/offline viewers and values over 32 KiB UTF-8',
        'remain unresolved. Storage and host-query failures also decline the value instead of returning a',
        'misleading zero or partial result.',
        '',
        'The callback returns plain text only. It does not resolve nested tokens, escape markup, build text',
        'components or truncate oversized names. Waypoints logs a bounded identifier and reason once while a',
        'query failure remains active; stored waypoint text and host errors are never logged.',
        '',
        `PumpkinPIE is optional. Provider retries use bounded exponential backoff capped at ${retryDelay};`,
        `after reaching the cap, probes are no more frequent than once every ${retryDelay}. A ready`,
        `integration sends its registration heartbeat every ${heartbeat} and recovers automatically when`,
        'PumpkinPIE becomes available.',
    ].join('\n');
}

if (placeholderTable === undefined) throw new Error('Waypoints README: placeholder table is missing from src/info.ts');

/** Update one generated sentence or fail if the guide no longer matches the expected wording. */
function replaceSentence(source: string): string {
    const previousCount = source.split(previousBedrockClaim).length - 1;
    const currentCount = source.split(currentBedrockClaim).length - 1;
    if (previousCount === 0 && currentCount === 1) return source;
    if (previousCount === 1 && currentCount === 0) return source.replace(previousBedrockClaim, currentBedrockClaim);
    throw new Error(
        `Waypoints guide: expected one current or previous Bedrock statement, found ${previousCount} previous and ${currentCount} current`,
    );
}

/** Waypoints guide facts generated from source, preserving handwritten Markdown outside the generated data. */
export const documents = [
    {
        file: 'docs/index.md',
        transform: (source: string) => {
            let updated = replaceSentence(source);
            updated = replaceRequired(
                updated,
                'Records\nhave no creator ownership.\n\nInstall `waypoints.wasm`',
                'Records\nhave no creator ownership.\n\nOptional PumpkinPIE placeholders expose live, access-filtered waypoint data. See the [placeholder guide](placeholders.md) for the complete contract.\n\nInstall `waypoints.wasm`',
                'Waypoints guide introduction',
            );
            const matches = generatedBlocks(updated).filter(
                (block) => block.name === 'java-display-version' && block.markers === 'docs',
            );
            if (matches.length !== 1) {
                throw new Error(`Waypoints guide: expected one java-display-version block, found ${matches.length}`);
            }
            const block = matches[0];
            const begin = '<!-- docs:begin java-display-version -->';
            const end = '<!-- docs:end java-display-version -->';
            const replacement = `${begin}\n${generatedNote}\n\nRequired Java version: ${code(JAVA_DISPLAY_VERSION)}.\n${end}`;
            return `${updated.slice(0, block.start)}${replacement}${updated.slice(block.end)}`;
        },
    },
    {
        file: 'README.md',
        transform: (source: string) => {
            const blocks = generatedBlocks(source).filter(
                (block) => block.name === 'placeholders' && block.markers === 'docs',
            );
            if (blocks.length > 1)
                throw new Error(`Waypoints README: expected at most one placeholders block, found ${blocks.length}`);

            let updated = source;
            if (blocks.length === 0) {
                const insertionPoint = '<!-- docs:end commands -->';
                updated = replaceRequired(
                    updated,
                    insertionPoint,
                    `${insertionPoint}\n\n## PumpkinPIE placeholders\n\n${placeholderBegin}\n${placeholderNote}\n\n${placeholderTable}\n${placeholderEnd}`,
                    'Waypoints README placeholder table insertion point',
                );
            }

            return replaceRequired(
                updated,
                'See the [Waypoints guide](docs/index.md) for command examples, access rules, storage behavior, and\nJava HUD details.',
                'See the [Waypoints guide](docs/index.md) for command examples, access rules, storage behavior, and\nJava HUD details. See the [PumpkinPIE placeholder guide](docs/placeholders.md) for the optional\nlive lookup contract.',
                'Waypoints README guide links',
            );
        },
    },
    {
        file: 'docs/placeholders.md',
        blocks: { placeholders: renderPlaceholderGuide() },
        note: placeholderGuideNote,
    },
] satisfies DocumentSpec[];

/** Replaces one required phrase, and accepts the already-updated document on later runs. */
function replaceRequired(source: string, before: string, after: string, label: string): string {
    const beforeCount = source.split(before).length - 1;
    const afterCount = source.split(after).length - 1;
    if (afterCount === 1) return source;
    if (beforeCount === 1 && afterCount === 0) return source.replace(before, after);
    throw new Error(
        `${label}: expected one current or previous phrase, found ${beforeCount} previous and ${afterCount} current`,
    );
}
