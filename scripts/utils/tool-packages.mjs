import * as fs from 'node:fs';
import * as path from 'node:path';

/** Public npm packages that make up the standalone Pumpkin plugin toolchain. */
export const PUBLIC_TOOL_PACKAGE_PATHS = Object.freeze({
    'tools/create-pumpkin-plugin': 'create-pumpkin-plugin',
    'tools/codemod': '@pumpkin-plugins/codemod',
    'tools/pumpkin-api': '@pumpkin-plugins/pumpkin-api',
    'tools/build': '@pumpkin-plugins/build',
    'tools/static-hermes-runtime': '@pumpkin-plugins/static-hermes-runtime',
    'tools/cspell-dict-minecraft': '@pumpkin-plugins/cspell-dict-minecraft',
    'tools/docs': '@pumpkin-plugins/docs',
    'tools/plugin-kit': '@pumpkin-plugins/plugin-kit',
    'tools/config': '@pumpkin-plugins/config',
    'tools/update-check': '@pumpkin-plugins/update-check',
    'tools/minecraft-colors': '@pumpkin-plugins/minecraft-colors',
    'tools/apis/pumpkin-pie-api': '@pumpkin-plugins/pumpkin-pie-api',
});

/** Public npm package release order, with internal prerequisites preceding their consumers. */
export const PUBLIC_TOOL_RELEASE_ORDER = Object.freeze([
    'tools/pumpkin-api',
    'tools/static-hermes-runtime',
    'tools/docs',
    'tools/update-check',
    'tools/plugin-kit',
    'tools/config',
    'tools/minecraft-colors',
    'tools/apis/pumpkin-pie-api',
    'tools/build',
    'tools/create-pumpkin-plugin',
    'tools/codemod',
    'tools/cspell-dict-minecraft',
]);

