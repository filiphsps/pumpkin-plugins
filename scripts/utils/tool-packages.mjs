import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverComponents } from '@pumpkin-plugins/docs/node';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Finds tool workspaces that opt into public npm publishing in their package manifest. */
export function discoverPublicToolPackages(root = REPOSITORY_ROOT) {
    const packages = discoverComponents(root, 'tools')
        .map(({ directory, metadataFile }) => ({
            path: toWorkspacePath(root, directory),
            packageJson: readPackageJson(metadataFile),
        }))
        .filter(({ packageJson }) => packageJson.private !== true && packageJson.publishConfig?.access === 'public')
        .map(({ path: packagePath, packageJson }) => ({ path: packagePath, name: packageJson.name, packageJson }))
        .sort((left, right) => left.path.localeCompare(right.path));

    const names = new Set();
    for (const tool of packages) {
        if (typeof tool.name !== 'string' || tool.name.length === 0) {
            throw new Error(`${tool.path}/package.json must have a package name`);
        }
        if (names.has(tool.name)) throw new Error(`public tool package name is duplicated: ${tool.name}`);
        names.add(tool.name);
    }
    return packages;
}

/** Reads package versions by npm name for the public tools in one workspace. */
export function publicToolPackageVersions(root = REPOSITORY_ROOT) {
    return Object.fromEntries(
        discoverPublicToolPackages(root).map(({ path: packagePath, name, packageJson }) => {
            assertVersion(packageJson.version, `${name} in ${packagePath}/package.json version`);
            return [name, packageJson.version];
        }),
    );
}

/** Returns the Node version pinned for the workspace. */
export function nodeVersion(root = REPOSITORY_ROOT) {
    const version = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim().replace(/^v/, '');
    assertVersion(version, '.node-version');
    return version;
}

/** Returns the engine range supported by the workspace's pinned Node version. */
export function nodeEngineRange(root = REPOSITORY_ROOT) {
    return `>=${nodeVersion(root)}`;
}

/**
 * Parses a `tar -t` listing from any supported host platform.
 *
 * @param {string} listing - Newline-delimited tar entries.
 * @returns {string[]} Non-empty entry paths without platform line endings.
 */
export function parseTarEntries(listing) {
    return listing.split(/\r?\n/).filter(Boolean);
}

/** Finds embedded package manifests in a package tarball. */
export function embeddedPackageManifestEntries(entries) {
    return entries.filter((entry) => /^package\/.+\/package\.json$/.test(entry));
}

/**
 * Checks that packed package metadata still permits public npm publication.
 *
 * @param {Record<string, unknown>} packageJson - The packed package metadata to validate.
 * @param {string} expectedName - The package name in the source manifest.
 * @param {string} [root] - Workspace root containing `.node-version`.
 * @throws {Error} When the packed package differs from its source identity or publication requirements.
 */
export function assertPublicToolPackage(packageJson, expectedName, root = REPOSITORY_ROOT) {
    if (packageJson.name !== expectedName) {
        throw new Error(`Public tool package name must be ${expectedName}; received ${String(packageJson.name)}`);
    }
    if (packageJson.private === true) throw new Error(`${expectedName} must not be private`);
    if (packageJson.publishConfig?.access !== 'public') {
        throw new Error(`${expectedName} publishConfig.access must be public`);
    }
    const expectedEngine = nodeEngineRange(root);
    if (packageJson.engines?.node !== expectedEngine) {
        throw new Error(`${expectedName} engines.node must be ${expectedEngine}`);
    }
    assertPackedDependencySpecs(packageJson);
    assertVersion(packageJson.version, `${expectedName} version`);
}

/**
 * Rejects dependency fields that still contain pnpm-only workspace or catalog references.
 *
 * @param {Record<string, unknown>} packageJson - The packed package metadata to inspect.
 * @throws {Error} When a dependency field contains an unresolved pnpm specifier.
 */
