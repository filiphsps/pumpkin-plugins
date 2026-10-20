/** Font stack used by a chart text element. */
export type SvgFont = 'ui' | 'mono';

/** Returns an SVG text element with its value escaped. */
export function svgText(
    x: number,
    y: number,
    value: string,
    fill: string,
    size: number,
    weight = 400,
    font: SvgFont = 'ui',
    anchor: 'start' | 'middle' | 'end' = 'start',
): string {
    const family =
        font === 'mono'
            ? "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace"
            : "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

/** Returns one SVG text element per line, spaced by the line height. */
export function svgTextLines(
    x: number,
    y: number,
    values: string[],
    fill: string,
    size: number,
    weight: number,
    font: SvgFont,
    lineHeight: number,
): string {
    return values.map((value, index) => svgText(x, y + index * lineHeight, value, fill, size, weight, font)).join('');
}

/** Returns an SVG rectangle; a stroke of `none` omits the border. */
export function svgRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fill: string,
    stroke: string,
): string {
    const border = stroke === 'none' ? '' : ` stroke="${stroke}" stroke-width="1"`;
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"${border}/>`;
}

/** Wraps words into lines of at most the given length, splitting longer words; never returns an empty list. */
export function wrapWords(value: string, maximumCharacters: number): string[] {
    const words = value.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        if (word.length > maximumCharacters) {
            if (line) lines.push(line);
            line = '';
            for (let index = 0; index < word.length; index += maximumCharacters) {
                const part = word.slice(index, index + maximumCharacters);
                if (index + maximumCharacters < word.length) lines.push(part);
                else line = part;
            }
            continue;
        }
        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length > maximumCharacters) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines.length > 0 ? lines : [''];
}

/** Escapes text for use in XML and HTML text or attribute values. */
export function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