const STARTER_TOOL_PACKAGE_PATHS = Object.freeze({
    '@pumpkin-plugins/pumpkin-api': 'tools/pumpkin-api',
    '@pumpkin-plugins/build': 'tools/build',
});
const BUILDER_TOOL_PACKAGE_NAMES = Object.freeze([
    '@pumpkin-plugins/pumpkin-api',
    '@pumpkin-plugins/static-hermes-runtime',
]);
const TOOL_PREREQUISITE_NAMES = Object.freeze({
    'tools/config': ['@pumpkin-plugins/docs'],
    'tools/update-check': ['@pumpkin-plugins/docs', '@pumpkin-plugins/pumpkin-api'],
    'tools/plugin-kit': ['@pumpkin-plugins/docs', '@pumpkin-plugins/pumpkin-api', '@pumpkin-plugins/update-check'],
});
const PACKED_TOOL_CONTENTS = Object.freeze({
    'tools/create-pumpkin-plugin': [
        'package/bin/create-pumpkin-plugin.ts',
        'package/dist/create-pumpkin-plugin.js',
        'package/templates/typescript/package.json',
        'package/templates/javascript/package.json',
    ],
    'tools/pumpkin-api': [
        'package/src/index.ts',
        'package/src/wit.mjs',
        'package/src/wit.d.mts',
        'package/wit.lock.json',
    ],
    'tools/static-hermes-runtime': [
        'package/src/index.ts',
        'package/dist/index.js',
        'package/cmake/wasi-sdk-hermes-p2.cmake',
        'package/hermes-patches/0001-wasi-p2-configure-platform.patch',
    ],
    'tools/build': ['package/dist/cli.js', 'package/runtime/quickjs-runtime-bigint.wasm', 'package/wasi-wit.lock.json'],
    'tools/codemod': [
        'package/dist/bin/pumpkin-codemod.js',
        'package/dist/src/index.js',
        'package/dist/src/index.d.ts',
        'package/README.md',
        'package/docs/using-codemods.md',
        'package/docs/authoring-codemods.md',
    ],
    'tools/cspell-dict-minecraft': [
        'package/cspell-ext.json',
        'package/minecraft.txt',
        'package/README.md',
        'package/LICENSE',
    ],
    'tools/docs': [
        'package/src/info.ts',
        'package/src/markdown.ts',
        'package/src/node.ts',
        'package/bin/pumpkin-plugins-docs.mjs',
    ],
    'tools/plugin-kit': [
        'package/src/commands.ts',
        'package/src/host.ts',
        'package/src/plugin.ts',
        'package/src/register-commands.ts',
    ],
    'tools/config': ['package/src/index.ts'],
    'tools/update-check': ['package/src/index.ts'],
    'tools/minecraft-colors': ['package/src/index.ts'],
    'tools/apis/pumpkin-pie-api': ['package/src/index.ts'],
});
const TEMPLATE_LANGUAGES = ['typescript', 'javascript'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parses a `tar -t` listing from any supported host platform.
 *
 * @param {string} listing - Newline-delimited tar entries.
 * @returns {string[]} Non-empty entry paths without platform line endings.
 */
export function parseTarEntries(listing) {
    return listing.split(/\r?\n/).filter(Boolean);
}

/**
 * Checks that a public tool's packed package metadata permits public npm publication.
 *
 * @param {Record<string, unknown>} packageJson - The packed package metadata to validate.
 * @param {string} expectedName - The canonical npm package name for this tool.
 * @returns {void}
 * @throws {Error} When the package is private, misnamed, or not configured for public access.
 */
export function assertPublicToolPackage(packageJson, expectedName) {
    if (packageJson.name !== expectedName) {
        throw new Error(`Public tool package name must be ${expectedName}; received ${String(packageJson.name)}`);
    }
    if (packageJson.private === true) throw new Error(`${expectedName} must not be private`);
    if (packageJson.publishConfig?.access !== 'public') {
        throw new Error(`${expectedName} publishConfig.access must be public`);
    }
    if (packageJson.engines?.node !== '>=24.21.0') {
        throw new Error(`${expectedName} engines.node must be >=24.21.0`);
    }
    assertPackedDependencySpecs(packageJson);
    assertVersion(packageJson.version, `${expectedName} version`);
}

/**
 * Rejects dependency fields that still contain pnpm-only workspace or catalog references.
 *
 * @param {Record<string, unknown>} packageJson - The packed package metadata to inspect.
 * @returns {void}
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
 * Orders a selected set of public tool paths and rejects invalid release selections.
 *
 * @param {string[]} selectedPaths - Public tool workspace paths selected by the release workflow.
 * @returns {string[]} Selected paths in canonical publication order.
 * @throws {Error} When a path is unknown or appears more than once.
 */
export function orderPublicToolReleasePaths(selectedPaths) {
    const selected = new Set();
    for (const packagePath of selectedPaths) {
        if (!Object.hasOwn(PUBLIC_TOOL_PACKAGE_PATHS, packagePath)) {
            throw new Error(`unknown public tool release path: ${String(packagePath)}`);
        }
        if (selected.has(packagePath)) throw new Error(`duplicate public tool release path: ${packagePath}`);
        selected.add(packagePath);
    }
    return PUBLIC_TOOL_RELEASE_ORDER.filter((packagePath) => selected.has(packagePath));
}

/**
 * Resolves the public package versions that must exist before a tool can be published.
 *
 * @param {string} packagePath - Repository path identifying the public tool package.
 * @param {Record<string, unknown>} packageJson - The packed package metadata.
 * @param {Record<string, string>} [packageVersions] - Exact public dependency versions represented by packed tools.
 * @param {Record<string, unknown>[]} [starterTemplatePackageJsons] - Both packed creator template manifests.
 * @returns {{ packageName: string; version: string }[]} Internal public production prerequisites.
 * @throws {Error} When a required dependency or creator template does not resolve to an exact public version.
 */
export function getPublicToolReleasePrerequisites(
    packagePath,
    packageJson,
    packageVersions = {},
    starterTemplatePackageJsons = [],
) {
    if (!Object.hasOwn(PUBLIC_TOOL_PACKAGE_PATHS, packagePath)) {
        throw new Error(`unknown public tool release path: ${String(packagePath)}`);
    }

    if (packagePath === 'tools/build') {
        return BUILDER_TOOL_PACKAGE_NAMES.map((packageName) => {
            const version = packageJson.dependencies?.[packageName];
            assertVersion(version, `${packageName} packed builder dependency`);
            return { packageName, version };
        });
    }

    if (packagePath === 'tools/create-pumpkin-plugin') {
        if (starterTemplatePackageJsons.length !== TEMPLATE_LANGUAGES.length) {
            throw new Error('both packed creator template manifests are required to resolve publication prerequisites');
        }
        for (const templatePackageJson of starterTemplatePackageJsons) {
            assertStarterToolDependencies(templatePackageJson, packageVersions);
        }
        return Object.entries(STARTER_TOOL_PACKAGE_PATHS).map(([packageName]) => ({
            packageName,
            version: packageVersions[packageName],
        }));
    }

    const prerequisiteNames = TOOL_PREREQUISITE_NAMES[packagePath];
    if (prerequisiteNames) {
        return prerequisiteNames.map((packageName) => {
            const version = packageJson.dependencies?.[packageName];
            assertVersion(version, `${packageName} packed ${path.basename(packagePath)} dependency`);
            return { packageName, version };
        });
    }

    return [];
}

/**
 * Checks a packed public tool's required files and excludes development test sources.
 *
 * @param {string[]} entries - Tarball entries, including their `package/` prefix.
 * @param {string} packagePath - Repository path identifying the public tool package.
 * @returns {void}
 * @throws {Error} When runtime files are missing or development sources are packed.
 */
export function assertPublicToolPackageContents(entries, packagePath) {
    const requiredEntries = PACKED_TOOL_CONTENTS[packagePath];
    if (!requiredEntries) return;

    for (const requiredEntry of requiredEntries) {
        if (!entries.includes(requiredEntry)) {
            throw new Error(`${packagePath} packed package is missing ${requiredEntry}`);
        }
    }

    const testSource = entries.find((entry) => /^package\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry));
    if (testSource) throw new Error(`${packagePath} packed package contains a development test source: ${testSource}`);

    if (packagePath === 'tools/build') {
        const sourceFile = entries.find((entry) => entry.startsWith('package/src/'));
        if (sourceFile) throw new Error(`CLI-only package contains source: ${sourceFile}`);
    }
}

