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

const NAMED_COLORS = {
    value: { color: 'gold' },
    name: { color: 'darkAqua' },
    namespace: { color: 'darkGreen' },
    version: { color: 'green' },
    url: { color: 'darkAqua' },
    permission: { color: 'yellow', format: 'bold' },
    port: { color: 'yellow' },
    uuid: { color: 'yellow' },
    identifier: { color: 'yellow' }
} as const satisfies Record<string, { color: keyof typeof COLORS; format?: keyof typeof FORMATS }>;

type MinecraftColor = keyof typeof COLORS;
type MinecraftFormat = keyof typeof FORMATS;
type MinecraftNamedRole = keyof typeof NAMED_COLORS;
type MinecraftFormatter = ((text: string) => string) & {
    readonly [Key in MinecraftColor | MinecraftFormat]: MinecraftFormatter;
} & {
    hex(color: string): MinecraftFormatter;
};
type NamedFormatters = { readonly [Role in MinecraftNamedRole]: MinecraftFormatter };
type MinecraftColorApi = MinecraftFormatter & { readonly named: NamedFormatters };

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
export const color = createFormatter() as MinecraftColorApi;

Object.defineProperty(color, 'named', {
    value: Object.fromEntries(
        Object.entries(NAMED_COLORS).map(([role, definition]) => {
            const formats = 'format' in definition ? [definition.format] : [];
            return [
                role,
                createFormatter({
                    colorPrefix: `§${COLORS[definition.color]}`,
                    formats
                })
            ];
        })
    ),
    enumerable: true
});

/** Returns an ASCII table previewing every legacy color in normal and bold text. */
export function colorTable(): string {
    const colors = Object.keys(COLORS) as MinecraftColor[];
    const nameWidth = Math.max(...colors.map((colorName) => colorName.length));
    const header = `Color${' '.repeat(nameWidth - 'Color'.length)} | Bold`;
    const divider = `${'-'.repeat(nameWidth)}-+-${'-'.repeat(nameWidth)}`;
    const rows = colors.map((colorName) => {
        const sample = color[colorName](colorName);
        const boldSample = color[colorName].bold(colorName);
        return `${sample}${' '.repeat(nameWidth - colorName.length)} | ${boldSample}`;
    });

    return [header, divider, ...rows].join('\n');
}
