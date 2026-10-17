import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, it } from 'node:test';

// Public seams: docs/release CLIs, Release Please adapter, workflow jobs and external build tools.
// Failure risks: Cargo version drift, native/WASM misrouting, lost historical releases,
// wrong tag/source/host/target, stale README links, partial assets and unverified libraries.
const root = resolve(import.meta.dirname, '..');
const directories = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const nativePath = 'native/pumpkin-plus-plus';
const tag = 'pumpkin-plus-plus-v0.0.1';
function put(directory, file, contents) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(
        join(directory, file),
        typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 4)}\n`,
    );
}
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'native-release-'));
    directories.push(directory);
    put(directory, 'package.json', { repository: 'https://github.com/example/repo' });
    put(directory, 'pnpm-workspace.yaml', 'packages: []\n');
    put(
        directory,
        'README.md',
        '# Components\n<!-- docs:begin docs-site -->\n<!-- docs:end docs-site -->\n<!-- docs:begin packages -->\n<!-- docs:end packages -->\n',
    );
    put(
        directory,
        `${nativePath}/Cargo.toml`,
        '[package]\nname = "pumpkin-plus-plus"\nversion = "0.0.0"\ndescription = "Native chunk preparation"\nlicense = "MIT"\n[lib]\nname = "pumpkin_plus_plus"\ncrate-type = ["cdylib"]\n',
    );
    put(
        directory,
        `${nativePath}/README.md`,
        '# Pumpkin++\n\n<!-- docs:begin native-release -->\n<!-- docs:end native-release -->\n',
    );
    put(directory, `${nativePath}/CHANGELOG.md`, '# Changelog\n');
    const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'));
    config.packages = {
        [nativePath]: { component: 'pumpkin-plus-plus', 'release-type': 'rust', 'release-as': '0.0.1' },
    };
    put(directory, 'release-please-config.json', config);
    put(directory, '.release-please-manifest.json', { [nativePath]: '0.0.0' });
    return directory;
}
function run(script, directory, ...args) {
    return spawnSync(process.execPath, [join(root, script), ...args], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, PUMPKIN_PLUGINS_ROOT: directory },
    });
}

it('discovers Cargo native components and pins their generated download link to the Cargo version', () => {
    const directory = fixture();
    let result = run('tools/docs/bin/pumpkin-plugins-docs.mjs', directory, 'root');
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(directory, 'README.md'), 'utf8'), /\*\*Native plugins\*\*/);
    const nativeReadme = join(directory, nativePath, 'README.md');
    assert.match(readFileSync(nativeReadme, 'utf8'), /releases\/tag\/pumpkin-plus-plus-v0\.0\.0/);
    put(directory, '.release-please-manifest.json', { [nativePath]: '0.0.0', 'tools/unrelated': '99.0.0' });
    result = run('tools/docs/bin/pumpkin-plugins-docs.mjs', directory, 'root', '--check');
    assert.equal(result.status, 0, result.stderr);
    put(
        directory,
        `${nativePath}/Cargo.toml`,
        readFileSync(join(directory, nativePath, 'Cargo.toml'), 'utf8').replace('0.0.0', '0.0.1'),
    );
    result = run('tools/docs/bin/pumpkin-plugins-docs.mjs', directory, 'root', '--check');
    assert.equal(result.status, 1);
    result = run('tools/docs/bin/pumpkin-plugins-docs.mjs', directory, 'root');
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(nativeReadme, 'utf8'), /releases\/tag\/pumpkin-plus-plus-v0\.0\.1/);
});

it('validates native Cargo registration and retires the first-release pin using Cargo rather than package.json', () => {
    const directory = fixture();
    let result = run('scripts/check-release-config.mjs', directory);
    assert.equal(result.status, 0, result.stderr);
    put(directory, '.release-please-manifest.json', { [nativePath]: '0.0.1' });
    result = run('scripts/check-release-config.mjs', directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cargo.toml/);
    put(
        directory,
        `${nativePath}/Cargo.toml`,
        readFileSync(join(directory, nativePath, 'Cargo.toml'), 'utf8').replace('0.0.0', '0.0.1'),
    );
    result = run('scripts/unpin-release-as.mjs', directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
        JSON.parse(readFileSync(join(directory, 'release-please-config.json'), 'utf8')).packages[nativePath][
            'release-as'
        ],
        undefined,
    );
    result = run('scripts/check-release-config.mjs', directory);
    assert.equal(result.status, 0, result.stderr);
});

it('routes multiple incomplete historical native tags independently and excludes WASM/Market publishers', async () => {
    const { collectReleaseFanout } = await import('./utils/release-fanout.mjs');
    const directory = fixture();
    const old = { tagName: tag, sha: 'a'.repeat(40) };
    const older = { tagName: 'pumpkin-plus-plus-v0.0.2', sha: 'b'.repeat(40) };
    const result = await collectReleaseFanout({
        createdReleases: [],
        repositoryConfig: { [nativePath]: { component: 'pumpkin-plus-plus' } },
        releasedVersions: {},
        currentSha: 'c'.repeat(40),
        findRelease: async () => undefined,
        existingReleases: [old, older, { tagName: 'pumpkin-plus-plus-v0.0.3', sha: 'd'.repeat(40) }],
        firstParentShas: new Set([old.sha, older.sha]),
        getReleaseAssets: async () => ({ assets: ['pumpkin-plus-plus-x86_64-unknown-linux-gnu.so'], immutable: false }),
        root: directory,
        log: () => {},
    });
    assert.deepEqual(result.paths.nativePaths, [nativePath, nativePath]);
    assert.deepEqual(result.paths.pluginPaths, []);
    assert.deepEqual(result.paths.toolPaths, []);
    assert.deepEqual(
        result.releases.map(({ tagName, sha, rebuildFromTag }) => ({ tagName, sha, rebuildFromTag })),
        [
            { ...old, rebuildFromTag: true },
            { ...older, rebuildFromTag: true },
        ],
    );
});

it('selects native shipped inputs at the Release Please seam without TypeScript/WASM dependency fanout', async () => {
    const { bundledChangesPlugin, workspacePackages } = await import('./utils/release-commits.mjs');
    const directory = fixture();
    const history = [
        { sha: 'rust', message: 'fix(pumpkin-plus-plus): handle unload', files: [`${nativePath}/src/lib.rs`] },
        {
            sha: 'lock',
            message: 'fix(pumpkin-plus-plus): pin native dependencies',
            files: [`${nativePath}/Cargo.lock`],
        },
        {
            sha: 'toolchain',
            message: 'fix(pumpkin-plus-plus): pin compiler',
            files: [`${nativePath}/rust-toolchain.toml`],
        },
        { sha: 'packaging', message: 'fix(release): verify native binaries', files: ['scripts/native-release.mjs'] },
        { sha: 'wasm', message: 'fix: update guest compiler', files: ['tools/build/src/build.ts'] },
        { sha: 'docs', message: 'docs: install native library', files: [`${nativePath}/README.md`] },
        { sha: 'tests', message: 'test: native loader', files: [`${nativePath}/tests/load.rs`] },
        {
            sha: 'target',
            message: 'fix: generated binary',
            files: [`${nativePath}/target/release/libpumpkin_plus_plus.so`],
        },
        { sha: 'old', message: 'feat: previous release', files: [`${nativePath}/Cargo.toml`] },
    ];
    const github = {
        async *mergeCommitIterator() {
            yield* history;
        },
    };
    const commits = {};
    const strategies = { [nativePath]: {} };
    const plugin = bundledChangesPlugin(
        github,
        'master',
        workspacePackages(directory),
        { [nativePath]: '0.0.1' },
        500,
        () => {},
        directory,
    );
    await plugin.preconfigure(strategies, commits, { [nativePath]: { sha: 'old' } });
    assert.deepEqual(
        commits[nativePath].map(({ sha }) => sha),
        ['rust', 'lock', 'toolchain', 'packaging'],
    );
});

it('registers the canonical native Cargo component idempotently through its registration CLI', () => {
    const directory = fixture();
    put(directory, 'release-please-config.json', { packages: {} });
    put(directory, '.release-please-manifest.json', {});
    let result = run('scripts/register-native-component.mjs', directory, nativePath);
    assert.equal(result.status, 0, result.stderr);
    const configFile = join(directory, 'release-please-config.json');
    const config = readFileSync(configFile, 'utf8');
    assert.deepEqual(JSON.parse(config).packages[nativePath], {
        component: 'pumpkin-plus-plus',
        'release-type': 'rust',
        'release-as': '0.0.1',
    });
    assert.equal(
        JSON.parse(readFileSync(join(directory, '.release-please-manifest.json'), 'utf8'))[nativePath],
        '0.0.0',
    );
    result = run('scripts/register-native-component.mjs', directory, nativePath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(configFile, 'utf8'), config);
});

const targets = [
    ['x86_64-unknown-linux-gnu', 'so', 'lib'],
    ['aarch64-unknown-linux-gnu', 'so', 'lib'],
    ['aarch64-apple-darwin', 'dylib', 'lib'],
    ['x86_64-pc-windows-msvc', 'dll', ''],
    ['aarch64-pc-windows-msvc', 'dll', ''],
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
function packagingFixture(target, extension, prefix) {
    const directory = fixture();
    const hostBytes = Buffer.from('exact host release binary');
    const spec = {
        host: {
            repository: 'Pumpkin-MC/Pumpkin',
            tag: '0.2.0+26.3-26.51',
            sha: '204a94ed895f041a845630d5a23c094705a0704e',
            assets: Object.fromEntries(
                targets.map(([triple]) => [triple, { name: `pumpkin-${triple}`, sha256: digest(hostBytes) }]),
            ),
        },
        rustToolchain: '1.98.1',
        features: ['native-bridge'],
        protocolVersion: 1,
    };
    put(directory, `${nativePath}/release.json`, spec);
    put(
        directory,
        `${nativePath}/Cargo.toml`,
        readFileSync(join(directory, nativePath, 'Cargo.toml'), 'utf8').replace('0.0.0', '0.0.1'),
    );
    put(directory, '.release-please-manifest.json', { [nativePath]: '0.0.1' });
    put(directory, `${nativePath}/Cargo.lock`, '# fixture lock\n');
    put(
        directory,
        `${nativePath}/test/release-load-test.mjs`,
        `
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const args = Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2].slice(2),process.argv[3+i*2]]));
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const status = process.env.FAIL_LOAD ? 'failed' : 'passed';
writeFileSync(args.evidence,JSON.stringify({status,artifactSha256:digest(args.library),hostBinarySha256:digest(args.host),target:args.target,protocolVersion:1,githubTokens:[process.env.GH_TOKEN,process.env.GITHUB_TOKEN].filter(Boolean),engines:['quickjs','static-hermes'].map(engine=>({engine,status}))}));
`,
    );
    const git = (...args) =>
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
            cwd: directory,
            encoding: 'utf8',
        }).trim();
    git('init', '-q');
    git('add', '.');
    git('commit', '--no-gpg-sign', '-qm', 'feat: native release fixture');
    const sha = git('rev-parse', 'HEAD');
    git('tag', '--no-sign', tag);
    const toolsDirectory = mkdtempSync(join(tmpdir(), 'native-release-tools-'));
    directories.push(toolsDirectory);
    const hostBinary = join(toolsDirectory, `pumpkin-host-${target}`);
    writeFileSync(hostBinary, hostBytes);
    const bin = join(toolsDirectory, 'fake-bin');
    const trace = join(toolsDirectory, 'commands.jsonl');
    const executable = (name, source) => {
        put(toolsDirectory, `fake-bin/${name}`, `#!/usr/bin/env node\n${source}`);
        chmodSync(join(bin, name), 0o755);
    };
    executable(
        'rustc',
        `console.log('rustc 1.98.1 (48a229cea 2026-09-01)\\nbinary: rustc\\ncommit-hash: 48a229cea\\nhost: ${target}\\nrelease: 1.98.1');`,
    );
    executable(
        'cargo',
        `import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({tool:'cargo',args:process.argv.slice(2),rustc:process.env.RUSTC,rustdoc:process.env.RUSTDOC,githubTokens:[process.env.GH_TOKEN,process.env.GITHUB_TOKEN].filter(Boolean)})+'\\n');
const out=join(process.env.CARGO_TARGET_DIR,${JSON.stringify(target)},'release');mkdirSync(out,{recursive:true});writeFileSync(join(out,${JSON.stringify(`${prefix}pumpkin_plus_plus.${extension}`)}),'native ${target}');`,
    );
    const pinnedBin = join(toolsDirectory, 'toolchain-bin');
    mkdirSync(pinnedBin, { recursive: true });
    for (const name of ['rustc', 'cargo']) {
        writeFileSync(join(pinnedBin, name), readFileSync(join(bin, name)));
        chmodSync(join(pinnedBin, name), 0o755);
    }
    put(toolsDirectory, 'toolchain-bin/rustdoc', '#!/usr/bin/env node\nconsole.log("rustdoc 1.98.1");');
    chmodSync(join(pinnedBin, 'rustdoc'), 0o755);
    executable('rustc', "console.log('rustc 1.99.0\\nhost: wrong-host\\nrelease: 1.99.0');");
    executable('rustup', `console.log(${JSON.stringify(pinnedBin)}+'/'+process.argv.at(-1));`);
    executable(
        'gh',
        `import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(trace)},JSON.stringify({tool:'gh',args,tokens:{GH_TOKEN:process.env.GH_TOKEN,GITHUB_TOKEN:process.env.GITHUB_TOKEN}})+'\\n');
if(args[0]==='api'&&args[1]==='--method'&&args[2]==='PATCH') {}
else if(args[0]==='api'){const endpoint=args[1];
if(endpoint.includes('/git/ref/tags/')) console.log(JSON.stringify({object:{type:'commit',sha:endpoint.includes('Pumpkin-MC')?${JSON.stringify(spec.host.sha)}:(process.env.WRONG_TAG_SHA||${JSON.stringify(sha)})}}));
else if(endpoint.includes('/releases/tags/')) {const releaseTag=decodeURIComponent(endpoint.split('/releases/tags/').at(-1));console.log(JSON.stringify({id:123,tag_name:releaseTag,body:'Existing release text.\\n'}));}
else throw new Error(endpoint);
}else if(args[0]==='release'&&args[1]==='download') { const dest=args[args.indexOf('--dir')+1]; mkdirSync(dest,{recursive:true});writeFileSync(join(dest,${JSON.stringify(spec.host.assets[target].name)}),process.env.BAD_HOST?'wrong host':${JSON.stringify(hostBytes.toString())});}
else if(args[0]==='release'&&args[1]==='upload') {} else throw new Error(args.join(' '));`,
    );
    return {
        directory,
        sha,
        trace,
        hostBinary,
        output: join(toolsDirectory, 'artifacts'),
        env: {
            ...Object.fromEntries(
                Object.entries(process.env).filter(([name]) => name !== 'GH_TOKEN' && name !== 'GITHUB_TOKEN'),
            ),
            PATH: `${bin}:${process.env.PATH}`,
        },
    };
}
function build(fixture, target, extraEnv = {}) {
    return spawnSync(
        process.execPath,
        [
            join(root, 'scripts/native-release.mjs'),
            'build',
            '--tag',
            tag,
            '--sha',
            fixture.sha,
            '--target',
            target,
            '--source-root',
            fixture.directory,
            '--host',
            fixture.hostBinary,
            '--output',
            fixture.output,
        ],
        { cwd: fixture.directory, encoding: 'utf8', env: { ...fixture.env, ...extraEnv } },
    );
}
function attach(fixture, target, extraEnv = {}) {
    return spawnSync(
        process.execPath,
        [
            join(root, 'scripts/native-release.mjs'),
            'attach',
            '--tag',
            tag,
            '--sha',
            fixture.sha,
            '--target',
            target,
            '--source-root',
            fixture.directory,
            '--output',
            fixture.output,
            '--repository',
            'example/repo',
        ],
        { cwd: fixture.directory, encoding: 'utf8', env: { ...fixture.env, ...extraEnv } },
    );
}
function retargetNativeTag(fixture) {
    const replacement = execFileSync(
        'git',
        [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit-tree',
            'HEAD^{tree}',
            '-p',
            'HEAD',
            '-m',
            'test: moved native tag',
        ],
        { cwd: fixture.directory, encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['tag', '--force', '--no-sign', tag, replacement], { cwd: fixture.directory });
}

it('builds verified artifacts without credentials, then attaches only matching release assets', () => {
    for (const [target, extension, prefix] of targets) {
        const f = packagingFixture(target, extension, prefix);
        const result = build(f, target);
        assert.equal(result.status, 0, result.stderr);
        const name = `pumpkin-plus-plus-${target}.${extension}`;
        const bytes = readFileSync(join(f.output, name));
        const metadata = JSON.parse(readFileSync(join(f.output, `${name}.json`), 'utf8'));
        assert.equal(metadata.tag, tag);
        assert.equal(metadata.sourceSha, f.sha);
        assert.equal(metadata.host.tag, '0.2.0+26.3-26.51');
        assert.equal(metadata.host.sha, '204a94ed895f041a845630d5a23c094705a0704e');
        assert.equal(metadata.host.binarySha256, digest('exact host release binary'));
        assert.equal(metadata.target, target);
        assert.equal(metadata.rustToolchain, '1.98.1');
        assert.match(metadata.rustc, /48a229cea/);
        assert.deepEqual(metadata.features, ['native-bridge']);
        assert.equal(metadata.protocolVersion, 1);
        assert.equal(metadata.artifact.sha256, digest(bytes));
        assert.equal(readFileSync(join(f.output, `${name}.sha256`), 'utf8'), `${digest(bytes)}  ${name}\n`);
        assert.equal(metadata.loadTest.status, 'passed');
        assert.deepEqual(metadata.loadTest.githubTokens, []);
        const commands = readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse);
        const compile = commands.find(({ tool }) => tool === 'cargo');
        assert.deepEqual(compile.githubTokens, []);
        assert.match(compile.rustc, /toolchain-bin[\\/]rustc$/);
        assert.match(compile.rustdoc, /toolchain-bin[\\/]rustdoc$/);
        assert.ok(compile.args.includes('--locked'));
        assert.ok(compile.args.includes('--no-default-features'));
        assert.equal(
            commands.some(({ tool }) => tool === 'gh'),
            false,
        );

        const attached = attach(f, target, { GH_TOKEN: 'native-release-test-token' });
        assert.equal(attached.status, 0, attached.stderr);
        const githubCommands = readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse);
        const github = githubCommands.filter(({ tool }) => tool === 'gh');
        assert.ok(github.length > 0);
        assert.ok(github.every(({ tokens }) => tokens.GH_TOKEN === 'native-release-test-token'));
        const upload = github.find(({ args }) => args[0] === 'release' && args[1] === 'upload');
        assert.equal(upload.args[2], tag);
        assert.ok(upload.args.includes('example/repo'));
        assert.equal(upload.args.filter((arg) => arg.startsWith(f.output)).length, 3);
        assert.doesNotMatch(JSON.stringify(github), /releases\/latest|\.wasm|market|sign-pumpkin/);
    }
});