/**
 * Checks that the packed builder resolves its public API and runtime dependencies to the packed versions.
 *
 * @param {{ dependencies?: Record<string, string> }} packageJson - The packed builder package metadata.
 * @param {Record<string, string>} versions - Package names and versions represented by packed tarballs.
 * @returns {void}
 * @throws {Error} When a builder dependency does not exactly resolve to its packed package version.
 */
export function assertPackedBuilderDependencies(packageJson, versions) {
    for (const packageName of BUILDER_TOOL_PACKAGE_NAMES) {
        const version = versions[packageName];
        assertVersion(version, `${packageName} packed version`);
        if (packageJson.dependencies?.[packageName] !== version) {
            throw new Error(
                `${packageName} builder dependency must resolve to packed version ${version}; received ${String(
                    packageJson.dependencies?.[packageName],
                )}`,
            );
        }
    }
}

/**
 * Checks that a starter template requests the public API and builder release versions being packed.
 *
 * @param {{ dependencies?: Record<string, string> }} packageJson - The starter template manifest.
 * @param {Record<string, string>} versions - Package names and versions represented by packed tarballs.
 * @returns {void}
 * @throws {Error} When a required starter dependency uses an outdated range.
 */
export function assertStarterToolDependencies(packageJson, versions) {
    for (const packageName of Object.keys(STARTER_TOOL_PACKAGE_PATHS)) {
        const version = versions[packageName];
        assertVersion(version, `${packageName} packed version`);
        const expectedRange = `^${version}`;
        if (packageJson.dependencies?.[packageName] !== expectedRange) {
            throw new Error(
                `${packageName} starter dependency must be ${expectedRange}; received ${String(
                    packageJson.dependencies?.[packageName],
                )}`,
            );
        }
    }
}

/**
 * Updates both starter templates to match the public API and builder package versions in this checkout.
 *
 * @param {string} root - The repository root containing the public tool packages and templates.
 * @returns {boolean} Whether either template manifest changed.
 */
export function syncStarterToolDependencies(root) {
    const versions = Object.fromEntries(
        Object.entries(STARTER_TOOL_PACKAGE_PATHS).map(([packageName, packagePath]) => {
            const packageJson = readPackageJson(path.join(root, packagePath, 'package.json'));
            if (packageJson.name !== packageName) {
                throw new Error(`${packagePath}/package.json must be named ${packageName}`);
            }
            assertVersion(packageJson.version, `${packageName} version`);
            return [packageName, packageJson.version];
        }),
    );

    let changed = false;
    for (const language of TEMPLATE_LANGUAGES) {
        const file = path.join(root, 'tools/create-pumpkin-plugin/templates', language, 'package.json');
        const packageJson = readPackageJson(file);
        packageJson.dependencies ??= {};
        let templateChanged = false;
        for (const [packageName, version] of Object.entries(versions)) {
            const range = `^${version}`;
            if (packageJson.dependencies[packageName] === range) continue;
            packageJson.dependencies[packageName] = range;
            templateChanged = true;
            changed = true;
        }
        if (templateChanged) fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 4)}\n`);
    }
    return changed;
}

function readPackageJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertVersion(version, label) {
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
        throw new Error(`${label} must be a semantic version; received ${String(version)}`);
    }
}
