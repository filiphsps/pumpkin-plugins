import {
    bool,
    type ConfigStore,
    ConfigSyntaxError,
    type ConfigValues,
    defineConfig,
    describeConfig,
    type Field,
    int,
    loadConfig,
    MANAGED_NOTE,
    type RenderOptions,
    section,
    str,
    tomlString,
} from '@pumpkin-plugins/config';
import { PLUGIN_NAME } from './name.ts';
import type { SortRule } from './sorting.ts';
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

/** One configured sorting key. */
export interface ConfigSortRule extends SortRule {}

const defaultHeader: readonly TemplateLineConfig[] = [{ text: 'Welcome %player_name%', color: '#FFB347' }];
const defaultFooter: readonly TemplateLineConfig[] = [{ text: '%server_online% players online', color: '#AAAAAA' }];
const defaultRules: readonly ConfigSortRule[] = [];

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
            provider: str({ description: 'Pumpkin plugin that supplies placeholder values.', default: 'PumpkinPIE' }),
            missing_provider: str({
                description:
                    'Text to show when PumpkinPIE is unavailable: `literal` keeps tokens, `empty` removes them.',
                default: 'literal',
            }),
            unresolved: str({
                description: 'Text to show for unresolved identifiers: `literal` keeps tokens, `empty` removes them.',
                default: 'literal',
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
            text: str({ description: 'Name template for each listed player.', default: '%player_name%' }),
            color: str({ description: 'Optional RGB text color in `#RRGGBB` form.', default: '#FFFFFF' }),
            bold: bool({ description: 'Render the row name in bold.', default: false }),
            italic: bool({ description: 'Render the row name in italics.', default: false }),
            underlined: bool({ description: 'Underline the row name.', default: false }),
            strikethrough: bool({ description: 'Strike through the row name.', default: false }),
        },
    }),
    sorting: section({
        description: 'Global Java player-list ordering. Rules stay disabled until native client order is verified.',
        fields: { rules: sortRulesField(defaultRules) },
    }),
    objective: section({
        description: 'Java player-list numeric objective. It is not enabled until client behavior is verified.',
        fields: {
            enabled: bool({ description: 'Show a numeric objective in the Java player list.', default: false }),
            value: str({ description: 'Value source reserved for the verified objective adapter.', default: 'ping' }),
        },
    }),
    bedrock: section({
        description: 'Native Bedrock features.',
        fields: {
            objective_enabled: bool({
                description: 'Show a numeric objective in the native Bedrock player list.',
                default: false,
            }),
        },
    }),
});

/** The validated shape returned by the config package. */
export type TabDisplayConfig = ConfigValues<typeof configSchema>;

/** What is invalid about a candidate configuration. */
export interface ConfigIssue {
    readonly path: string;
    readonly reason: string;
}

/** Validation result before a configuration is swapped into the running service. */
export type ConfigValidation =
    | { readonly kind: 'valid'; readonly config: TabDisplayConfig }
    | { readonly kind: 'invalid'; readonly issues: readonly ConfigIssue[] };

/** A file or semantic config validation error. */
export class TabDisplayConfigError extends Error {
    /** The individual config paths that failed validation. */
    readonly issues: readonly ConfigIssue[];

    constructor(issues: readonly ConfigIssue[]) {
        super(issues.map(({ path, reason }) => `${path}: ${reason}`).join('; '));
        this.name = 'TabDisplayConfigError';
        this.issues = issues;
    }
}

/** Config section used by generated plugin metadata. */
export const configInfo = describeConfig(configSchema, CONFIG_FILE, CONFIG_RENDER_OPTIONS);

/** Loads values from a config store and rejects invalid candidates before the caller swaps them. */
export function loadTabDisplayConfig(store: ConfigStore): {
    readonly config: TabDisplayConfig;
    readonly warnings: readonly string[];
} {
    let loaded: ReturnType<typeof loadConfig<typeof configSchema>>;
    try {
        loaded = loadConfig(configSchema, store, CONFIG_RENDER_OPTIONS);
    } catch (error) {
        if (error instanceof ConfigSyntaxError) {
            throw new TabDisplayConfigError([{ path: CONFIG_FILE, reason: `invalid TOML (${error.message})` }]);
        }
        throw error;
    }
    if (loaded.warnings.length > 0) {
        throw new TabDisplayConfigError(loaded.warnings.map((warning) => ({ path: CONFIG_FILE, reason: warning })));
    }
    const checked = validateConfig(loaded.values);
    if (checked.kind === 'invalid') throw new TabDisplayConfigError(checked.issues);
    return { config: checked.config, warnings: loaded.warnings };
}

