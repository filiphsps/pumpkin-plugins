import { dirname, isAbsolute, resolve } from 'node:path';
import ts from 'typescript';
import type { ResolutionSettings } from './types.ts';

/** Builds a cached TypeScript resolver for the consumer's explicit or discovered tsconfig. */
export function typeResolver(projectRoot: string, settings: ResolutionSettings) {
    const cache = new Map<string, ts.CompilerOptions>();
    return (specifier: string, importer: string, require: boolean): string | undefined => {
        const configPath = settings.tsconfig
            ? resolve(projectRoot, settings.tsconfig)
            : ts.findConfigFile(dirname(importer), ts.sys.fileExists);
        const key = configPath ?? projectRoot;
        let options = cache.get(key);
        if (!options) {
            let config = {};
            if (settings.tsconfigRaw !== undefined) {
                if (typeof settings.tsconfigRaw === 'string') {
                    const loaded = ts.parseConfigFileTextToJson('tsconfig.json', settings.tsconfigRaw);
                    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
                    config = loaded.config;
                } else config = settings.tsconfigRaw;
            } else if (configPath) {
                const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
                if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
                config = loaded.config;
            }
            const parsed = ts.parseJsonConfigFileContent(
                config,
                { ...ts.sys, readDirectory: () => [] },
                settings.tsconfigRaw !== undefined ? projectRoot : configPath ? dirname(configPath) : projectRoot,
            );
            const errors = parsed.errors.filter((error) => error.code !== 18002 && error.code !== 18003);
            if (errors.length)
                throw new Error(
                    errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
                );
            options = {
                ...parsed.options,
                moduleResolution: parsed.options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
                allowJs: true,
                resolveJsonModule: true,
                customConditions: [
                    ...(settings.conditions ?? parsed.options.customConditions ?? []),
                    ...(settings.platform === 'neutral' ? [] : [settings.platform ?? 'browser']),
                    ...(settings.conditions === undefined && settings.platform !== 'neutral' ? ['module'] : []),
                ],
                preserveSymlinks: settings.preserveSymlinks ?? parsed.options.preserveSymlinks,
            };
            cache.set(key, options);
        }
        const alias = Object.keys(settings.alias ?? {})
            .sort((a, b) => b.length - a.length)
            .find((name) => specifier === name || specifier.startsWith(`${name}/`));
        let containingFile = importer;
        if (alias) {
            specifier = (settings.alias?.[alias] ?? alias) + specifier.slice(alias.length);
            containingFile = resolve(projectRoot, '__static_analysis__.ts');
            if (specifier.startsWith('.')) specifier = resolve(projectRoot, specifier);
        }
        const result = ts.resolveModuleName(
            specifier,
            containingFile,
            options,
            ts.sys,
            undefined,
            undefined,
            require ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
        ).resolvedModule;
        if (!result) return undefined;
        const path = isAbsolute(result.resolvedFileName)
            ? result.resolvedFileName
            : resolve(projectRoot, result.resolvedFileName);
        return settings.preserveSymlinks ? path : (ts.sys.realpath?.(path) ?? path);
    };
}
