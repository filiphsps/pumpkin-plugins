import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { PluginEngine, StaticHermesRuntime } from './plugin-config.ts';

/** A message emitted by the shared plugin build output formatter. */
export type BuildOutputMessage =
    | {
          type: 'bundle';
          entry: string;
          engine: PluginEngine;
          runtimeVariant?: StaticHermesRuntime;
          parseTypeScript?: boolean;
      }
    | {
          type: 'componentize';
          engine: PluginEngine;
          runtimeVariant?: StaticHermesRuntime;
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
    if (message.type === 'error') {
        return message.message
            .split(/\r?\n/)
            .map((line, index) => {
                const prefix = index === 0 ? 'Error: ' : '  ';
                return `[build] ${prefix}${ansi.named.error(line)}`;
            })
            .join('\n');
    }
    if (message.type === 'built') {
        const size = `${(message.sizeBytes / 1024).toFixed(0)} KiB`;
        return `[build] Built ${ansi.named.name(message.output)} (${ansi.named.number(size)})`;
    }

    const runtime = ansi.named.name(
        runtimeLabel(message.engine, message.runtimeVariant, message.parseTypeScript ?? false)
    );
    if (message.type === 'bundle') return `[build] Bundling ${ansi.named.name(message.entry)} with ${runtime}...`;

    const output = `[build] Componentizing with ${runtime}...`;
    if (message.selections === undefined) return output;

    return [
        output,
        formatSelectionOption('--wasi-imports', message.selections.wasiImports, 'no imports'),
        formatSelectionOption('--wasi-methods', message.selections.wasiMethods, 'all imported WASI operations'),
        formatSelectionOption('--api-methods', message.selections.apiMethods, 'all imported Pumpkin API operations'),
        formatSelectionOption('--event-types', message.selections.eventTypes, 'all event variants')
    ].join('\n');
}

/** Write one formatted build event to the appropriate console stream. */
export function printBuildOutput(message: BuildOutputMessage): void {
    const formatted = formatBuildOutput(message);
    if (message.type === 'error') console.error(formatted);
    else console.log(formatted);
}

function runtimeLabel(
    engine: PluginEngine,
    runtimeVariant: StaticHermesRuntime | undefined,
    parseTypeScript: boolean
): string {
    if (engine === 'quickjs') return 'QuickJS';
    const options = [runtimeVariant, ...(parseTypeScript ? ['-parse-ts'] : [])].filter(
        (option): option is string => option !== undefined
    );
    return `Static Hermes${options.length === 0 ? '' : ` (${options.join(', ')})`}`;
}

function formatSelectionOption(option: string, selection: string[] | undefined, omittedValue: string): string {
    const value = selection === undefined ? `(omitted; ${omittedValue})` : JSON.stringify(selection);
    return `[build]   ${ansi.named.name(option)} ${ansi.named.value(value)}`;
}
