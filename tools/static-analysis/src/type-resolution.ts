import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { ResolutionSettings } from './types.ts';

/** Builds a cached TypeScript resolver for the consumer's explicit or discovered tsconfig. */
export function typeResolver(projectRoot: string, settings: ResolutionSettings) {
    const cache = new Map<string, ts.CompilerOptions>();
    return (specifier: string, importer: string, require: boolean): string | undefined => {
        const insideDependency = importer.split(sep).includes('node_modules');
        const configPath = settings.tsconfig
            ? resolve(projectRoot, settings.tsconfig)
            : ts.findConfigFile(insideDependency ? projectRoot : dirname(importer), ts.sys.fileExists);
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
        const resolveTypeModule = (compilerOptions: ts.CompilerOptions, host: ts.ModuleResolutionHost = ts.sys) =>
            ts.resolveModuleName(
                specifier,
                containingFile,
                compilerOptions,
                host,
                undefined,
                undefined,
                require ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            ).resolvedModule;
        let result = resolveTypeModule(options);
        if (
            !result &&
            settings.nodePaths?.length &&
            !specifier.startsWith('.') &&
            !isAbsolute(specifier) &&
            !specifier.startsWith('#') &&
            !specifier.includes(':')
        ) {
            result = resolveTypeModule(options, nodePathsTypeResolutionHost(projectRoot, settings.nodePaths));
        }
        if (!result) return undefined;
        const path = isAbsolute(result.resolvedFileName)
            ? result.resolvedFileName
            : resolve(projectRoot, result.resolvedFileName);
        return settings.preserveSymlinks ? path : (ts.sys.realpath?.(path) ?? path);
    };
}

/** Adds esbuild's extra module search roots to TypeScript's normal node_modules lookup. */
function nodePathsTypeResolutionHost(projectRoot: string, nodePaths: readonly string[]): ts.ModuleResolutionHost {
    const nodeModulesRoot = resolve(projectRoot, 'node_modules');
    const searchRoots = nodePaths.map((nodePath) => (isAbsolute(nodePath) ? nodePath : resolve(projectRoot, nodePath)));
    const mappedPath = (filePath: string): string | undefined => {
        const suffix = relative(nodeModulesRoot, resolve(filePath));
        if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return undefined;
        for (const searchRoot of searchRoots) {
            const candidate = resolve(searchRoot, suffix);
            if (ts.sys.fileExists(candidate) || ts.sys.directoryExists(candidate)) return candidate;
        }
        return undefined;
    };
    const directPathExists = (filePath: string) => ts.sys.fileExists(filePath) || ts.sys.directoryExists(filePath);

    return {
        ...ts.sys,
        fileExists(filePath) {
            const direct = ts.sys.fileExists(filePath);
            const mapped = mappedPath(filePath);
            return direct || (mapped !== undefined && ts.sys.fileExists(mapped));
        },
        directoryExists(directoryPath) {
            if (resolve(directoryPath) === nodeModulesRoot) return true;
            const direct = ts.sys.directoryExists(directoryPath);
            const mapped = mappedPath(directoryPath);
            return direct || (mapped !== undefined && ts.sys.directoryExists(mapped));
        },
        readFile(filePath) {
            const direct = ts.sys.readFile(filePath);
            if (direct !== undefined) return direct;
            const mapped = mappedPath(filePath);
            return mapped === undefined ? undefined : ts.sys.readFile(mapped);
        },
        realpath(filePath) {
            const actual = directPathExists(filePath) ? filePath : (mappedPath(filePath) ?? filePath);
            return ts.sys.realpath?.(actual) ?? actual;
        },
        getDirectories(directoryPath) {
            const direct = ts.sys.getDirectories?.(directoryPath) ?? [];
            const searchDirectories =
                resolve(directoryPath) === nodeModulesRoot
                    ? searchRoots
                    : [mappedPath(directoryPath)].filter((path): path is string => path !== undefined);
            return [
                ...new Set([...direct, ...searchDirectories.flatMap((path) => ts.sys.getDirectories?.(path) ?? [])]),
            ];
        },
    };
}
