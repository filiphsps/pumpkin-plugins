import * as path from 'node:path';
import { LEGACY_BUILD_COMMAND } from './constants.ts';
import { normalizePackagePath } from './package-path.ts';

/** Reads package-relative entry and output paths without evaluating shell syntax. */
export function parseLegacyBuildCommand(command: string): { entry: string; output: string } | undefined {
    const tokens = shellWords(command);
    if (!tokens) return undefined;
    const commandIndex =
        tokens[0]?.value === LEGACY_BUILD_COMMAND
            ? 0
            : tokens[0]?.value === 'pnpm' && tokens[1]?.value === 'exec'
              ? 2
              : -1;
    if (
        commandIndex < 0 ||
        tokens[commandIndex]?.value !== LEGACY_BUILD_COMMAND ||
        tokens.length - commandIndex !== 3
    ) {
        return undefined;
    }
    const [entryToken, outputToken] = tokens.slice(commandIndex + 1);
    const entry = entryToken?.value;
    const output = outputToken?.value;
    if (
        !entry ||
        !output ||
        entry.startsWith('-') ||
        output.startsWith('-') ||
        entryToken?.expanded ||
        outputToken?.expanded
    ) {
        return undefined;
    }
    const normalizedEntry = normalizePackagePath(entry);
    const normalizedOutput = normalizePackagePath(output);
    if (!normalizedEntry || !normalizedOutput || path.posix.extname(normalizedOutput).toLowerCase() !== '.wasm') {
        return undefined;
    }
    return { entry: normalizedEntry, output: normalizedOutput };
}

/** Splits simple quoted command arguments and rejects shell operators and expansions. */
function shellWords(command: string): ShellWord[] | undefined {
    const words: ShellWord[] = [];
    let word = '';
    let expanded = false;
    let wordStarted = false;
    let quote: '"' | "'" | undefined;
    let escaped = false;
    const input = command.trim();
    for (let index = 0; index < input.length; index++) {
        const character = input[index];
        if (character === undefined) continue;
        if (escaped) {
            word += character;
            escaped = false;
            continue;
        }
        if (quote) {
            if (character === quote) quote = undefined;
            else if ((character === '$' || character === '`') && quote === '"') return undefined;
            else if (character === '\\' && quote === '"') escaped = true;
            else word += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            wordStarted = true;
        } else if (/\s/.test(character)) {
            if (word) words.push({ value: word, expanded });
            word = '';
            expanded = false;
            wordStarted = false;
        } else if (';&|<>`$'.includes(character)) {
            return undefined;
        } else if (character === '\\') {
            escaped = true;
            wordStarted = true;
        } else {
            word += character;
            if (
                '*?[]{}'.includes(character) ||
                (character === '~' && !wordStarted) ||
                (['!', '+', '@'].includes(character) && input[index + 1] === '(')
            ) {
                expanded = true;
            }
            wordStarted = true;
        }
    }
    if (quote || escaped) return undefined;
    if (word) words.push({ value: word, expanded });
    return words;
}

interface ShellWord {
    expanded: boolean;
    value: string;
}
