import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { matchesGlob, relative, resolve, sep } from 'node:path';
import { discoverComponents } from '@pumpkin-plugins/docs/node';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { ignoredCommitShas } from './ignored-commits.mjs';
import { sourcePrerequisitePaths } from './tool-packages.mjs';

const DEFAULT_WORKSPACE_ROOT = resolve(import.meta.dirname, '../..');

/** Reads workspace package manifests for identifying code bundled into each plugin. */
export function workspacePackages(root) {
    const packages = new Map();
    for (const group of /** @type {const} */ (['packages', 'tools', 'extensions'])) {
        for (const { slug, metadataFile } of discoverComponents(root, group)) {
            const path = `${group}/${slug}`;
            const manifest = JSON.parse(readFileSync(metadataFile, 'utf8'));
            packages.set(manifest.name, { path, manifest });
        }
    }
    return packages;
}

/** Finds workspace paths whose source is shipped with a release package. */
export function bundledPaths(packages, releasePath) {
    const paths = new Set();
    const isPublicTool = releasePath.startsWith('tools/');
    const visit = (pkg) => {
        if (!pkg || paths.has(pkg.path)) return;
        paths.add(pkg.path);
        if (!isPublicTool) {
            for (const name of Object.keys(pkg.manifest.dependencies ?? {})) visit(packages.get(name));
            for (const name of pkg.manifest.pumpkinBundleDependencies ?? []) visit(packages.get(name));
        }
        // Only a plugin's own build tool affects its WASM; npm tools release dependencies separately.
        if (
            pkg.path === releasePath &&
            releasePath.startsWith('packages/') &&
            pkg.manifest.devDependencies?.['@pumpkin-plugins/build']
        ) {
            visit(packages.get('@pumpkin-plugins/build'));
        }
    };
    visit([...packages.values()].find((pkg) => pkg.path === releasePath));
    if (!paths.has(releasePath)) throw new Error(`Unknown release package: ${releasePath}`);
    return paths;
}

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const SOURCE_IGNORED_DIRECTORIES = new Set([
    '__tests__',
    'build',
    'dist',
    'node_modules',
    'templates',
    'test',
    'testing',
]);
const TEST_FILE_PATTERN = /\.(?:spec|test|itest)\.[cm]?[jt]sx?$/;

function workspacePath(file, root) {
    const absolutePath = existsSync(file) ? realpathSync(file) : resolve(file);
    const relativePath = relative(realpathSync(root), absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) return undefined;
    return relativePath.split(sep).join('/');
}

function packageForWorkspacePath(path, packages) {
    return [...packages.values()]
        .filter((pkg) => path.startsWith(`${pkg.path}/`))
        .sort((left, right) => right.path.length - left.path.length)[0];
}

function sourceFilesIn(directory) {
    if (!existsSync(directory)) return [];
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            if (!SOURCE_IGNORED_DIRECTORIES.has(entry.name)) files.push(...sourceFilesIn(file));
            continue;
        }
        if (
            entry.isFile() &&
            SOURCE_EXTENSIONS.has(`.${entry.name.split('.').at(-1)}`) &&
            !TEST_FILE_PATTERN.test(entry.name)
        ) {
            files.push(file);
        }
    }
    return files;
}

function packageNameFromSpecifier(specifier) {
    if (
        specifier.startsWith('.') ||
        specifier.startsWith('#') ||
        specifier.startsWith('node:') ||
        specifier.startsWith('/')
    )
        return undefined;
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

function catalogEntryFor(importer, packageName) {
    for (const field of DEPENDENCY_FIELDS) {
        const specifier = importer.manifest[field]?.[packageName];
        if (typeof specifier !== 'string' || !specifier.startsWith('catalog:')) continue;
        const catalog = specifier.slice('catalog:'.length) || 'default';
        return `${catalog}:${packageName}`;
    }
    return undefined;
}

function sourceModuleSpecifiers(file, contents) {
    const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
    const specifiers = new Set();
    const add = (specifier) => {
        if (specifier && ts.isStringLiteralLike(specifier)) specifiers.add(specifier.text);
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
        if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
                (ts.isPropertyAccessExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    node.expression.expression.text === 'require' &&
                    node.expression.name.text === 'resolve'))
        ) {
            add(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return specifiers;
}

function sourceModuleOptions(root) {
    const config = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), ts.sys.readFile);
    if (config.error)
        throw new Error(
            `Cannot read tsconfig.base.json: ${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`,
        );
    return ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
}

