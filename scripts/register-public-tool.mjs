import fs from 'node:fs';
import * as path from 'node:path';
import { publicToolReleaseTitleOptions } from './utils/release-pr-title.mjs';

const FIRST_TOOL_VERSION = '0.1.0';
const FIRST_MANIFEST_VERSION = '0.0.0';

/** Registers an existing public tool in Release Please's config and version manifest.
 *
 * @param {string} root - Repository root containing the tool and both Release Please files.
 * @param {string} toolDirectory - Workspace path under `tools/`, for example `tools/codemod` or
 *   `tools/apis/pumpkin-pie-api`.
 * @returns {{ configChanged: boolean; manifestChanged: boolean }} Which files were updated.
 * @throws {Error} If the tool path, package, version or existing release registration is invalid.
 */
export function registerPublicTool(root, toolDirectory) {
    if (!/^tools(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(toolDirectory)) {
        throw new Error('Public tool path must be under tools/ and use kebab-case path segments.');
    }

    const packagePath = path.join(root, toolDirectory, 'package.json');
    const packageJson = readJson(packagePath);
    const component = path.basename(toolDirectory);
    if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
        throw new Error(`${packagePath} must have a package name.`);
    }
    if (packageJson.private === true || packageJson.publishConfig?.access !== 'public') {
        throw new Error(`${packagePath} must be publishable with publishConfig.access set to public.`);
    }
    if (packageJson.version !== FIRST_TOOL_VERSION) {
        throw new Error(`${packagePath} must start at ${FIRST_TOOL_VERSION} before its first public release.`);
    }
    const releaseTitleOptions = publicToolReleaseTitleOptions(packageJson.name, component);

    const configPath = path.join(root, 'release-please-config.json');
    const manifestPath = path.join(root, '.release-please-manifest.json');
    const config = readJson(configPath);
    const manifest = readJson(manifestPath);
    if (!config.packages || typeof config.packages !== 'object' || Array.isArray(config.packages)) {
        throw new Error(`${configPath} must contain a packages object.`);
    }

    const existingConfig = config.packages[toolDirectory];
    const manifestVersion = manifest[toolDirectory];
    if (manifestVersion !== undefined && manifestVersion !== FIRST_MANIFEST_VERSION) {
        throw new Error(
            `${manifestPath} already has ${toolDirectory} at ${manifestVersion}; this command only registers first releases.`,
        );
    }
    if (existingConfig && existingConfig.component !== component) {
        throw new Error(`${configPath} has a conflicting component for ${toolDirectory}.`);
    }
    if (
        existingConfig &&
        existingConfig['release-as'] !== undefined &&
        existingConfig['release-as'] !== FIRST_TOOL_VERSION
    ) {
        throw new Error(
            `${configPath} has a conflicting release-as for ${toolDirectory}; expected ${FIRST_TOOL_VERSION}.`,
        );
    }

    if (!existingConfig)
        config.packages[toolDirectory] = { component, ...releaseTitleOptions, 'release-as': FIRST_TOOL_VERSION };
    else {
        if (existingConfig['release-as'] === undefined) existingConfig['release-as'] = FIRST_TOOL_VERSION;
        Object.assign(existingConfig, releaseTitleOptions);
    }
    if (manifestVersion === undefined) manifest[toolDirectory] = FIRST_MANIFEST_VERSION;
    config.packages = Object.fromEntries(
        Object.entries(config.packages).sort(([left], [right]) => left.localeCompare(right)),
    );
    const sortedManifest = Object.fromEntries(
        Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right)),
    );

    const configText = `${JSON.stringify(config, null, 4)}\n`;
    const manifestText = `${JSON.stringify(sortedManifest, null, 4)}\n`;
    const configChanged = configText !== fs.readFileSync(configPath, 'utf8');
    const manifestChanged = manifestText !== fs.readFileSync(manifestPath, 'utf8');
    if (configChanged) fs.writeFileSync(configPath, configText);
    if (manifestChanged) fs.writeFileSync(manifestPath, manifestText);
    return { configChanged, manifestChanged };
}

/** Parses one JSON file and verifies its root value is an object. */
function readJson(filePath) {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${filePath} must contain a JSON object.`);
    }
    return value;
}

/** Runs the registration command for a tool path supplied as the first argument. */
function main(args = process.argv.slice(2)) {
    const [toolDirectory, ...extraArguments] = args;
    if (!toolDirectory || extraArguments.length > 0) {
        throw new Error('Usage: pnpm register:tool tools/<path>');
    }
    const root = path.resolve(import.meta.dirname, '..');
    const result = registerPublicTool(root, toolDirectory);
    const updated = [
        result.configChanged ? 'release-please-config.json' : undefined,
        result.manifestChanged ? '.release-please-manifest.json' : undefined,
    ].filter(Boolean);
    console.log(
        updated.length
            ? `Registered ${toolDirectory}: updated ${updated.join(' and ')}.`
            : `${toolDirectory} is already registered.`,
    );
}

if (import.meta.main) {
    try {
        main();
    } catch (error) {
        console.error(`register:tool: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