/** Validates supported settings, limits and feature capability gates. */
export function validateConfig(value: unknown): ConfigValidation {
    const issues: ConfigIssue[] = [];
    if (!isRecord(value)) return invalid([{ path: 'config', reason: 'must be a table' }]);

    if (!isRecord(value.general)) add(issues, 'general', 'must be a table');
    else {
        if (value.general.version !== 1) add(issues, 'general.version', 'must be 1');
        if (typeof value.general.enabled !== 'boolean') add(issues, 'general.enabled', 'must be true or false');
        if (!isInteger(value.general.refresh_ticks, 1, 1200))
            add(issues, 'general.refresh_ticks', 'must be an integer from 1 to 1200');
        if (!isInteger(value.general.max_players, 1, 5000))
            add(issues, 'general.max_players', 'must be an integer from 1 to 5000');
    }

    if (!isRecord(value.placeholders)) add(issues, 'placeholders', 'must be a table');
    else {
        if (typeof value.placeholders.provider !== 'string' || value.placeholders.provider.length === 0)
            add(issues, 'placeholders.provider', 'must name a Pumpkin plugin');
        for (const key of ['missing_provider', 'unresolved'] as const) {
            if (value.placeholders[key] !== 'literal' && value.placeholders[key] !== 'empty')
                add(issues, `placeholders.${key}`, 'must be `literal` or `empty`');
        }
    }

    validateLineSection(value.header, 'header', issues);
    validateLineSection(value.footer, 'footer', issues);
    validateEntry(value.entry, issues);
    validateSorting(value.sorting, issues);
    validateObjective(value.objective, 'objective.enabled', issues);
    if (!isRecord(value.bedrock)) add(issues, 'bedrock', 'must be a table');
    else {
        if (typeof value.bedrock.objective_enabled !== 'boolean')
            add(issues, 'bedrock.objective_enabled', 'must be true or false');
        else if (value.bedrock.objective_enabled)
            add(
                issues,
                'bedrock.objective_enabled',
                'unsupported: the native Bedrock player-list objective is not verified',
            );
    }

    if (issues.length > 0) return invalid(issues);
    return { kind: 'valid', config: value as unknown as TabDisplayConfig };
}

function templateLinesField(
    description: string,
    defaults: readonly TemplateLineConfig[],
): Field<readonly TemplateLineConfig[]> {
    const format = (lines: readonly TemplateLineConfig[]) =>
        formatInlineTableArray(lines.map((line) => lineFields(line)));
    return {
        type: 'string',
        description: `${description} Use a TOML array of inline tables, for example [{ text = "Welcome %player_name%", color = "#FFB347" }].`,
        default: defaults,
        expected: 'an array of line tables with text and optional style fields',
        example: format(defaults),
        parse: (raw) => {
            if (!Array.isArray(raw) || !raw.every(isTemplateLine)) return { ok: false };
            return { ok: true, value: raw.map(copyTemplateLine) };
        },
        format,
    };
}

