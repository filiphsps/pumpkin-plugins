// GitHub-only native packaging. Source, compatibility data and the load test always come from the tag.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { discoverComponents, readNativeManifest } from '@pumpkin-plugins/docs/node';
import { Command } from 'commander';
import { hasIndependentNativeTagSettings } from './utils/native-release-config.mjs';
import { nativeAssetNames, nativeTargets } from './utils/native-targets.mjs';

const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const requiredLoadTestEngines = ['quickjs', 'static-hermes'];
const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
const nativeReadmeMatrixHeading = '## Supported target and host matrix';
const nativeReadmeMatrixStart = '<!-- docs:begin native-target-matrix -->';
const nativeReadmeMatrixEnd = '<!-- docs:end native-target-matrix -->';
const nativeReadmeMatrixNote =
    '<!-- Generated from scripts/utils/native-targets.mjs and native/pumpkin-plus-plus/release.json. Run `node scripts/native-release.mjs update-readme-matrix`. -->';
const nativeNotesStart = '<!-- pumpkin-native-release-metadata:start -->';
const nativeNotesEnd = '<!-- pumpkin-native-release-metadata:end -->';
const program = new Command()
    .name('native-release')
    .description('Build, load-test and optionally attach exact-tag native release assets.');
program
    .command('ci-releases')
    .requiredOption('--sha <sha>', 'CI source commit')
    .action(({ sha }) => {
        const root = process.env.PUMPKIN_PLUGINS_ROOT ?? resolve(import.meta.dirname, '..');
        console.log(
            JSON.stringify(
                discoverComponents(root, 'native').map(({ slug, metadataFile }) => ({
                    path: `native/${slug}`,
                    tagName: `${slug}-v${readNativeManifest(metadataFile).version}`,
                    sha,
                })),
            ),
        );
    });
program.command('matrix').action(() => console.log(JSON.stringify({ include: nativeTargets })));
program
    .command('update-readme-matrix')
    .description('Generate the native README target matrix from the target definitions and release.json.')
    .option(
        '--source-root <path>',
        'Repository root containing native/pumpkin-plus-plus/release.json and README.md',
        process.env.PUMPKIN_PLUGINS_ROOT ?? resolve(import.meta.dirname, '..'),
    )
    .action(({ sourceRoot }) => updateNativeReadmeMatrix(sourceRoot));
program
    .command('resolve')
    .requiredOption('--tag <tag>', 'Native release tag')
    .requiredOption('--sha <sha>', 'Exact release source commit')
    .requiredOption('--source-root <path>', 'Checkout of the release tag')
    .option('--check', 'Validate current CI source without requiring or publishing a release tag')
    .action((options) => {
        const release = resolveSource(options);
        if (process.env.GITHUB_OUTPUT)
            appendFileSync(process.env.GITHUB_OUTPUT, `rust_toolchain=${release.spec.rustToolchain}\n`);
        console.log(JSON.stringify(release));
    });
program
    .command('build')
    .requiredOption('--tag <tag>', 'Native release tag')
    .requiredOption('--sha <sha>', 'Exact release source commit')
    .requiredOption('--target <triple>', 'Target triple; runner must load this architecture')
    .requiredOption('--source-root <path>', 'Checkout of the release tag')
    .requiredOption('--host <path>', 'Pre-verified Pumpkin host binary for this target')
    .option('--check', 'Validate current CI source without requiring or publishing a release tag')
    .requiredOption('--output <path>', 'Artifact output directory')
    .action(build);
program
    .command('attach')
    .requiredOption('--tag <tag>', 'Native release tag')
    .requiredOption('--sha <sha>', 'Exact release source commit')
    .requiredOption('--target <triple>', 'Target triple')
    .requiredOption('--source-root <path>', 'Checkout of the release tag')
    .requiredOption('--output <path>', 'Downloaded verified artifact directory')
    .requiredOption('--repository <owner/repo>', 'GitHub repository receiving the assets')
    .action((options) => attachNative(resolveSource(options), options));
program.parse();