it('refuses a moved source tag, wrong host bytes and failed load evidence', () => {
    const movedTag = packagingFixture(...targets[0]);
    retargetNativeTag(movedTag);
    const movedResult = build(movedTag, targets[0][0]);
    assert.notEqual(movedResult.status, 0);
    assert.match(movedResult.stderr, /Native release tag SHA/);

    const wrongHost = packagingFixture(...targets[0]);
    writeFileSync(wrongHost.hostBinary, 'wrong host bytes');
    const hostResult = build(wrongHost, targets[0][0]);
    assert.notEqual(hostResult.status, 0);
    assert.match(hostResult.stderr, /Host binary SHA-256/);

    const failedLoad = packagingFixture(...targets[0]);
    const loadResult = build(failedLoad, targets[0][0], { FAIL_LOAD: '1' });
    assert.notEqual(loadResult.status, 0);
    assert.match(loadResult.stderr, /load-test evidence/);
});

it('revalidates the host binary after the load test before publishing compatibility metadata', () => {
    const f = packagingFixture(...targets[0]);
    const testFile = join(f.directory, nativePath, 'test/release-load-test.mjs');
    writeFileSync(testFile, `${readFileSync(testFile, 'utf8')}\nwriteFileSync(args.host,'tampered host');\n`);
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '.'], {
        cwd: f.directory,
    });
    execFileSync(
        'git',
        [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-qm',
            'test: mutate host',
            '--no-gpg-sign',
        ],
        { cwd: f.directory },
    );
    f.sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.directory, encoding: 'utf8' }).trim();
    execFileSync('git', ['tag', '--no-sign', '--force', tag], { cwd: f.directory });
    // The GitHub boundary must return the moved fixture tag, independently of local resolution.
    const result = build(f, targets[0][0], { WRONG_TAG_SHA: f.sha });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Host binary SHA-256 after load test/);
    assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /"upload"/);
});

