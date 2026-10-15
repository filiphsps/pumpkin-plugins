import { code, generatedBlocks } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { JAVA_DISPLAY_VERSION } from './src/rendering/java-version.ts';

const generatedNote = '<!-- Generated from src/rendering/java-version.ts. Run `pnpm readme`. -->';
const previousBedrockClaim =
    'Bedrock support depends on the Pumpkin API and will be added when the API makes it possible.';
const currentBedrockClaim = 'This HUD supports Java clients only. Waypoints does not currently render Bedrock HUDs.';

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
            const updated = replaceSentence(source);
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
] satisfies DocumentSpec[];
