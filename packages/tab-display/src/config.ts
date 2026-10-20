import {
    bool,
    type ConfigStore,
    type ConfigValues,
    defineConfig,
    describeConfig,
    type Field,
    int,
    loadConfig,
    MANAGED_NOTE,
    type RenderOptions,
    type StringCheck,
    section,
    str,
    tomlString,
} from '@pumpkin-plugins/config';
import { PLUGIN_NAME } from './name.ts';
import { compileTemplate } from './templates.ts';

/** Name of the plugin settings file. */
export const CONFIG_FILE = 'config.toml';

/** Shared notice shown in the file and generated README. */
export const CONFIG_RENDER_OPTIONS: RenderOptions = {
    note: `${MANAGED_NOTE} Changes apply after \`/tabdisplay reload\` or a server restart.`,
};

/** A line template and its allowlisted text styling. */
export interface TemplateLineConfig {
    readonly bold?: boolean;
    readonly color?: string;
    readonly italic?: boolean;
    readonly strikethrough?: boolean;
    readonly text: string;
    readonly underlined?: boolean;
}

const MAX_LINES = 64;
const RGB_COLOR = /^#[\da-fA-F]{6}$/;
const rgbColor: StringCheck = { expected: 'an RGB color in `#RRGGBB` form', test: (value) => RGB_COLOR.test(value) };
const template: StringCheck = { expected: 'a template of at most 4 KiB', test: isTemplate };
const fallbackPolicy: StringCheck = {
    expected: '`literal` or `empty`',
    test: (value) => value === 'literal' || value === 'empty',
};

const defaultHeader: readonly TemplateLineConfig[] = [{ text: 'Welcome %player_name%', color: '#FFB347' }];
const defaultFooter: readonly TemplateLineConfig[] = [{ text: '%server_online% players online', color: '#AAAAAA' }];

/** Declares the plugin configuration; arrays use TOML arrays of inline tables. */
export const configSchema = defineConfig(PLUGIN_NAME, {
    general: section({
        description: 'Plugin refresh and workload limits.',
        fields: {
            version: int({ description: 'Format version. Do not change this value.', default: 1, min: 1, max: 1 }),
            enabled: bool({ description: 'Apply configured Java tab display changes.', default: true }),
            refresh_ticks: int({
                description: 'Ticks between full display refreshes.',
                default: 20,
                min: 1,
                max: 1200,
            }),
            max_players: int({
                description: 'Maximum player snapshots processed per refresh.',
                default: 500,
                min: 1,
                max: 5000,
            }),
        },
    }),
    placeholders: section({
        description: 'PumpkinPIE placeholder handling.',
        fields: {
            provider: str({
                description: 'Pumpkin plugin that supplies placeholder values.',
                default: 'PumpkinPIE',
                check: { expected: 'a plugin name', test: (value) => value.length > 0 },
            }),
            missing_provider: str({
                description:
                    'Text to show for tokens other than `%player_name%` and `%server_online%` when PumpkinPIE is unavailable: `literal` keeps them, `empty` removes them.',
                default: 'literal',
                check: fallbackPolicy,
            }),
            unresolved: str({
                description: 'Text to show for unresolved identifiers: `literal` keeps tokens, `empty` removes them.',
                default: 'literal',
                check: fallbackPolicy,
            }),
        },
    }),
    header: section({
        description: 'Personalized header lines. Each player sees their own placeholder context.',
        fields: {
            lines: templateLinesField('Header lines in display order.', defaultHeader),
        },
    }),
    footer: section({
        description: 'Personalized footer lines. Each player sees their own placeholder context.',
        fields: {
            lines: templateLinesField('Footer lines in display order.', defaultFooter),
        },
    }),
    entry: section({
        description: 'Global real-player row formatting. Placeholder context is the listed subject.',
        fields: {
            enabled: bool({ description: 'Apply a custom name to real player rows.', default: true }),
            text: str({
                description: 'Name template for each listed player.',
                default: '%player_name%',
                check: template,
            }),
            color: str({ description: 'RGB text color in `#RRGGBB` form.', default: '#FFFFFF', check: rgbColor }),
            bold: bool({ description: 'Render the row name in bold.', default: false }),
            italic: bool({ description: 'Render the row name in italics.', default: false }),
            underlined: bool({ description: 'Underline the row name.', default: false }),
            strikethrough: bool({ description: 'Strike through the row name.', default: false }),
        },
    }),
});