export function assertPackedDependencySpecs(packageJson) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
        const dependencies = packageJson[field];
        if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
        for (const [packageName, spec] of Object.entries(dependencies)) {
            if (typeof spec === 'string' && /^(?:workspace|catalog):/.test(spec)) {
                throw new Error(`packed package has an unresolved dependency spec for ${packageName}: ${spec}`);
            }
        }
    }
}

/**
 * Orders selected public tools so each selected workspace dependency is published first.
 *
 * @param {string[]} selectedPaths - Tool workspace paths selected by the release workflow.
 * @param {string} [root] - Workspace root containing tool manifests.
 * @returns {string[]} Selected paths in dependency order.
 * @throws {Error} When a path is not a public tool, appears more than once, or creates a dependency cycle.
 */
export function orderPublicToolReleasePaths(selectedPaths, root = REPOSITORY_ROOT) {
    const publicTools = discoverPublicToolPackages(root);
    const toolsByPath = new Map(publicTools.map((tool) => [tool.path, tool]));
    const selected = new Set();
    for (const packagePath of selectedPaths) {
        if (!toolsByPath.has(packagePath)) throw new Error(`unknown public tool release path: ${String(packagePath)}`);
        if (selected.has(packagePath)) throw new Error(`duplicate public tool release path: ${packagePath}`);
        selected.add(packagePath);
    }

    const pathsByName = new Map(publicTools.map(({ path: packagePath, name }) => [name, packagePath]));
    const prerequisites = new Map(
        publicTools.map(({ path: packagePath }) => [
            packagePath,
            sourcePrerequisitePaths(root, packagePath, pathsByName),
        ]),
    );
    const remaining = new Set(selected);
    const ordered = [];
    while (remaining.size > 0) {
        const next = [...remaining]
            .sort((left, right) => left.localeCompare(right))
            .find((packagePath) =>
                [...(prerequisites.get(packagePath) ?? [])].every((dependency) => !remaining.has(dependency)),
            );
        if (!next) throw new Error(`public tool dependencies contain a cycle: ${[...remaining].join(', ')}`);
        remaining.delete(next);
        ordered.push(next);
    }
    return ordered;
}

/**
 * Resolves public packages required by a packed tool and its embedded project templates.
 *
 * @param {string} packagePath - Repository path identifying the public tool package.
 * @param {Record<string, unknown>} packageJson - Packed package metadata.
 * @param {Record<string, string>} [packageVersions] - Versions represented by packed public tools.
 * @param {Record<string, unknown>[]} [templatePackageJsons] - Embedded project manifests from the packed package.
 * @param {string} [root] - Workspace root used to discover public package names.
 * @returns {{ packageName: string; version: string }[]} Internal public production prerequisites.
 * @throws {Error} When a public dependency does not resolve to an exact package version.
 */
export function getPublicToolReleasePrerequisites(
    packagePath,
    packageJson,
    packageVersions = {},
    templatePackageJsons = [],
    root = REPOSITORY_ROOT,
) {
    const publicTools = discoverPublicToolPackages(root);
    const packageNames = new Set(publicTools.map(({ name }) => name));
    if (!publicTools.some((tool) => tool.path === packagePath)) {
        throw new Error(`unknown public tool release path: ${String(packagePath)}`);
    }

    const prerequisites = new Map();
    for (const dependency of publicDependencies(packageJson, packageNames)) {
        const expectedVersion = packageVersions[dependency.name];
        if (expectedVersion !== undefined && dependency.spec !== expectedVersion) {
            throw new Error(
                `${dependency.name} ${path.basename(packagePath)} dependency must resolve to packed version ${expectedVersion}; received ${String(dependency.spec)}`,
            );
        }
        addPrerequisite(prerequisites, dependency.name, dependency.spec, `${dependency.name} packed dependency`);
    }
    for (const templatePackageJson of templatePackageJsons) {
        for (const dependency of publicDependencies(templatePackageJson, packageNames)) {
            const expectedVersion = packageVersions[dependency.name];
            const version = templateDependencyVersion(dependency.spec, dependency.name, expectedVersion);
            addPrerequisite(prerequisites, dependency.name, version, `${dependency.name} template dependency`);
        }
    }
    return [...prerequisites].map(([packageName, version]) => ({ packageName, version }));
}

