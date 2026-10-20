const COLORS = {
    black: '0',
    darkBlue: '1',
    darkGreen: '2',
    darkAqua: '3',
    darkRed: '4',
    darkPurple: '5',
    gold: '6',
    gray: '7',
    darkGray: '8',
    blue: '9',
    green: 'a',
    aqua: 'b',
    red: 'c',
    lightPurple: 'd',
    yellow: 'e',
    white: 'f',
} as const;

const FORMATS = {
    obfuscated: 'k',
    bold: 'l',
    strikethrough: 'm',
    underline: 'n',
    italic: 'o',
} as const;

const ANSI_COLORS = {
    black: 30,
    darkBlue: 34,
    darkGreen: 32,
    darkAqua: 36,
    darkRed: 31,
    darkPurple: 35,
    gold: 33,
    gray: 37,
    darkGray: 90,
    blue: 94,
    green: 92,
    aqua: 96,
    red: 91,
    lightPurple: 95,
    yellow: 93,
    white: 97,
} as const satisfies Record<keyof typeof COLORS, number>;

// Terminals have no obfuscated style, and SGR 8 (conceal) would hide text that log files still keep.
const ANSI_FORMATS = {
    obfuscated: undefined,
    bold: 1,
    strikethrough: 9,
    underline: 4,
    italic: 3,
} as const satisfies Record<keyof typeof FORMATS, number | undefined>;

const NAMED_COLORS = {
    error: { color: 'darkRed', format: 'bold' },
    identifier: { color: 'yellow' },
    name: { color: 'darkAqua' },
    namespace: { color: 'darkGreen' },
    number: { color: 'blue' },
    permission: { color: 'yellow', format: 'bold' },
    port: { color: 'yellow' },
    url: { color: 'darkAqua' },
    uuid: { color: 'yellow' },
    value: { color: 'gold' },
    version: { color: 'green' },
} as const satisfies Record<string, { color: keyof typeof COLORS; format?: keyof typeof FORMATS }>;

type MinecraftColor = keyof typeof COLORS;
type MinecraftFormat = keyof typeof FORMATS;
type MinecraftNamedRole = keyof typeof NAMED_COLORS;
/**
 * Formats text with the style chained so far. Each color or modifier property returns a new
 * formatter that adds that style, and `hex()` sets an RGB color.
 */
export type TextFormatter = ((text: string | number) => string) & {
    readonly [Key in MinecraftColor | MinecraftFormat]: TextFormatter;
} & {
    hex(color: string): TextFormatter;
};
type NamedFormatters = { readonly [Role in MinecraftNamedRole]: TextFormatter };
/** The shape of the `color` and `ansi` exports: a formatter with `named` role formatters. */
export type ColorApi = TextFormatter & { readonly named: NamedFormatters };
type FormatterOutput = 'minecraft' | 'ansi';

interface FormatterState {
    ansiColorPrefix?: string;
    formats: readonly MinecraftFormat[];
    legacyColorPrefix?: string;
}