function json(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}
function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function command(executable, args, cwd, env = {}) {
    const commandEnv = Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(([name]) => name !== 'GH_TOKEN' && name !== 'GITHUB_TOKEN'),
    );
    if (executable === 'gh' && githubToken) commandEnv.GH_TOKEN = githubToken;
    return execFileSync(executable, args, {
        cwd,
        env: commandEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
    }).trim();
}
function git(root, ...args) {
    return command('git', args, root);
}
function api(repository, endpoint) {
    return JSON.parse(command('gh', ['api', `repos/${repository}/${endpoint}`]));
}
function tagSha(repository, tag) {
    let object = api(repository, `git/ref/tags/${encodeURIComponent(tag)}`).object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1)
        object = api(repository, `git/tags/${object.sha}`).object;
    if (object?.type !== 'commit' || !shaPattern.test(object.sha))
        throw new Error(`Tag ${tag} must resolve to a commit`);
    return object.sha;
}
function requireSha(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, found ${actual}`);
}
function validateLoadTestEvidence(proof, expected) {
    const engineProofs = proof?.engines;
    const enginesPassed =
        Array.isArray(engineProofs) &&
        engineProofs.length === requiredLoadTestEngines.length &&
        new Set(engineProofs.map((engineProof) => engineProof?.engine)).size === requiredLoadTestEngines.length &&
        requiredLoadTestEngines.every((engine) =>
            engineProofs.some((engineProof) => engineProof?.engine === engine && engineProof.status === 'passed'),
        );
    if (
        proof?.status !== 'passed' ||
        !enginesPassed ||
        proof.target !== expected.target ||
        proof.protocolVersion !== expected.protocolVersion ||
        proof.artifactSha256 !== expected.artifactSha256 ||
        proof.hostBinarySha256 !== expected.hostBinarySha256
    )
        throw new Error('Native load-test evidence does not match both engines, library, host, target and protocol');
}
function renderNativeReadmeMatrix(spec) {
    const { host } = spec;
    if (
        typeof host?.repository !== 'string' ||
        typeof host.tag !== 'string' ||
        !shaPattern.test(host.sha) ||
        !/^[0-9.]+$/.test(spec.rustToolchain) ||
        !Number.isSafeInteger(spec.protocolVersion)
    )
        throw new Error('Native README matrix requires exact host, toolchain and protocol metadata');
    const rows = nativeTargets
        .map(({ target, runner }) => {
            const asset = host.assets?.[target];
            if (!asset || typeof asset.name !== 'string' || !/^[\w.+-]+$/.test(asset.name))
                throw new Error(`Missing exact host release asset for native target ${target}`);
            const [library] = nativeAssetNames('pumpkin-plus-plus', target);
            return `| \`${target}\` | \`${library}\` | \`${asset.name}\` | \`${runner}\` |`;
        })
        .join('\n');
    const hostReleaseUrl = `https://github.com/${host.repository}/releases/tag/${encodeURIComponent(host.tag)}`;
    return [
        "Use the library built for your server's target and the matching Pumpkin host release asset.",
        'The release workflow builds and load-tests every pair on its matching runner with QuickJS and Static Hermes before attaching the native library.',
        `This compatibility set is pinned to Pumpkin [\`${host.tag}\`](${hostReleaseUrl}),`,
        `source commit \`${host.sha}\`, Rust \`${spec.rustToolchain}\`, and protocol version \`${spec.protocolVersion}\`.`,
        '',
        '| Target triple | Native library asset | Matching Pumpkin host asset | Validation runner |',
        '| --- | --- | --- | --- |',
        rows,
        '',
        'Target triples and runners come from [the native target definitions](../../scripts/utils/native-targets.mjs);',
        'host asset names and checksums come from [release.json](release.json).',
    ].join('\n');
}
function updateNativeReadmeMatrix(sourceRoot) {
    const root = resolve(sourceRoot);
    const readmeFile = join(root, 'native/pumpkin-plus-plus/README.md');
    const readme = readFileSync(readmeFile, 'utf8');
    const headingStart = readme.indexOf(nativeReadmeMatrixHeading);
    if (
        headingStart === -1 ||
        readme.indexOf(nativeReadmeMatrixHeading, headingStart + nativeReadmeMatrixHeading.length) !== -1
    )
        throw new Error(`Native README must contain exactly one target matrix heading: ${readmeFile}`);
    const sectionEnd = readme.indexOf('\n## ', headingStart + nativeReadmeMatrixHeading.length);
    if (sectionEnd === -1)
        throw new Error(`Native README target matrix section has no following heading: ${readmeFile}`);
    const block = renderNativeReadmeMatrix(json(join(root, 'native/pumpkin-plus-plus/release.json')));
    const generated = [
        nativeReadmeMatrixHeading,
        '',
        nativeReadmeMatrixStart,
        nativeReadmeMatrixNote,
        '',
        block,
        nativeReadmeMatrixEnd,
        '',
        'Refresh this generated table after changing the target definitions or `release.json` by running',
        '`node scripts/native-release.mjs update-readme-matrix` from the repository root. A different Pumpkin',
        'build needs its own artifact-load and behavior evidence; a matching compiler or protocol integer',
        "does not establish native ABI compatibility. Each release's JSON sidecar records the exact host binary,",
        'target, toolchain, protocol version and artifact checksum used by its load test.',
        '',
        '',
    ].join('\n');
    const updated = `${readme.slice(0, headingStart)}${generated}${readme.slice(sectionEnd + 1)}`;
    if (updated !== readme) writeFileSync(readmeFile, updated);
}
function within(root, file) {
    const canonical = realpathSync(file);
    const fromRoot = relative(realpathSync(root), canonical);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
        throw new Error(`Native source escapes checkout: ${file}`);
    return canonical;
}
function resolveSource({ sourceRoot, tag, sha, check = false }) {
    const root = resolve(sourceRoot);
    if (!shaPattern.test(sha)) throw new Error('Native release requires a full source SHA');
    requireSha(git(root, 'rev-parse', 'HEAD^{commit}'), sha, 'Checked-out native source SHA');
    if (!check) requireSha(git(root, 'rev-parse', `refs/tags/${tag}^{commit}`), sha, 'Native release tag SHA');
    if (git(root, 'status', '--porcelain', '--untracked-files=all'))
        throw new Error('Native release source has tracked or untracked modifications');
    const config = json(join(root, 'release-please-config.json'));
    const matches = Object.entries(config.packages ?? {}).filter(
        ([path, entry]) => /^native\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path) && tag.startsWith(`${entry.component}-v`),
    );
    if (matches.length !== 1) throw new Error(`No unique native component matches ${tag}`);
    const [[path, entry]] = matches;
    const component = path.split('/').at(-1);
    if (
        !hasIndependentNativeTagSettings(config, entry) ||
        entry.component !== component ||
        entry['release-type'] !== 'rust'
    )
        throw new Error(`Invalid independent native release configuration for ${path}`);
    const directory = within(root, join(root, path));
    const manifestFile = within(root, join(directory, 'Cargo.toml'));
    const cargo = readNativeManifest(manifestFile);
    if (cargo.name !== component || tag !== `${component}-v${cargo.version}`)
        throw new Error('Native tag does not match the Cargo version and component');
    const manifestVersion = json(join(root, '.release-please-manifest.json'))[path];
    const firstReleaseCheck = check && manifestVersion === '0.0.0' && entry['release-as'] === cargo.version;
    if (manifestVersion !== cargo.version && !firstReleaseCheck)
        throw new Error('Native release manifest does not match Cargo.toml');
    const spec = json(within(root, join(directory, 'release.json')));
    if (
        spec.host?.repository !== 'Pumpkin-MC/Pumpkin' ||
        typeof spec.host.tag !== 'string' ||
        !spec.host.tag ||
        /latest|nightly|[\r\n]/i.test(spec.host.tag) ||
        !shaPattern.test(spec.host.sha)
    )
        throw new Error('Native compatibility requires an exact Pumpkin release tag and source SHA');
    if (!/^\d+\.\d+\.\d+$/.test(spec.rustToolchain))
        throw new Error('Native compatibility requires an exact Rust toolchain version');
    if (
        !Array.isArray(spec.features) ||
        spec.features.some((feature) => typeof feature !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(feature)) ||
        new Set(spec.features).size !== spec.features.length
    )
        throw new Error('Native features must be an explicit unique list');
    if (!Number.isSafeInteger(spec.protocolVersion) || spec.protocolVersion < 1)
        throw new Error('Native protocolVersion must be a positive integer');
    for (const { target } of nativeTargets) {
        const asset = spec.host.assets?.[target];
        if (
            !asset ||
            typeof asset.name !== 'string' ||
            !/^[\w.+-]+$/.test(asset.name) ||
            !digestPattern.test(asset.sha256)
        )
            throw new Error(`Missing exact host asset and SHA-256 for ${target}`);
    }
    within(root, join(directory, 'Cargo.lock'));
    const loadTest = within(root, join(directory, 'test/release-load-test.mjs'));
    return { root, path, directory, component, manifestFile, cargo, spec, loadTest, tag, sha };
}
function build(options) {
    const release = resolveSource(options);
    const { root, directory, manifestFile, cargo, spec, component, tag, sha, loadTest } = release;
    const platform = nativeTargets.find(({ target }) => target === options.target);
    if (!platform) throw new Error(`Unsupported native target: ${options.target}`);
    const target = platform.target;
    const tools = Object.fromEntries(
        ['cargo', 'rustc', 'rustdoc'].map((tool) => {
            const binary = command('rustup', ['which', '--toolchain', spec.rustToolchain, tool], directory);
            if (!isAbsolute(binary)) throw new Error(`rustup did not resolve an absolute ${tool} binary path`);
            return [tool, realpathSync(binary)];
        }),
    );
    if (new Set(Object.values(tools).map((binary) => dirname(binary))).size !== 1)
        throw new Error('Cargo, rustc and rustdoc must come from the same pinned toolchain bin directory');
    const compilerEnv = { RUSTUP_TOOLCHAIN: spec.rustToolchain, RUSTC: tools.rustc, RUSTDOC: tools.rustdoc };
    const rustcVersion = command(tools.rustc, ['--version'], directory, compilerEnv).split(/\r?\n/)[0];
    if (!rustcVersion.startsWith(`rustc ${spec.rustToolchain} (`))
        throw new Error(`Resolved rustc binary ${tools.rustc} has unexpected version: ${rustcVersion}`);
    const rustc = command(tools.rustc, ['-vV'], directory, compilerEnv);
    if (
        !rustc.split(/\r?\n/).includes(`release: ${spec.rustToolchain}`) ||
        !rustc.split(/\r?\n/).includes(`host: ${target}`)
    )
        throw new Error(`Rust compiler must be ${spec.rustToolchain} running natively on ${target}`);
    const output = resolve(options.output);
    mkdirSync(output, { recursive: true });
    const hostAsset = spec.host.assets[target];
    const host = resolve(options.host);
    requireSha(sha256(host), hostAsset.sha256, 'Host binary SHA-256');
    chmodSync(host, 0o755);
    const targetDirectory = join(output, 'cargo-target');
    const args = [
        'build',
        '--manifest-path',
        manifestFile,
        '--release',
        '--locked',
        '--target',
        target,
        '--no-default-features',
    ];
    if (spec.features.length) args.push('--features', spec.features.join(','));
    const cargoLockSha256 = sha256(join(directory, 'Cargo.lock'));
    command(tools.cargo, args, directory, { ...compilerEnv, CARGO_TARGET_DIR: targetDirectory });
    requireSha(sha256(join(directory, 'Cargo.lock')), cargoLockSha256, 'Cargo.lock SHA-256 after locked build');
    const [name, checksumName, metadataName] = nativeAssetNames(component, target);
    const library = join(output, name);
    copyFileSync(
        join(targetDirectory, target, 'release', `${platform.prefix}${cargo.library}.${platform.extension}`),
        library,
    );
    const artifactDigest = sha256(library);
    const evidence = join(output, `${name}.load-test.json`);
    command(
        process.execPath,
        [loadTest, '--library', library, '--host', host, '--target', target, '--evidence', evidence],
        root,
        compilerEnv,
    );
    const proof = json(evidence);
    validateLoadTestEvidence(proof, {
        target,
        protocolVersion: spec.protocolVersion,
        artifactSha256: artifactDigest,
        hostBinarySha256: hostAsset.sha256,
    });
    requireSha(sha256(library), artifactDigest, 'Library SHA-256 after load test');
    requireSha(sha256(host), hostAsset.sha256, 'Host binary SHA-256 after load test');
    const metadata = {
        component,
        releaseBuild: !options.check,
        version: cargo.version,
        tag,
        sourceSha: sha,
        host: {
            repository: spec.host.repository,
            tag: spec.host.tag,
            sha: spec.host.sha,
            asset: hostAsset.name,
            binarySha256: hostAsset.sha256,
        },
        rustToolchain: spec.rustToolchain,
        rustc,
        compilerBinaries: tools,
        cargoLockSha256,
        features: spec.features,
        protocolVersion: spec.protocolVersion,
        target,
        artifact: { name, sha256: artifactDigest },
        loadTest: proof,
    };
    writeFileSync(join(output, checksumName), `${artifactDigest}  ${name}\n`);
    writeFileSync(join(output, metadataName), `${JSON.stringify(metadata, null, 4)}\n`);
    console.log(JSON.stringify(metadata, null, 4));
}