/**
 * Checks that a packed public tool contains files named by its entrypoints and excludes test sources.
 *
 * @param {string[]} entries - Tarball entries, including their `package/` prefix.
 * @param {string} packagePath - Repository path used in diagnostics.
 * @param {Record<string, unknown>} packageJson - Packed package metadata describing its entrypoints.
 * @throws {Error} When an entrypoint is missing or a development test source was packed.
 */
export function assertPublicToolPackageContents(entries, packagePath, packageJson) {
    for (const target of packageTargets(packageJson)) {
        const packedTarget = `package/${target.replace(/^\.\//, '')}`;
        if (!entries.some((entry) => matchesPackageTarget(entry, packedTarget))) {
            throw new Error(`${packagePath} packed package is missing ${packedTarget}`);
        }
    }

    const testSource = entries.find((entry) => /^package\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry));
    if (testSource) throw new Error(`${packagePath} packed package contains a development test source: ${testSource}`);
}

/**
 * Checks that embedded project manifests use the exact versions being packed for public tools.
 *
 * @param {Record<string, unknown>} packageJson - An embedded project manifest.
 * @param {Record<string, string>} versions - Package names and versions represented by packed tarballs.
 * @param {string} [root] - Workspace root used to discover public package names.
 * @throws {Error} When an embedded project declares a stale range for a public tool.
 */
export function assertPublicToolTemplateDependencies(packageJson, versions, root = REPOSITORY_ROOT) {
    const packageNames = new Set(discoverPublicToolPackages(root).map(({ name }) => name));
    for (const dependency of publicDependencies(packageJson, packageNames)) {
        const version = versions[dependency.name];
        assertVersion(version, `${dependency.name} packed version`);
        const expectedRange = `^${version}`;
        if (dependency.spec !== expectedRange) {
            throw new Error(
                `${dependency.name} template dependency must be ${expectedRange}; received ${String(dependency.spec)}`,
            );
        }
    }
}