/** The validated shape returned by the config package. */
export type TabDisplayConfig = ConfigValues<typeof configSchema>;

/** Config section used by generated plugin metadata. */
export const configInfo = describeConfig(configSchema, CONFIG_FILE, CONFIG_RENDER_OPTIONS);

/**
 * Loads the settings file, creating it on first start. Each invalid value falls back to its default
 * and is listed in `warnings`; the file is then left unchanged so the user can fix it.
 *
 * @throws {ConfigSyntaxError} When the file is not valid TOML. The file is not changed.
 */
export function loadTabDisplayConfig(store: ConfigStore): {
    readonly config: TabDisplayConfig;
    readonly warnings: readonly string[];
} {
    const loaded = loadConfig(configSchema, store, CONFIG_RENDER_OPTIONS);
    return { config: loaded.values, warnings: loaded.warnings };
}

function templateLinesField(
    description: string,
    defaults: readonly TemplateLineConfig[],
): Field<readonly TemplateLineConfig[]> {
    const format = (lines: readonly TemplateLineConfig[]) =>
        formatInlineTableArray(lines.map((line) => lineFields(line)));
    const example = format(defaults);
    return {
        type: 'table[]',
        description: `${description} Use a TOML array of inline tables, for example ${example}.`,
        default: defaults,
        expected: `an array of at most ${MAX_LINES} line tables, each with text of at most 4 KiB and optional style fields`,
        example,
        parse: (raw) => {
            if (!Array.isArray(raw) || raw.length > MAX_LINES || !raw.every(isTemplateLine)) return { ok: false };
            return { ok: true, value: raw.map(copyTemplateLine) };
        },
        format,
    };
}

function formatInlineTableArray(values: readonly Record<string, unknown>[]): string {
    return `[${values
        .map(
            (value) =>
                `{ ${Object.entries(value)
                    .map(([key, item]) => `${key} = ${formatTomlValue(item)}`)
                    .join(', ')} }`,
        )
        .join(', ')}]`;
}

function formatTomlValue(value: unknown): string {
    if (typeof value === 'string') return tomlString(value);
    if (typeof value === 'boolean') return String(value);
    throw new TypeError('Unsupported template config value');
}

function lineFields(line: TemplateLineConfig): Record<string, unknown> {
    return {
        text: line.text,
        ...(line.color === undefined ? {} : { color: line.color }),
        ...(line.bold === undefined ? {} : { bold: line.bold }),
        ...(line.italic === undefined ? {} : { italic: line.italic }),
        ...(line.underlined === undefined ? {} : { underlined: line.underlined }),
        ...(line.strikethrough === undefined ? {} : { strikethrough: line.strikethrough }),
    };
}

function isTemplateLine(value: unknown): value is TemplateLineConfig {
    if (!isRecord(value) || typeof value.text !== 'string' || !isTemplate(value.text)) return false;
    if (
        Object.keys(value).some(
            (key) => !['text', 'color', 'bold', 'italic', 'underlined', 'strikethrough'].includes(key),
        )
    )
        return false;
    return (
        (value.color === undefined || (typeof value.color === 'string' && RGB_COLOR.test(value.color))) &&
        (value.bold === undefined || typeof value.bold === 'boolean') &&
        (value.italic === undefined || typeof value.italic === 'boolean') &&
        (value.underlined === undefined || typeof value.underlined === 'boolean') &&
        (value.strikethrough === undefined || typeof value.strikethrough === 'boolean')
    );
}

function copyTemplateLine(line: TemplateLineConfig): TemplateLineConfig {
    return { ...line };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function isTemplate(value: string): boolean {
    try {
        compileTemplate(value);
        return true;
    } catch {
        return false;
    }
}
