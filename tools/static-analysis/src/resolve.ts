import { dirname } from 'node:path';
import { build, type ImportKind, type PluginBuild } from 'esbuild';
import type { ResolutionSettings } from './types.ts';

/** Resolves a dependency and preserves esbuild's disabled-browser-module boundary. */
export async function resolveDependency(
    builder: PluginBuild,
    projectRoot: string,
    settings: ResolutionSettings,
    importer: string,
    specifier: string,
    kind: ImportKind,
) {
    const result = await builder.resolve(specifier, { importer, resolveDir: dirname(importer), kind });
    if (result.errors.length || result.external || (settings.platform && settings.platform !== 'browser'))
        return result;
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
        stdin: { contents, sourcefile: importer, resolveDir: dirname(importer), loader: 'js' },
        plugins: [
            {
                name: 'empty-resolver-targets',
                setup(probeBuilder) {
                    probeBuilder.onLoad({ filter: /.*/ }, () => ({ contents: '', loader: 'js' }));
                },
            },
        ],
    });
    if (Object.keys(probe.metafile?.inputs ?? {}).some((path) => path.startsWith('(disabled):'))) {
        return { ...result, external: true };
    }
    return result;
}