function sortRulesField(defaults: readonly ConfigSortRule[]): Field<readonly ConfigSortRule[]> {
    const format = (rules: readonly ConfigSortRule[]) =>
        formatInlineTableArray(rules.map((rule) => ({ kind: rule.kind, direction: rule.direction })));
    return {
        type: 'string',
        description:
            'Reserved sorting keys. Non-empty rules are rejected until native Java order direction is verified.',
        default: defaults,
        expected: 'an array of name or ping sort rule tables',
        example: format(defaults),
        parse: (raw) =>
            Array.isArray(raw) && raw.every(isSortRule)
                ? { ok: true, value: raw.map((rule) => ({ ...rule })) }
                : { ok: false },
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
    if (!isRecord(value) || typeof value.text !== 'string') return false;
    if (
        Object.keys(value).some(
            (key) => !['text', 'color', 'bold', 'italic', 'underlined', 'strikethrough'].includes(key),
        )
    )
        return false;
    return (
        (value.color === undefined || typeof value.color === 'string') &&
        (value.bold === undefined || typeof value.bold === 'boolean') &&
        (value.italic === undefined || typeof value.italic === 'boolean') &&
        (value.underlined === undefined || typeof value.underlined === 'boolean') &&
        (value.strikethrough === undefined || typeof value.strikethrough === 'boolean')
    );
}

function copyTemplateLine(line: TemplateLineConfig): TemplateLineConfig {
    return { ...line };
}

function isSortRule(value: unknown): value is ConfigSortRule {
    return (
        isRecord(value) &&
        Object.keys(value).every((key) => key === 'kind' || key === 'direction') &&
        (value.kind === 'name' || value.kind === 'ping') &&
        (value.direction === 'ascending' || value.direction === 'descending')
    );
}

function validateLineSection(value: unknown, path: string, issues: ConfigIssue[]): void {
    if (!isRecord(value) || !Array.isArray(value.lines)) {
        add(issues, `${path}.lines`, 'must be an array of line tables');
        return;
    }
    if (value.lines.length > 64) add(issues, `${path}.lines`, 'must contain no more than 64 lines');
    value.lines.forEach((line, index) => {
        const at = `${path}.lines[${index}]`;
        if (!isTemplateLine(line)) {
            add(issues, at, 'must contain text and optional style fields');
            return;
        }
        try {
            compileTemplate(line.text);
        } catch (error) {
            add(issues, `${at}.text`, errorMessage(error));
        }
        if (line.color !== undefined && !/^#[\da-fA-F]{6}$/.test(line.color))
            add(issues, `${at}.color`, 'must be an RGB color in `#RRGGBB` form');
    });
}

function validateEntry(value: unknown, issues: ConfigIssue[]): void {
    if (!isRecord(value)) {
        add(issues, 'entry', 'must be a table');
        return;
    }
    if (typeof value.enabled !== 'boolean') add(issues, 'entry.enabled', 'must be true or false');
    if (typeof value.text !== 'string') add(issues, 'entry.text', 'must be text');
    else {
        try {
            compileTemplate(value.text);
        } catch (error) {
            add(issues, 'entry.text', errorMessage(error));
        }
    }
    if (typeof value.color !== 'string' || !/^#[\da-fA-F]{6}$/.test(value.color))
        add(issues, 'entry.color', 'must be an RGB color in `#RRGGBB` form');
    for (const key of ['bold', 'italic', 'underlined', 'strikethrough'] as const) {
        if (typeof value[key] !== 'boolean') add(issues, `entry.${key}`, 'must be true or false');
    }
}

function validateSorting(value: unknown, issues: ConfigIssue[]): void {
    if (!isRecord(value) || !Array.isArray(value.rules)) {
        add(issues, 'sorting.rules', 'must be an array of sort rule tables');
        return;
    }
    const seen = new Set<string>();
    for (const rule of value.rules) {
        if (!isSortRule(rule)) {
            add(issues, 'sorting.rules', 'each rule needs a supported kind and direction');
            return;
        }
        if (seen.has(rule.kind)) {
            add(issues, 'sorting.rules', `duplicate ${rule.kind} sort key`);
            return;
        }
        seen.add(rule.kind);
    }
    if (value.rules.length > 0)
        add(issues, 'sorting.rules', 'unsupported: native Java tab order direction is not verified on a client');
}

function validateObjective(value: unknown, path: string, issues: ConfigIssue[]): void {
    const sectionName = path.slice(0, path.indexOf('.'));
    if (!isRecord(value)) {
        add(issues, sectionName, 'must be a table');
        return;
    }
    if (typeof value.enabled !== 'boolean') add(issues, path, 'must be true or false');
    else if (value.enabled) add(issues, path, 'unsupported: player-list objectives are not verified for this release');
    if (sectionName === 'objective' && value.value !== 'ping') add(issues, 'objective.value', 'must be `ping`');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function isInteger(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function add(issues: ConfigIssue[], path: string, reason: string): void {
    issues.push({ path, reason });
}

function invalid(issues: readonly ConfigIssue[]): ConfigValidation {
    return { kind: 'invalid', issues };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
