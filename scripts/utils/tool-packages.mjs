import * as fs from 'node:fs';
import * as path from 'node:path';

/** Public npm packages that make up the standalone Pumpkin plugin toolchain. */
export const PUBLIC_TOOL_PACKAGE_PATHS = Object.freeze({
    'tools/create-pumpkin-plugin': 'create-pumpkin-plugin',
    'tools/pumpkin-api': '@pumpkin-plugins/pumpkin-api',
    'tools/build': '@pumpkin-plugins/build',
    'tools/static-hermes-runtime': '@pumpkin-plugins/static-hermes-runtime',
});

const STARTER_TOOL_PACKAGE_PATHS = Object.freeze({
    '@pumpkin-plugins/pumpkin-api': 'tools/pumpkin-api',
    '@pumpkin-plugins/build': 'tools/build',
});
const BUILDER_TOOL_PACKAGE_NAMES = Object.freeze([
    '@pumpkin-plugins/pumpkin-api',
    '@pumpkin-plugins/static-hermes-runtime',
]);
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
    assertVersion(packageJson.version, `${expectedName} version`);
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