function collectSourceImports(file, packages, root, compilerOptions, inputs, visited, followWorkspaceImports) {
    const relativeFile = workspacePath(file, root);
    const importer = relativeFile && packageForWorkspacePath(relativeFile, packages);
    if (!relativeFile || !importer || visited.has(relativeFile)) return;
    visited.add(relativeFile);
    inputs.paths.add(relativeFile);

    if (!SOURCE_EXTENSIONS.has(`.${relativeFile.split('.').at(-1)}`)) return;
    const contents = readFileSync(resolve(root, relativeFile), 'utf8');
    for (const specifier of sourceModuleSpecifiers(relativeFile, contents)) {
        const packageName = packageNameFromSpecifier(specifier);
        if (packageName) {
            const catalogEntry = catalogEntryFor(importer, packageName);
            if (catalogEntry) inputs.catalogs.add(catalogEntry);
        }
        if (specifier.startsWith('node:')) continue;
        if (!followWorkspaceImports) continue;

        const resolution = ts.resolveModuleName(
            specifier,
            resolve(root, relativeFile),
            compilerOptions,
            ts.sys,
        ).resolvedModule;
        if (!resolution) {
            if (packages.has(packageName)) {
                throw new Error(`Cannot resolve workspace import ${specifier} from ${relativeFile}`);
            }
            continue;
        }
        const dependencyPath = workspacePath(resolution.resolvedFileName, root);
        if (
            !dependencyPath ||
            dependencyPath.endsWith('/package.json') ||
            !packageForWorkspacePath(dependencyPath, packages)
        )
            continue;
        collectSourceImports(resolution.resolvedFileName, packages, root, compilerOptions, inputs, visited, true);
    }
}

function parseWorkspaceCatalogs(contents) {
    const workspace = parseYaml(contents) ?? {};
    const entries = new Map();
    for (const [packageName, version] of Object.entries(workspace.catalog ?? {})) {
        entries.set(`default:${packageName}`, version);
    }
    for (const [catalog, dependencies] of Object.entries(workspace.catalogs ?? {})) {
        for (const [packageName, version] of Object.entries(dependencies ?? {})) {
            entries.set(`${catalog}:${packageName}`, version);
        }
    }
    return entries;
}

function workspaceCatalogChanges(root, sha) {
    try {
        const parent = execFileSync('git', ['rev-parse', `${sha}^1`], { cwd: root, encoding: 'utf8' }).trim();
        const beforeText = execFileSync('git', ['show', `${parent}:pnpm-workspace.yaml`], {
            cwd: root,
            encoding: 'utf8',
        });
        const afterText = execFileSync('git', ['show', `${sha}:pnpm-workspace.yaml`], {
            cwd: root,
            encoding: 'utf8',
        });
        const before = parseWorkspaceCatalogs(beforeText);
        const after = parseWorkspaceCatalogs(afterText);
        return new Set(
            [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)),
        );
    } catch {
        // A missing parent or unavailable history must not silently hide a possible release input.
        return undefined;
    }
}

/** Finds source modules and shared inputs that can change a plugin's built artifact. */
export function pluginReleaseInputs(packages, releasePath, root = DEFAULT_WORKSPACE_ROOT) {
    const plugin = [...packages.values()].find((pkg) => pkg.path === releasePath);
    if (!plugin) throw new Error(`Unknown release package: ${releasePath}`);
    const entry = plugin.manifest.pumpkinPlugin?.entry;
    if (typeof entry !== 'string') throw new Error(`Plugin entry is missing from ${releasePath}/package.json`);

    const inputs = {
        paths: new Set([releasePath]),
        catalogs: new Set(),
        sharedFiles: new Set(['tsconfig.base.json']),
    };
    const compilerOptions = sourceModuleOptions(root);
    const visited = new Set();
    collectSourceImports(resolve(root, releasePath, entry), packages, root, compilerOptions, inputs, visited, true);

    const build = packages.get('@pumpkin-plugins/build');
    if (build && plugin.manifest.devDependencies?.[build.manifest.name]) {
        inputs.paths.add(`${build.path}/src`);
        inputs.paths.add(`${build.path}/runtime`);
        inputs.paths.add(`${build.path}/wasi-wit.lock.json`);
        for (const file of sourceFilesIn(resolve(root, build.path, 'src'))) {
            collectSourceImports(file, packages, root, compilerOptions, inputs, visited, true);
        }
    }
    for (const name of plugin.manifest.pumpkinBundleDependencies ?? []) {
        const dependency = packages.get(name);
        if (!dependency) throw new Error(`Unknown bundled dependency ${name} in ${releasePath}/package.json`);
        inputs.paths.add(dependency.path);
    }
    return inputs;
}

