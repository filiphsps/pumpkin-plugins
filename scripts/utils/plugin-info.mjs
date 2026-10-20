// Loads a plugin's info module for the release scripts, which write its name into GitHub outputs
// and signing manifests.
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Whether `child` is a path below `parent`, not `parent` itself. */
export function isInside(parent, child) {
    const childPath = path.relative(parent, child);
    return (
        childPath !== '' && childPath !== '..' && !childPath.startsWith(`..${path.sep}`) && !path.isAbsolute(childPath)
    );
}

/**
 * Imports the info module named by `pumpkinPlugin.info` (default `src/info.ts`) and returns its
 * `info` or default export.
 *
 * @param pluginDir Plugin package directory.
 * @param pkg The plugin's parsed package.json.
 * @throws If the info path leaves the package or the info has no non-empty, single-line name.
 */
export async function loadPluginInfo(pluginDir, pkg) {
    const file = path.resolve(pluginDir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
    if (!isInside(path.resolve(pluginDir), file)) throw new Error(`${pluginDir} plugin info path escapes the package`);
    const module = await import(pathToFileURL(file).href);
    const info = module.info ?? module.default;
    if (typeof info?.name !== 'string' || !info.name.trim() || /[\r\n\u2028\u2029]/u.test(info.name)) {
        throw new Error(`${file} must export an info object with a single-line name`);
    }
    return { file, info };
}