function createFormatter(output: FormatterOutput, state: FormatterState = { formats: [] }): TextFormatter {
    const formatter = ((text: string | number) => {
        text = String(text);

        if (state.legacyColorPrefix === undefined && state.ansiColorPrefix === undefined && state.formats.length === 0)
            return text;

        const formats = (Object.keys(FORMATS) as MinecraftFormat[]).filter((format) => state.formats.includes(format));
        let open: string;
        let reset: string;
        if (output === 'ansi') {
            const codes: number[] = formats.flatMap((format) => ANSI_FORMATS[format] ?? []);
            if (state.ansiColorPrefix !== undefined) codes.push(...state.ansiColorPrefix.split(';').map(Number));
            if (codes.length === 0) return text;
            open = `\u001b[${codes.join(';')}m`;
            reset = '\u001b[0m';
        } else {
            const formatCodes = formats.map((format) => `§${FORMATS[format]}`).join('');
            open = `${state.legacyColorPrefix ?? ''}${formatCodes}`;
            reset = '§r';
        }

        // A nested formatted segment ends with a reset; reopen this style after it.
        return `${open}${text.replaceAll(reset, `${reset}${open}`)}${reset}`;
    }) as TextFormatter;

    for (const color of Object.keys(COLORS) as MinecraftColor[]) {
        Object.defineProperty(formatter, color, {
            get: () =>
                createFormatter(output, {
                    ...state,
                    legacyColorPrefix: `§${COLORS[color]}`,
                    ansiColorPrefix: String(ANSI_COLORS[color]),
                }),
        });
    }

    for (const format of Object.keys(FORMATS) as MinecraftFormat[]) {
        Object.defineProperty(formatter, format, {
            get: () =>
                createFormatter(output, {
                    ...state,
                    formats: state.formats.includes(format) ? state.formats : [...state.formats, format],
                }),
        });
    }

    Object.defineProperty(formatter, 'hex', {
        value: (color: string) => {
            const digits = color.startsWith('#') ? color.slice(1) : color;
            if (!/^[\da-f]{6}$/i.test(digits)) throw new RangeError('Expected a six-digit hex color');

            const hexDigits = [...digits.toLowerCase()];
            const legacyColorPrefix = `§x${hexDigits.map((digit) => `§${digit}`).join('')}`;
            const ansiColorPrefix = `38;2;${parseInt(digits.slice(0, 2), 16)};${parseInt(digits.slice(2, 4), 16)};${parseInt(digits.slice(4, 6), 16)}`;
            return createFormatter(output, { ...state, legacyColorPrefix, ansiColorPrefix });
        },
    });

    return formatter;
}

/** Formats Minecraft strings with legacy section-sign color and text style codes. */
export const color = createFormatter('minecraft') as ColorApi;

/** Formats terminal strings with ANSI colors mapped from Minecraft's palette and named roles. */
export const ansi = createFormatter('ansi') as ColorApi;

function addNamedFormatters(formatter: ColorApi, output: FormatterOutput): void {
    Object.defineProperty(formatter, 'named', {
        value: Object.fromEntries(
            Object.entries(NAMED_COLORS).map(([role, definition]) => {
                const formats = 'format' in definition ? [definition.format] : [];
                return [
                    role,
                    createFormatter(output, {
                        legacyColorPrefix: `§${COLORS[definition.color]}`,
                        ansiColorPrefix: String(ANSI_COLORS[definition.color]),
                        formats,
                    }),
                ];
            }),
        ),
        enumerable: true,
    });
}

addNamedFormatters(color, 'minecraft');
addNamedFormatters(ansi, 'ansi');

/** Returns a terminal table previewing every color in normal and bold text. */
export function ansiColorTable(): string {
    return makeColorTable(ansi);
}

/**
 * Returns a terminal table previewing every color in normal and bold text.
 *
 * @deprecated Use `ansiColorTable()`; this name will be removed in the next breaking release.
 */
export const colorTable = ansiColorTable;

/** Returns a table previewing every color with Minecraft's legacy codes. */
export function minecraftColorTable(): string {
    return makeColorTable(color);
}

function makeColorTable(formatter: ColorApi): string {
    const colors = Object.keys(COLORS) as MinecraftColor[];
    const nameWidth = Math.max(...colors.map((color) => color.length));
    const header = `Color${' '.repeat(nameWidth - 'Color'.length)} | Bold`;
    const divider = `${'-'.repeat(nameWidth)}-+-${'-'.repeat(nameWidth)}`;
    const rows = colors.map((colorName) => {
        const sample = formatter[colorName](colorName);
        const boldSample = formatter[colorName].bold(colorName);
        return `${sample}${' '.repeat(nameWidth - colorName.length)} | ${boldSample}`;
    });

    return [header, divider, ...rows].join('\n');
}