function packageReleaseInputs(packages, releasePath, root) {
    if (releasePath.startsWith('packages/')) return pluginReleaseInputs(packages, releasePath, root);

    if (releasePath.startsWith('tools/')) {
        const pkg = [...packages.values()].find((entry) => entry.path === releasePath);
        if (!pkg) throw new Error(`Unknown release package: ${releasePath}`);
        const inputs = {
            paths: new Set([releasePath]),
            catalogs: new Set(),
            sharedFiles: new Set(),
            packedFiles: packedFileMatcher(releasePath, pkg.manifest.files),
        };
        const compilerOptions = sourceModuleOptions(root);
        const visited = new Set();
        for (const file of sourceFilesIn(resolve(root, releasePath))) {
            collectSourceImports(file, packages, root, compilerOptions, inputs, visited, false);
        }
        return inputs;
    }

    const paths = bundledPaths(packages, releasePath);
    const pkg = [...packages.values()].find((entry) => entry.path === releasePath);
    const dependencyNames = new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkg.manifest[field] ?? {})));
    const catalogs = new Set([...dependencyNames].map((name) => catalogEntryFor(pkg, name)).filter(Boolean));
    return { paths, catalogs, sharedFiles: new Set(['tsconfig.base.json']) };
}

// npm packs these root files whatever the `files` list says.
const NPM_ALWAYS_PACKED_PATTERN = /^(?:readme|licen[cs]e)(?:\.[^/]*)?$/i;

/** Matches workspace files that npm packs for a tool, following its `files` globs and `!` exclusions. */
function packedFileMatcher(packagePath, patterns = []) {
    const included = patterns.filter((pattern) => !pattern.startsWith('!'));
    const excluded = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
    // A directory entry packs everything below it.
    const matches = (file, pattern) => matchesGlob(file, pattern) || matchesGlob(file, `${pattern}/**`);
    return (file) => {
        if (!file.startsWith(`${packagePath}/`)) return false;
        const packageFile = file.slice(packagePath.length + 1);
        if (NPM_ALWAYS_PACKED_PATTERN.test(packageFile)) return true;
        return (
            included.some((pattern) => matches(packageFile, pattern)) &&
            !excluded.some((pattern) => matches(packageFile, pattern))
        );
    };
}

function shippedFile(file, inputs, commit, catalogChangesByCommit) {
    const {
        paths,
        catalogs = new Set(),
        sharedFiles = new Set(),
        packedFiles,
    } = inputs instanceof Set ? { paths: inputs } : inputs;
    // Tool files npm packs ship as they are, including Markdown and test helpers exported to users.
    if (packedFiles?.(file)) return true;
    if (
        TEST_FILE_PATTERN.test(file) ||
        /\.md$|(?:^|\/)(?:test|testing|__tests__)\/|^(?:packages|tools|extensions)\/[^/]+\/(?:build|dist|node_modules)\//.test(
            file,
        )
    )
        return false;
    if (sharedFiles.has(file)) return true;
    if (file === 'pnpm-workspace.yaml') {
        const changedCatalogs = catalogChangesByCommit?.get(commit.sha);
        if (changedCatalogs === undefined) return true;
        return [...changedCatalogs].some((entry) => catalogs.has(entry));
    }
    return [...paths].some((path) => file === path || file.startsWith(`${path}/`));
}

function hasReleaseAs(commit) {
    return /(?:^|\n)Release-As:\s*\S+/.test(commit.message ?? '');
}

function releaseAsTargetsComponent(commit, component) {
    if (!hasReleaseAs(commit)) return true;
    const scope = /^[\w-]+(?:\(([^)]+)\))?!?:/.exec(commit.message ?? '')?.[1];
    return scope === component;
}