/** Updates embedded tool templates to match the current public package versions. */
export function syncStarterToolDependencies(root) {
    const versions = publicToolPackageVersions(root);
    let changed = false;
    for (const { path: packagePath, packageJson: sourcePackageJson } of discoverPublicToolPackages(root)) {
        for (const file of nestedPackageJsonFiles(path.join(root, packagePath), sourcePackageJson)) {
            const packageJson = readPackageJson(file);
            let templateChanged = false;
            for (const field of ['dependencies', 'optionalDependencies']) {
                const dependencies = packageJson[field];
                if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
                for (const [packageName, version] of Object.entries(versions)) {
                    if (!Object.hasOwn(dependencies, packageName)) continue;
                    const range = `^${version}`;
                    if (dependencies[packageName] === range) continue;
                    dependencies[packageName] = range;
                    templateChanged = true;
                    changed = true;
                }
            }
            if (templateChanged) fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 4)}\n`);
        }
    }
    return changed;
}

function sourcePrerequisitePaths(root, packagePath, pathsByName) {
    const packageDirectory = path.join(root, packagePath);
    const packageJson = readPackageJson(path.join(packageDirectory, 'package.json'));
    const manifests = [packageJson, ...nestedPackageJsonFiles(packageDirectory, packageJson).map(readPackageJson)];
    const names = manifests.flatMap((manifest) => [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    return new Set(names.map((name) => pathsByName.get(name)).filter(Boolean));
}

function publicDependencies(packageJson, packageNames) {
    const dependencies = { ...packageJson.dependencies, ...packageJson.optionalDependencies };
    return Object.entries(dependencies)
        .filter(([name]) => packageNames.has(name))
        .map(([name, spec]) => ({ name, spec }));
}

function templateDependencyVersion(spec, packageName, expectedVersion) {
    if (expectedVersion !== undefined) {
        assertVersion(expectedVersion, `${packageName} packed version`);
        const expectedRange = `^${expectedVersion}`;
        if (spec !== expectedRange) {
            throw new Error(`${packageName} template dependency must be ${expectedRange}; received ${String(spec)}`);
        }
        return expectedVersion;
    }
    if (typeof spec !== 'string' || !spec.startsWith('^')) {
        throw new Error(`${packageName} template dependency must use an exact caret version; received ${String(spec)}`);
    }
    const version = spec.slice(1);
    assertVersion(version, `${packageName} template dependency`);
    return version;
}

function addPrerequisite(prerequisites, packageName, version, label) {
    assertVersion(version, label);
    const existingVersion = prerequisites.get(packageName);
    if (existingVersion !== undefined && existingVersion !== version) {
        throw new Error(`${packageName} has conflicting required versions: ${existingVersion} and ${version}`);
    }
    prerequisites.set(packageName, version);
}

function packageTargets(packageJson) {
    const targets = new Set();
    for (const field of ['main', 'module', 'types', 'typings', 'exports']) {
        collectTargets(packageJson[field], targets);
    }
    const binTargets = typeof packageJson.bin === 'string' ? [packageJson.bin] : Object.values(packageJson.bin ?? {});
    for (const target of binTargets) {
        if (typeof target === 'string') targets.add(target.startsWith('./') ? target : `./${target}`);
    }
    return [...targets].filter((target) => target.startsWith('./'));
}

function collectTargets(value, targets) {
    if (typeof value === 'string') {
        targets.add(value);
    } else if (Array.isArray(value)) {
        for (const item of value) collectTargets(item, targets);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectTargets(item, targets);
    }
}

function matchesPackageTarget(entry, target) {
    if (target.endsWith('/')) return entry.startsWith(target);
    if (!target.includes('*')) return entry === target;
    const expression = new RegExp(`^${escapeRegExp(target).replaceAll('\\*', '.*')}$`);
    return expression.test(entry);
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function nestedPackageJsonFiles(packageDirectory, packageJson) {
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (
                entry.name === 'node_modules' ||
                entry.name === '.git' ||
                entry.name === 'dist' ||
                entry.name === 'build'
            )
                continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.name === 'package.json') files.push(file);
        }
    };
    visit(packageDirectory);
    return files
        .filter((file) => file !== path.join(packageDirectory, 'package.json'))
        .filter((file) => isPackedFile(path.relative(packageDirectory, file), packageJson.files))
        .sort();
}

function isPackedFile(file, patterns) {
    if (!Array.isArray(patterns)) return true;
    let included = false;
    for (const rawPattern of patterns) {
        const excluded = rawPattern.startsWith('!');
        const pattern = (excluded ? rawPattern.slice(1) : rawPattern).replaceAll('\\', '/').replace(/^\.\//, '');
        if (matchesFilePattern(file, pattern)) included = !excluded;
    }
    return included;
}

function matchesFilePattern(file, pattern) {
    const normalizedFile = file.replaceAll('\\', '/');
    if (!pattern.includes('*')) return normalizedFile === pattern || normalizedFile.startsWith(`${pattern}/`);
    const expressionSource = pattern
        .split('**')
        .map((part) => escapeRegExp(part).replaceAll('*', '[^/]*'))
        .join('.*');
    const expression = new RegExp(`^${expressionSource}$`);
    return expression.test(normalizedFile);
}

function toWorkspacePath(root, directory) {
    return path.relative(root, directory).split(path.sep).join('/');
}

function readPackageJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertVersion(version, label) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
        throw new Error(`${label} must be a semantic version; received ${String(version)}`);
    }
}