it('fans native tags into an architecture-matched load-test matrix and includes native releases in count validation', async () => {
    const { parse } = await import('yaml');
    const workflow = parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
    assert.equal(workflow.jobs.native.uses, './.github/workflows/native.yml');
    assert.match(workflow.jobs.native.with.releases, /native_releases/);
    assert.equal(workflow.jobs.native.with.attach, true);
    assert.ok(workflow.jobs['native-assets'].needs.includes('native'));
    const native = parse(readFileSync(join(root, '.github/workflows/native.yml'), 'utf8'));
    const job = native.jobs.build;
    assert.equal(job.permissions.contents, 'read');
    const planCheckout = native.jobs.plan.steps.find(({ uses }) => uses === 'actions/checkout@v7.0.1');
    assert.equal(planCheckout.with['persist-credentials'], false);
    assert.equal(workflow.jobs['native-assets'].permissions.contents, 'write');
    assert.match(job['runs-on'], /matrix\.platform\.runner/);
    const nodeSetup = job.steps.find(({ name }) => name === 'Setup Node for exact native source');
    assert.equal(nodeSetup.with.architecture, `\${{ runner.arch == 'ARM64' && 'arm64' || 'x64' }}`);
    const linker = job.steps.find(({ name }) => name === 'Select MSVC linker for Cargo');
    assert.match(linker.if, /runner\.os == 'Windows'/);
    assert.match(linker.run, /VCToolsInstallDir/);
    assert.match(linker.run, /GITHUB_PATH/);
    assert.match(linker.run, /CARGO_TARGET_\$\{cargoTarget\}_LINKER/);
    const packagingCheckout = job.steps.find(({ name }) => name === 'Checkout packaging tooling');
    assert.equal(packagingCheckout.with['persist-credentials'], false);
    const source = job.steps.find(({ id }) => id === 'source');
    assert.match(source.with.ref, /matrix\.release\.tagName/);
    assert.equal(source.with['persist-credentials'], false);
    assert.equal(job.env?.GH_TOKEN, undefined);
    const hostStep = job.steps.find(({ name }) => name === 'Download and verify pinned Pumpkin host');
    const sourceIndex = job.steps.indexOf(source);
    const hostIndex = job.steps.indexOf(hostStep);
    const bootstrapIndex = job.steps.findIndex(({ uses }) => uses === './.github/common/bootstrap');
    const pnpmSetupIndex = job.steps.findIndex(({ name }) => name === 'Setup exact source pnpm');
    const dependencyInstallIndex = job.steps.findIndex(
        ({ name }) => name === 'Install exact native source dependencies',
    );
    const capabilityBuildIndex = job.steps.findIndex(
        ({ name }) => name === 'Build WASI capability package for native tests',
    );
    const nativeBuildIndex = job.steps.findIndex(({ name }) => name === 'Build, load-test and package native component');
    assert.equal(hostIndex, sourceIndex + 1, 'the pinned host must be the first step after source checkout');
    assert.ok(hostIndex < bootstrapIndex, 'the host token step must precede dependency installation');
    assert.ok(hostIndex < pnpmSetupIndex, 'the host token step must precede running the pnpm toolchain');
    assert.ok(hostIndex < dependencyInstallIndex, 'the host token step must precede installing release-source');
    assert.ok(capabilityBuildIndex > dependencyInstallIndex, 'load-test dependencies must be built after install');
    assert.ok(capabilityBuildIndex < nativeBuildIndex, 'load-test dependencies must be built before testing');
    assert.equal(job.steps[capabilityBuildIndex]['working-directory'], 'release-source');
    assert.equal(job.steps[capabilityBuildIndex].run, 'pnpm --filter @pumpkin-plugins/wasi-capabilities build');
    assert.ok(
        job.steps.slice(0, hostIndex).every(({ env }) => env?.GH_TOKEN === undefined),
        'the host token must not be present in earlier steps',
    );
    assert.match(hostStep.env.GH_TOKEN, /\$\{\{ github\.token \}\}/);
    assert.match(hostStep.run, /git\/ref\/tags/);
    assert.match(hostStep.run, /release', 'download/);
    assert.match(hostStep.run, /checksum mismatch/);
    assert.match(hostStep.run, /wasi-sdk\.lock\.json/);
    assert.match(hostStep.run, /PUMPKIN_WASI_SDK_RELEASE_METADATA_FILE/);
    const prepareHermesStep = job.steps.find(({ name }) => name === 'Prepare Static Hermes');
    assert.equal(prepareHermesStep.env?.GH_TOKEN, undefined);
    const buildStep = job.steps.find(({ id }) => id === 'build');
    assert.match(buildStep.run, /scripts\/native-release.mjs build/);
    assert.equal(buildStep.env.GH_TOKEN, undefined);
    assert.match(buildStep.run, /--host "\$HOST_BINARY"/);
    assert.equal(job.env.RUST_MIN_STACK, '67108864');
    assert.equal(job.env.CARGO_BUILD_JOBS, '2');
    const nativeAssets = workflow.jobs['native-assets'];
    assert.equal(nativeAssets.env?.GH_TOKEN, undefined);
    const nativeAssetsCheckout = nativeAssets.steps.find(({ uses }) => uses === 'actions/checkout@v7.0.1');
    assert.equal(nativeAssetsCheckout.with['persist-credentials'], false);
    const attachStep = nativeAssets.steps.find(
        ({ name }) => name === 'Verify and attach native library to its release',
    );
    assert.match(attachStep.env.GH_TOKEN, /\$\{\{ github\.token \}\}/);
    assert.doesNotMatch(JSON.stringify(native), /sign-pumpkin|market|\.wasm|download-artifact/);
    const matrix = run('scripts/native-release.mjs', root, 'matrix');
    assert.equal(matrix.status, 0, matrix.stderr);
    assert.deepEqual(
        JSON.parse(matrix.stdout).include.map(({ runner }) => runner),
        ['ubuntu-24.04', 'ubuntu-26.04-arm', 'macos-26', 'windows-2025', 'windows-11-arm'],
    );
    assert.deepEqual(
        JSON.parse(matrix.stdout).include.map(({ target }) => target),
        targets.map(([target]) => target),
    );
    const guard = workflow.jobs['release-fanout-check'].steps[0].run;
    const env = {
        ...process.env,
        RELEASE_COUNT: '2',
        PREPARED_PR_COUNT: '0',
        OPEN_PR_COUNT: '0',
        PLUGIN_PATHS: '[]',
        ACTION_PATHS: '[]',
        TOOL_PATHS: '[]',
        EXTENSION_PATHS: '[]',
        NATIVE_PATHS: JSON.stringify([nativePath, nativePath]),
        RELEASE_METADATA: '{}',
        NATIVE_RELEASES: JSON.stringify([
            { path: nativePath, tagName: tag, version: '0.0.1', sha: 'a'.repeat(40) },
            { path: nativePath, tagName: 'pumpkin-plus-plus-v0.0.2', version: '0.0.2', sha: 'b'.repeat(40) },
        ]),
    };
    let result = spawnSync('bash', ['-c', guard], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    result = spawnSync('bash', ['-c', guard], { env: { ...env, RELEASE_COUNT: '1' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    result = spawnSync('bash', ['-c', guard], { env: { ...env, NATIVE_RELEASES: '[]' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
});

it('uses the initial Cargo 0.1.0 as the native first-release pin and rejects shared tag streams', () => {
    const directory = fixture();
    put(
        directory,
        `${nativePath}/Cargo.toml`,
        readFileSync(join(directory, nativePath, 'Cargo.toml'), 'utf8').replace('0.0.0', '0.1.0'),
    );
    const config = JSON.parse(readFileSync(join(directory, 'release-please-config.json'), 'utf8'));
    config.packages = {};
    put(directory, 'release-please-config.json', config);
    put(directory, '.release-please-manifest.json', {});
    let result = run('scripts/register-native-component.mjs', directory, nativePath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
        JSON.parse(readFileSync(join(directory, 'release-please-config.json'), 'utf8')).packages[nativePath][
            'release-as'
        ],
        '0.1.0',
    );
    result = run('scripts/check-release-config.mjs', directory);
    assert.equal(result.status, 0, result.stderr);
    const bad = JSON.parse(readFileSync(join(directory, 'release-please-config.json'), 'utf8'));
    bad.packages[nativePath]['include-component-in-tag'] = false;
    put(directory, 'release-please-config.json', bad);
    result = run('scripts/check-release-config.mjs', directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /independent.*tag/);
});

it('checks handwritten native documentation links through the repository docs CLI', () => {
    const directory = fixture();
    put(directory, `${nativePath}/README.md`, '# Pumpkin++\n\n[Install](missing-install.md)\n');
    const result = run('scripts/check-docs.mjs', directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /native\/pumpkin-plus-plus\/README.md.*missing-install/);
});

it('includes catalogued native guides in the documentation catalog', () => {
    const directory = fixture();
    put(
        directory,
        `${nativePath}/docs/install.md`,
        '---\nnavigation:\n    catalog: true\n---\n# Native installation\n\nInstall a matching native library.\n',
    );
    put(
        directory,
        'docs/README.md',
        '# Documentation\n\n<!-- docs:begin site-index -->\n<!-- docs:end site-index -->\n',
    );
    const result = run('tools/docs/bin/pumpkin-plugins-docs.mjs', directory, 'docs-index');
    assert.equal(result.status, 0, result.stderr);
    assert.match(
        readFileSync(join(directory, 'docs/README.md'), 'utf8'),
        /Native installation.*native\/pumpkin-plus-plus\/docs\/install.md/,
    );
});

it('refuses untracked Rust inputs that are absent from the release tag', () => {
    const f = packagingFixture(...targets[0]);
    put(f.directory, `${nativePath}/src/lib.rs`, '// source absent from the tag\n');
    const result = build(f, targets[0][0]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source has.*modifications/);
});

it('builds a historical tag in its own checkout and rejects the newer HEAD as that release', () => {
    const f = packagingFixture(...targets[0]);
    put(f.directory, 'newer.txt', 'newer unrelated component release\n');
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'newer.txt'], {
        cwd: f.directory,
    });
    execFileSync(
        'git',
        [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--no-gpg-sign',
            '-qm',
            'feat: unrelated newer source',
        ],
        { cwd: f.directory },
    );
    const wrongHead = build(f, targets[0][0]);
    assert.notEqual(wrongHead.status, 0);
    assert.match(wrongHead.stderr, /Checked-out native source SHA/);
    const checkout = join(mkdtempSync(join(tmpdir(), 'native-historical-')), 'source');
    directories.push(dirname(checkout));
    execFileSync('git', ['worktree', 'add', '--detach', checkout, f.sha], { cwd: f.directory, stdio: 'pipe' });
    f.directory = checkout;
    const result = build(f, targets[0][0]);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(
        readFileSync(join(f.output, 'pumpkin-plus-plus-x86_64-unknown-linux-gnu.so.json'), 'utf8'),
    );
    assert.equal(metadata.sourceSha, f.sha);
    assert.equal(metadata.tag, tag);
});

it('checks an unreleased Cargo version in CI without requiring or attaching a native tag', () => {
    const f = packagingFixture(...targets[0]);
    put(f.directory, '.release-please-manifest.json', { [nativePath]: '0.0.0' });
    execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '.release-please-manifest.json'],
        { cwd: f.directory },
    );
    execFileSync(
        'git',
        [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--no-gpg-sign',
            '-qm',
            'chore: initial manifest baseline',
        ],
        { cwd: f.directory },
    );
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.directory, encoding: 'utf8' }).trim();
    const result = spawnSync(
        process.execPath,
        [
            join(root, 'scripts/native-release.mjs'),
            'build',
            '--tag',
            tag,
            '--sha',
            sha,
            '--target',
            targets[0][0],
            '--source-root',
            f.directory,
            '--host',
            f.hostBinary,
            '--output',
            f.output,
            '--check',
        ],
        { env: f.env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /"upload"|"tool":"gh"/);
    assert.equal(
        JSON.parse(readFileSync(join(f.output, 'pumpkin-plus-plus-x86_64-unknown-linux-gnu.so.json'), 'utf8'))
            .releaseBuild,
        false,
    );
});
