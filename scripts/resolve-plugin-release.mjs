import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Command } from 'commander';
import { isInside, loadPluginInfo } from './utils/plugin-info.mjs';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Resolve a plugin release tag using the configuration and package files at that tag. */
export async function resolvePluginRelease(root, tag) {
    const repositoryRoot = resolve(root);
    const config = readJson(join(repositoryRoot, 'release-please-config.json'));
    const manifest = readJson(join(repositoryRoot, '.release-please-manifest.json'));
    const matches = Object.entries(config.packages ?? {}).filter(
        ([path, entry]) =>
            /^packages\/[^/]+$/.test(path) &&
            typeof entry.component === 'string' &&
            tag.startsWith(`${entry.component}-v`),
    );
    if (matches.length !== 1) throw new Error(`No plugin release matches tag ${JSON.stringify(tag)}`);

    const [[packagePath, releaseConfig]] = matches;
    const version = tag.slice(`${releaseConfig.component}-v`.length);
    if (!VERSION_PATTERN.test(version)) throw new Error(`Tag ${JSON.stringify(tag)} has an invalid plugin version`);

    const packageDirectory = resolve(repositoryRoot, packagePath);
    if (!isInside(repositoryRoot, packageDirectory))
        throw new Error(`Plugin path escapes the source tree: ${packagePath}`);
    const packageJson = readJson(join(packageDirectory, 'package.json'));
    if (packageJson.version !== version) {
        throw new Error(`${packagePath} package version is ${packageJson.version}, but tag version is ${version}`);
    }
    if (manifest[packagePath] !== version) {
        throw new Error(`${packagePath} manifest version is ${manifest[packagePath]}, but tag version is ${version}`);
    }

    const staticHermesRuntime = join(repositoryRoot, 'tools/static-hermes-runtime/package.json');
    const engine = packageJson.pumpkinPlugin?.engine ?? (existsSync(staticHermesRuntime) ? 'static-hermes' : 'quickjs');
    if (engine !== 'quickjs' && engine !== 'static-hermes') {
        throw new Error(`${packagePath} declares an unsupported plugin engine: ${JSON.stringify(engine)}`);
    }

    const pluginName = (await loadPluginInfo(packageDirectory, packageJson)).info.name;

    const output = packageJson.pumpkinPlugin?.output;
    if (typeof output !== 'string' || !output.endsWith('.wasm')) {
        throw new Error(`${packagePath}/package.json must declare a .wasm pumpkinPlugin.output`);
    }
    const outputPath = resolve(packageDirectory, output);
    if (!isInside(packageDirectory, outputPath))
        throw new Error(`${packagePath} plugin output path escapes the package`);

    return {
        path: packagePath,
        component: releaseConfig.component,
        version,
        engine,
        pluginName,
        wasmFile: `dist/${basename(packagePath)}.wasm`,
    };
}

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

if (import.meta.main) {
    const program = new Command()
        .name('resolve-plugin-release')
        .description('Resolve a plugin release tag using the source tree at that tag.')
        .argument('<tag>', 'Plugin release tag')
        .argument('[source-root]', 'Source tree root', process.cwd())
        .parse(process.argv);
    const [tag, root] = program.processedArgs;
    const release = await resolvePluginRelease(root, tag);
    if (process.env.GITHUB_OUTPUT) {
        for (const [key, value] of Object.entries(release)) {
            appendFileSync(
                process.env.GITHUB_OUTPUT,
                `${key === 'pluginName' ? 'plugin_name' : key === 'wasmFile' ? 'wasm_file' : key}=${value}\n`,
            );
        }
    }
    console.log(`Resolved ${tag} to ${release.path} (${release.pluginName} ${release.version}).`);
}