/** Selects relevant commits in newest-first order, stopping at this plugin's own previous release. */
export function releaseCommits(commits, inputs, lastReleaseSha, component, catalogChangesByCommit) {
    const boundary = lastReleaseSha ? commits.findIndex((commit) => commit.sha === lastReleaseSha) : commits.length;
    if (boundary === -1) throw new Error(`Release commit ${lastReleaseSha} is missing from the fetched history`);
    const seen = new Set();
    return commits.slice(0, boundary).filter((commit) => {
        if (ignoredCommitShas.has(commit.sha)) return false;
        if (!Array.isArray(commit.files)) throw new Error(`Commit ${commit.sha} has no changed-file list`);
        if (seen.has(commit.sha)) return false;
        seen.add(commit.sha);
        if (commit.files.length === 0) return hasReleaseAs(commit) && releaseAsTargetsComponent(commit, component);
        return (
            releaseAsTargetsComponent(commit, component) &&
            commit.files.some((file) => shippedFile(file, inputs, commit, catalogChangesByCommit))
        );
    });
}

function historyThrough(commits, sha) {
    const index = commits.findIndex((commit) => commit.sha === sha);
    if (index === -1) throw new Error(`Package introduction commit ${sha} is missing from the fetched history`);
    return commits.slice(0, index + 1);
}

function commitShasSinceRelease(commits, lastReleaseSha) {
    const boundary = commits.findIndex((commit) => commit.sha === lastReleaseSha);
    if (boundary === -1) throw new Error(`Release commit ${lastReleaseSha} is missing from the fetched history`);
    return new Set(
        commits
            .slice(0, boundary)
            .filter((commit) => !ignoredCommitShas.has(commit.sha))
            .map((commit) => commit.sha),
    );
}

async function previousPublishedRelease(github, currentTag) {
    if (
        !currentTag ||
        typeof currentTag.constructor.parse !== 'function' ||
        typeof github.releaseIterator !== 'function'
    )
        return undefined;
    let previousRelease;
    for await (const release of github.releaseIterator()) {
        let tag;
        try {
            tag = currentTag.constructor.parse(release.tagName);
        } catch {
            continue;
        }
        if (!tag || tag.component !== currentTag.component || tag.version.compare(currentTag.version) >= 0) continue;
        if (!previousRelease || tag.version.compare(previousRelease.tag.version) > 0) {
            previousRelease = { ...release, tag };
        }
    }
    return previousRelease;
}

async function firstPackageCommitSha(github, branch, path) {
    const api = github.getGitHubApi?.();
    const listCommits = api?.octokit?.rest?.repos?.listCommits;
    if (!api?.repository?.owner || !api.repository.repo || !listCommits || !api.octokit.paginate) {
        throw new Error(`Cannot find the package introduction commit for ${path}`);
    }
    const commits = await api.octokit.paginate(listCommits, {
        owner: api.repository.owner,
        repo: api.repository.repo,
        sha: branch,
        path: `${path}/package.json`,
        per_page: 100,
    });
    const firstCommit = commits.at(-1);
    if (!firstCommit?.sha) throw new Error(`Cannot find the package introduction commit for ${path}`);
    return firstCommit.sha;
}

/** Adds bundled dependency commits and defers tools until their public dependencies have released.
 *
 * @param {number} [maxCommits=500] - Maximum release-history commits to inspect.
 * @param {(message: string) => void} [log=console.error] - Receives deferred-candidate messages.
 * @param {string} [root=DEFAULT_WORKSPACE_ROOT] - Workspace root for reading package and template dependencies.
 */