function renderNativeReleaseNotes(spec) {
    const matrix = nativeTargets
        .map(({ target, runner }) => {
            const hostAsset = spec.host.assets?.[target];
            if (!hostAsset?.name) throw new Error(`Missing host release asset for native target ${target}`);
            return `| \`${target}\` | \`${runner}\` | \`${hostAsset.name}\` |`;
        })
        .join('\n');
    const hostReleaseUrl = `https://github.com/${spec.host.repository}/releases/tag/${encodeURIComponent(spec.host.tag)}`;
    return [
        nativeNotesStart,
        '### Native build compatibility',
        `- Pumpkin host build: [${spec.host.tag}](${hostReleaseUrl}) at source commit \`${spec.host.sha}\`.`,
        `- Rust toolchain: \`${spec.rustToolchain}\`.`,
        `- Protocol version: \`${spec.protocolVersion}\`.`,
        '',
        '| Target triple | Build and load-test runner | Matching Pumpkin host asset |',
        '| --- | --- | --- |',
        matrix,
        nativeNotesEnd,
    ].join('\n');
}

function replaceNativeReleaseNotes(body, block) {
    const start = body.indexOf(nativeNotesStart);
    const end = body.indexOf(nativeNotesEnd);
    if (start === -1 && end === -1) {
        const separator = body.length === 0 ? '' : body.endsWith('\n') ? '\n' : '\n\n';
        return `${body}${separator}${block}`;
    }
    if (
        start === -1 ||
        end === -1 ||
        end < start ||
        body.indexOf(nativeNotesStart, start + nativeNotesStart.length) !== -1 ||
        body.indexOf(nativeNotesEnd, end + nativeNotesEnd.length) !== -1
    )
        throw new Error('Native GitHub Release notes contain malformed compatibility markers');
    const afterBlock = end + nativeNotesEnd.length;
    return `${body.slice(0, start)}${block}${body.slice(afterBlock)}`;
}

