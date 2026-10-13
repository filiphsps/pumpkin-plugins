import * as fs from 'node:fs';
import * as path from 'node:path';

/** Public npm packages that make up the standalone Pumpkin plugin toolchain. */
export const PUBLIC_TOOL_PACKAGE_PATHS = Object.freeze({
    'tools/create-pumpkin-plugin': 'create-pumpkin-plugin',
    'tools/pumpkin-api': '@pumpkin-plugins/pumpkin-api',
    'tools/build': '@pumpkin-plugins/build',
    'tools/static-hermes-runtime': '@pumpkin-plugins/static-hermes-runtime'
});

const STARTER_TOOL_PACKAGE_PATHS = Object.freeze({
    '@pumpkin-plugins/pumpkin-api': 'tools/pumpkin-api',
    '@pumpkin-plugins/build': 'tools/build'
});
const BUILDER_TOOL_PACKAGE_NAMES = Object.freeze([
    '@pumpkin-plugins/pumpkin-api',
    '@pumpkin-plugins/static-hermes-runtime'
]);
const PACKED_TOOL_CONTENTS = Object.freeze({
    'tools/create-pumpkin-plugin': [
        'package/bin/create-pumpkin-plugin.ts',
        'package/dist/create-pumpkin-plugin.js',
        'package/templates/typescript/package.json',
        'package/templates/javascript/package.json'
    ],
    'tools/pumpkin-api': [
        'package/src/index.ts',
        'package/src/wit.mjs',
        'package/src/wit.d.mts',
        'package/wit.lock.json',
        'package/schemas/upstream-git-pin.schema.json'
    ],
    'tools/static-hermes-runtime': [
        'package/src/index.ts',
        'package/dist/index.js',
        'package/cmake/wasi-sdk-hermes-p2.cmake',
        'package/hermes-patches/0001-wasi-p2-configure-platform.patch',
        'package/schemas/upstream-git-pin.schema.json',
        'package/schemas/wasi-sdk-release-pin.schema.json',
        'package/schemas/toolchain-versions.schema.json'
    ],
    'tools/build': ['package/dist/cli.js', 'package/runtime/quickjs-runtime-bigint.wasm', 'package/wasi-wit.lock.json']
});
/** Lockfile entries in public tool tarballs whose schema references must be package-local. */
export const PACKED_TOOL_SCHEMA_LOCK_FILES = Object.freeze({
    'tools/pumpkin-api': ['package/wit.lock.json'],
    'tools/static-hermes-runtime': [
        'package/hermes-source.lock.json',
        'package/wasi-sdk.lock.json',
        'package/toolchain-versions.json'
    ]
});

const TEMPLATE_LANGUAGES = ['typescript', 'javascript'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
 * Checks that lockfile schema references resolve to files inside a packed package.
 *
 * @param {string[]} entries - Tarball entries, including their `package/` prefix.
 * @param {Record<string, string>} lockFiles - Packed lockfile entry paths and their JSON contents.
 * @returns {void}
 * @throws {Error} When a lockfile has no local schema reference or its schema is not packed.
 */
export function assertPackedToolSchemaReferences(entries, lockFiles) {
    for (const [lockEntry, source] of Object.entries(lockFiles)) {
        if (!entries.includes(lockEntry)) throw new Error(`Packed package is missing lockfile ${lockEntry}`);

        let lock;
        try {
            lock = JSON.parse(source);
        } catch (error) {
            throw new Error(`Packed lockfile is invalid JSON: ${lockEntry}`, { cause: error });
        }

        const schemaReference = lock?.$schema;
        if (
            typeof schemaReference !== 'string' ||
            !schemaReference ||
            path.posix.isAbsolute(schemaReference) ||
            /^[a-z][a-z0-9+.-]*:/i.test(schemaReference) ||
            schemaReference.startsWith('//')
        ) {
            throw new Error(`Packed lockfile must use a package-local $schema reference: ${lockEntry}`);
        }

        const schemaEntry = path.posix.normalize(path.posix.join(path.posix.dirname(lockEntry), schemaReference));
        if (!schemaEntry.startsWith('package/')) {
            throw new Error(`Packed lockfile schema escapes its package: ${lockEntry} -> ${schemaReference}`);
        }
        if (!entries.includes(schemaEntry)) {
            throw new Error(`Packed lockfile references missing schema ${schemaEntry}: ${lockEntry}`);
        }
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
                    packageJson.dependencies?.[packageName]
                )}`
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
                    packageJson.dependencies?.[packageName]
                )}`
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
        })
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
