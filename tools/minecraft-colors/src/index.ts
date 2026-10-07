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
    white: 'f'
} as const;

const FORMATS = {
    obfuscated: 'k',
    bold: 'l',
    strikethrough: 'm',
    underline: 'n',
    italic: 'o'
} as const;

type MinecraftColor = keyof typeof COLORS;
type MinecraftFormat = keyof typeof FORMATS;
type MinecraftFormatter = ((text: string) => string) & {
    readonly [Key in MinecraftColor | MinecraftFormat]: MinecraftFormatter;
} & {
    hex(color: string): MinecraftFormatter;
};

interface FormatterState {
    colorPrefix?: string;
    formats: readonly MinecraftFormat[];
}

function createFormatter(state: FormatterState = { formats: [] }): MinecraftFormatter {
    const formatter = ((text: string) => {
        if (state.colorPrefix === undefined && state.formats.length === 0) return text;

        const formatCodes = (Object.keys(FORMATS) as MinecraftFormat[])
            .filter((format) => state.formats.includes(format))
            .map((format) => `§${FORMATS[format]}`)
            .join('');
        return `${state.colorPrefix ?? ''}${formatCodes}${text}§r`;
    }) as MinecraftFormatter;

    for (const color of Object.keys(COLORS) as MinecraftColor[]) {
        Object.defineProperty(formatter, color, {
            get: () => createFormatter({ ...state, colorPrefix: `§${COLORS[color]}` })
        });
    }

    for (const format of Object.keys(FORMATS) as MinecraftFormat[]) {
        Object.defineProperty(formatter, format, {
            get: () =>
                createFormatter({
                    ...state,
                    formats: state.formats.includes(format) ? state.formats : [...state.formats, format]
                })
        });
    }

    Object.defineProperty(formatter, 'hex', {
        value: (color: string) => {
            const digits = color.startsWith('#') ? color.slice(1) : color;
            if (!/^[\da-f]{6}$/i.test(digits)) throw new RangeError('Expected a six-digit hex color');

            const colorPrefix = `§x${[...digits.toLowerCase()].map((digit) => `§${digit}`).join('')}`;
            return createFormatter({ ...state, colorPrefix });
        }
    });

    return formatter;
}

/** Formats strings with Minecraft's legacy color and text style codes. */
export const minecraft = createFormatter();
