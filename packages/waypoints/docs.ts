import { code, generatedBlocks } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { info } from './src/info.ts';
import { JAVA_DISPLAY_VERSION } from './src/rendering/java-version.ts';

const generatedNote = '<!-- Generated from src/rendering/java-version.ts. Run `pnpm readme`. -->';
const previousBedrockClaim =
    'Bedrock support depends on the Pumpkin API and will be added when the API makes it possible.';
const currentBedrockClaim = 'This HUD supports Java clients only. Waypoints does not currently render Bedrock HUDs.';
const placeholderBegin = '<!-- docs:begin placeholders -->';
const placeholderEnd = '<!-- docs:end placeholders -->';
const placeholderNote = '<!-- Generated from src/info.ts and typed definitions. Run `pnpm readme`. -->';
const placeholderTable = info.blocks?.placeholders;

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
