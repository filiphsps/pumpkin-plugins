import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { PluginEngine, StaticHermesGc, StaticHermesRuntime } from './plugin-config.ts';

/** A message emitted by the shared plugin build output formatter. */
export type BuildOutputMessage =
    | { type: 'warning'; message: string }
    | {
          type: 'bundle';
          entry: string;
          engine: PluginEngine;
          runtimeVariant?: StaticHermesRuntime;
          gcVariant?: StaticHermesGc;
          parseTypeScript?: boolean;
      }
    | {
          type: 'componentize';
          engine: PluginEngine;
          runtimeVariant?: StaticHermesRuntime;
          gcVariant?: StaticHermesGc;
          parseTypeScript?: boolean;
          selections?: {
              wasiImports: string[];
              wasiMethods?: string[];
              apiMethods?: string[];
              eventTypes?: string[];
          };
      }
    | { type: 'built'; output: string; sizeBytes: number }
    | { type: 'error'; message: string };

/** Render a build event in the common console format. */
export function formatBuildOutput(message: BuildOutputMessage): string {
    if (message.type === 'error' || message.type === 'warning') {
        const formatLine = message.type === 'error' ? ansi.named.error : ansi.named.value;
        return message.message
            .split(/\r?\n/)
            .map((line, index) => {
                const prefix = index === 0 ? `${message.type === 'error' ? 'Error' : 'Warning'}: ` : '  ';
                return `[build] ${prefix}${formatLine(line)}`;
            })
            .join('\n');
    }
    if (message.type === 'built') {
        const size = `${(message.sizeBytes / 1024).toFixed(0)} KiB`;
        return `[build] Built ${ansi.named.name(message.output)} (${ansi.named.number(size)})`;
    }

    const runtime = ansi.named.name(
        runtimeLabel(message.engine, message.runtimeVariant, message.gcVariant, message.parseTypeScript ?? false),
    );
    if (message.type === 'bundle') return `[build] Bundling ${ansi.named.name(message.entry)} with ${runtime}...`;

    const output = `[build] Componentizing with ${runtime}...`;
    if (message.selections === undefined) return output;

    return [
        output,
        formatSelectionOption('--wasi-imports', message.selections.wasiImports, 'no imports'),
        formatSelectionOption('--wasi-methods', message.selections.wasiMethods, 'all imported WASI operations'),
        formatSelectionOption('--api-methods', message.selections.apiMethods, 'all imported Pumpkin API operations'),
        formatSelectionOption('--event-types', message.selections.eventTypes, 'all event variants'),
    ].join('\n');
}

/**
 * Write one build event to the appropriate console stream.
 *
 * @remarks With `PUMPKIN_PLUGINS_BUILD_LOG_FORMAT=json`, it writes the event as one JSON object instead of a
 * `[build]` line, so scripts can read what the build selected without parsing text.
 */
export function printBuildOutput(message: BuildOutputMessage): void {
    const formatted =
        process.env.PUMPKIN_PLUGINS_BUILD_LOG_FORMAT === 'json' ? JSON.stringify(message) : formatBuildOutput(message);
    if (message.type === 'error') console.error(formatted);
    else if (message.type === 'warning') console.warn(formatted);
    else console.log(formatted);
}

function runtimeLabel(
    engine: PluginEngine,
    runtimeVariant: StaticHermesRuntime | undefined,
    gcVariant: StaticHermesGc | undefined,
    parseTypeScript: boolean,
): string {
    if (engine === 'quickjs') return 'QuickJS';
    const options = [runtimeVariant, gcVariant, ...(parseTypeScript ? ['TS parser'] : [])].filter(
        (option): option is string => option !== undefined,
    );
    return `Static Hermes${options.length === 0 ? '' : ` (${options.join(', ')})`}`;
}

function formatSelectionOption(option: string, selection: string[] | undefined, omittedValue: string): string {
    const value = selection === undefined ? `(omitted; ${omittedValue})` : JSON.stringify(selection);
    return `[build]   ${ansi.named.name(option)} ${ansi.named.value(value)}`;
}
