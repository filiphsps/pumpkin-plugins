/**
 * Builds title settings that show a public tool's npm scope while keeping its release component parseable.
 *
 * @param packageName - The public tool name from its package manifest.
 * @param component - The release component used for its tag.
 * @throws {Error} When a Pumpkin-scoped package name does not match its release component.
 */
export function publicToolReleaseTitleOptions(packageName, component) {
    const scopePrefix = '@pumpkin-plugins/';
    if (!packageName.startsWith(scopePrefix)) return {};

    const packageComponent = packageName.slice(scopePrefix.length);
    if (packageComponent !== component) {
        throw new Error(
            `${packageName} must end with ${component} so the scoped Release Please title retains its tag component`,
        );
    }

    return {
        'component-no-space': true,
        'pull-request-title-pattern': `chore\${scope}: release ${scopePrefix}\${component} \${version}`,
    };
}
