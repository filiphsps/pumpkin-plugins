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
    assertVersion(packageJson.version, `${expectedName} version`);
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
