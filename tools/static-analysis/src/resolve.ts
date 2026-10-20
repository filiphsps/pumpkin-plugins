import { dirname } from 'node:path';
import { build, type ImportKind, type PluginBuild } from 'esbuild';
import type { ResolutionSettings } from './types.ts';

/** Disabled-browser-module probe results keyed by importer directory, kind and specifier. */
export type BrowserProbeCache = Map<string, Promise<boolean>>;

/** Resolves a dependency and preserves esbuild's disabled-browser-module boundary. */
export async function resolveDependency(
    builder: PluginBuild,
    projectRoot: string,
    settings: ResolutionSettings,
    probes: BrowserProbeCache,
    importer: string,
    specifier: string,
    kind: ImportKind,
) {
    const resolveDir = dirname(importer);
    const result = await builder.resolve(specifier, { importer, resolveDir, kind });
    if (result.errors.length || result.external || (settings.platform && settings.platform !== 'browser'))
        return result;
    const key = JSON.stringify([resolveDir, kind, specifier]);
    let disabled = probes.get(key);
    if (!disabled) {
        disabled = isDisabledInBrowser(projectRoot, settings, resolveDir, specifier, kind);
        probes.set(key, disabled);
    }
    return (await disabled) ? { ...result, external: true } : result;
}

async function isDisabledInBrowser(
    projectRoot: string,
    settings: ResolutionSettings,
    resolveDir: string,
    specifier: string,
    kind: ImportKind,
): Promise<boolean> {
    // build.resolve omits esbuild's internal browser:false flag. A source-free probe
    // exposes that flag in the metafile; every target is replaced with an empty module.
    const literal = JSON.stringify(specifier);
    const contents =
        kind === 'require-call'
            ? `require(${literal});`
            : kind === 'dynamic-import'
              ? `import(${literal});`
              : `import ${literal};`;
    const probe = await build({
        ...settings,
        absWorkingDir: projectRoot,
        bundle: true,
        write: false,
        metafile: true,
        logLevel: 'silent',
        stdin: { contents, resolveDir, loader: 'js' },
        plugins: [
            {
                name: 'empty-resolver-targets',
                setup(probeBuilder) {
                    probeBuilder.onLoad({ filter: /.*/ }, () => ({ contents: '', loader: 'js' }));
                },
            },
        ],
    });
    return Object.keys(probe.metafile?.inputs ?? {}).some((path) => path.startsWith('(disabled):'));
}
