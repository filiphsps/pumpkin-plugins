import removeMarkdown from 'remove-markdown';

const escapeCharacter = String.fromCharCode(27);
const bellCharacter = String.fromCharCode(7);
const ansiEscapePattern = new RegExp(
    `${escapeCharacter}\\[[0-?]*[ -/]*[@-~]|${escapeCharacter}\\][^${bellCharacter}]*(?:${bellCharacter}|${escapeCharacter}\\\\)`,
    'g',
);

/** Converts Markdown release notes to plain text and removes terminal control sequences. */
export function normalizeMarkdownForConsole(markdown: string): string {
    const plainText = removeMarkdown(markdown.replace(/\r\n?/g, '\n'), {
        separateLinksAndTexts: ': ',
        stripListLeaders: false,
    }).replace(ansiEscapePattern, '');
    return removeControlCharacters(plainText)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function removeControlCharacters(text: string): string {
    let safeText = '';
    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (
            (codePoint <= 0x1f && character !== '\n' && character !== '\t') ||
            (codePoint >= 0x7f && codePoint <= 0x9f)
        ) {
            continue;
        }
        safeText += character;
    }
    return safeText;
}