function updateNativeReleaseNotes(repository, tag, spec, cwd) {
    const release = api(repository, `releases/tags/${encodeURIComponent(tag)}`);
    if (!release || !Number.isSafeInteger(release.id) || (typeof release.body !== 'string' && release.body !== null))
        throw new Error(`Cannot update native GitHub Release notes for ${tag}: release lookup omitted its ID or body`);
    if (release.tag_name !== tag)
        throw new Error(`Cannot update native GitHub Release notes for ${tag}: release tag does not match`);
    const currentBody = release.body ?? '';
    const updatedBody = replaceNativeReleaseNotes(currentBody, renderNativeReleaseNotes(spec));
    if (updatedBody === currentBody) return;
    command(
        'gh',
        ['api', '--method', 'PATCH', `repos/${repository}/releases/${release.id}`, '-f', `body=${updatedBody}`],
        cwd,
    );
}

function attachNative(release, options) {
    const { component, cargo, spec, tag, sha, directory } = release;
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new Error('Expected a GitHub owner/repository');
    const target = options.target;
    const [name, checksumName, metadataName] = nativeAssetNames(component, target);
    const output = resolve(options.output);
    const library = join(output, name);
    const metadata = json(join(output, metadataName));
    const artifactDigest = sha256(library);
    const expected = {
        component,
        version: cargo.version,
        releaseBuild: true,
        tag,
        sourceSha: sha,
        target,
        rustToolchain: spec.rustToolchain,
        features: spec.features,
        protocolVersion: spec.protocolVersion,
        artifact: { name, sha256: artifactDigest },
        cargoLockSha256: sha256(join(directory, 'Cargo.lock')),
        host: {
            repository: spec.host.repository,
            tag: spec.host.tag,
            sha: spec.host.sha,
            asset: spec.host.assets[target].name,
            binarySha256: spec.host.assets[target].sha256,
        },
    };
    for (const [key, value] of Object.entries(expected)) {
        if (JSON.stringify(metadata[key]) !== JSON.stringify(value))
            throw new Error(`Native attachment metadata mismatch for ${key}`);
    }
    const proof = metadata.loadTest;
    validateLoadTestEvidence(proof, {
        target,
        protocolVersion: spec.protocolVersion,
        artifactSha256: artifactDigest,
        hostBinarySha256: spec.host.assets[target].sha256,
    });
    if (readFileSync(join(output, checksumName), 'utf8') !== `${artifactDigest}  ${name}\n`)
        throw new Error('Native attachment checksum mismatch');
    requireSha(tagSha(options.repository, tag), sha, 'GitHub native tag SHA before attachment');
    requireSha(tagSha(spec.host.repository, spec.host.tag), spec.host.sha, 'GitHub host tag SHA before attachment');
    updateNativeReleaseNotes(options.repository, tag, spec, directory);
    command('gh', [
        'release',
        'upload',
        tag,
        library,
        join(output, checksumName),
        join(output, metadataName),
        '--repo',
        options.repository,
        '--clobber',
    ]);
}