export function bundledChangesPlugin(
    github,
    branch,
    packages,
    releasedVersions,
    maxCommits = 500,
    log = console.error,
    root = DEFAULT_WORKSPACE_ROOT,
) {
    const publicToolDependencies = new Map();
    for (const pkg of packages.values()) {
        if (
            pkg.path.startsWith('tools/') &&
            pkg.manifest.private !== true &&
            pkg.manifest.publishConfig?.access === 'public'
        ) {
            publicToolDependencies.set(pkg.path, new Set());
        }
    }
    const pathsByName = new Map([...packages].map(([name, pkg]) => [name, pkg.path]));
    for (const pkg of packages.values()) {
        if (!publicToolDependencies.has(pkg.path)) continue;
        const prerequisites = sourcePrerequisitePaths(root, pkg.path, pathsByName);
        for (const dependencyPath of prerequisites) {
            if (publicToolDependencies.has(dependencyPath)) publicToolDependencies.get(pkg.path).add(dependencyPath);
        }
    }

    function unreleasedDependencies(packagePath) {
        const unreleased = [];
        const visited = new Set();
        const visit = (currentPath) => {
            for (const dependencyPath of publicToolDependencies.get(currentPath) ?? []) {
                if (visited.has(dependencyPath)) continue;
                visited.add(dependencyPath);
                const version = releasedVersions[dependencyPath]?.toString();
                if (!version || version === '0.0.0') unreleased.push(dependencyPath);
                else visit(dependencyPath);
            }
        };
        visit(packagePath);
        return unreleased;
    }

    return {
        async preconfigure(strategies, commitsByPath, releasesByPath) {
            const publicToolPaths = new Set(publicToolDependencies.keys());
            const actionPaths = Object.keys(strategies).filter((path) => path.startsWith('actions/'));
            for (const path of actionPaths) {
                const component = path.split('/').at(-1);
                commitsByPath[path] = (commitsByPath[path] ?? []).filter(
                    (commit) => !ignoredCommitShas.has(commit.sha) && releaseAsTargetsComponent(commit, component),
                );
            }
            const pluginPaths = Object.keys(strategies).filter((path) => path.startsWith('packages/'));
            const toolPaths = Object.keys(strategies).filter((path) => publicToolPaths.has(path));
            const extensionPaths = Object.keys(strategies).filter((path) => path.startsWith('extensions/'));
            const packagePaths = [...pluginPaths, ...toolPaths, ...extensionPaths];
            const releasePaths = [...packagePaths, ...actionPaths];
            if (releasePaths.length === 0) return strategies;
            const commits = [];
            const boundaries = new Set();
            // A package without a previous release keeps its introduction commit in its first notes.
            const introductionShas = {};
            for (const path of releasePaths) {
                const release = releasesByPath[path];
                if (release?.sha) boundaries.add(release.sha);
                else if (releasedVersions[path]?.toString() === '0.0.0') {
                    if (packagePaths.includes(path)) {
                        introductionShas[path] = await firstPackageCommitSha(github, branch, path);
                        boundaries.add(introductionShas[path]);
                    }
                } else {
                    const previousRelease = await previousPublishedRelease(github, release?.tag);
                    if (previousRelease?.sha) {
                        releasesByPath[path] = previousRelease;
                        boundaries.add(previousRelease.sha);
                    } else if (packagePaths.includes(path)) {
                        const introductionSha = await firstPackageCommitSha(github, branch, path);
                        releasesByPath[path] = { ...release, sha: introductionSha };
                        introductionShas[path] = introductionSha;
                        boundaries.add(introductionSha);
                    } else {
                        throw new Error(
                            `Cannot find a published release before ${release?.tag ?? releasedVersions[path]} for ${path}`,
                        );
                    }
                }
            }
            // Fetch unfiltered history for plugin dependency commits and action release boundaries.
            for await (const commit of github.mergeCommitIterator(branch, {
                backfillFiles: true,
                maxResults: maxCommits + 1,
            })) {
                if (commits.length === maxCommits)
                    throw new Error(`Release history exceeds ${maxCommits} commits; increase commit-search-depth`);
                commits.push(commit);
                boundaries.delete(commit.sha);
                if (boundaries.size === 0) break;
            }
            const catalogChangesByCommit = new Map();
            for (const commit of commits) {
                if (commit.files?.includes('pnpm-workspace.yaml')) {
                    catalogChangesByCommit.set(commit.sha, workspaceCatalogChanges(root, commit.sha));
                }
            }
            for (const path of packagePaths) {
                const introductionSha = introductionShas[path];
                commitsByPath[path] = releaseCommits(
                    introductionSha ? historyThrough(commits, introductionSha) : commits,
                    packageReleaseInputs(packages, path, root),
                    introductionSha ? undefined : releasesByPath[path]?.sha,
                    path.split('/').at(-1),
                    catalogChangesByCommit,
                );
            }
            for (const path of actionPaths) {
                const lastReleaseSha = releasesByPath[path]?.sha;
                if (!lastReleaseSha) continue;
                const includedShas = commitShasSinceRelease(commits, lastReleaseSha);
                commitsByPath[path] = (commitsByPath[path] ?? []).filter((commit) => includedShas.has(commit.sha));
            }
            return strategies;
        },
        processCommits: (commits) => commits,
        run: async (candidates) =>
            candidates.filter((candidate) => {
                if (!publicToolDependencies.has(candidate.path)) return true;
                const unreleased = unreleasedDependencies(candidate.path);
                if (unreleased.length === 0) return true;
                log(
                    `Deferring ${candidate.path} release PR until public dependencies release: ${unreleased.join(', ')}`,
                );
                return false;
            }),
    };
}
