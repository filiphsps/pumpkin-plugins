import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const runtime = resolve(import.meta.dirname, '../runtime');
const dirs: string[] = [];
const pinned = JSON.parse(readFileSync(join(runtime, 'provenance.json'), 'utf8'));
const commit: string = pinned.sourceCommit;
const rust: string = pinned.rustVersion;
const cargo: string = pinned.cargoVersion;
const clang: string = pinned.clangVersion;
const sdkVersion = `${pinned.sdkVersion}\n`;
const shippedHash: string = pinned.outputSha256;

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const dir = mkdtempSync(join(tmpdir(), 'runtime-provenance-'));
    dirs.push(dir);
    const source = join(dir, 'source');
    const sdk = join(dir, 'sdk');
    const bin = join(dir, 'bin');
    const copiedRuntime = join(dir, 'tools/build/runtime');
    const copiedPackageNodeModules = join(dir, 'tools/build/node_modules');
    const builtArtifact = join(dir, 'built-artifact.wasm');
    for (const path of [source, join(sdk, 'bin'), bin, copiedPackageNodeModules]) mkdirSync(path, { recursive: true });
    symlinkSync(
        resolve(import.meta.dirname, '../node_modules/commander'),
        join(copiedPackageNodeModules, 'commander'),
        'junction',
    );
    cpSync(runtime, copiedRuntime, { recursive: true });
    cpSync(join(runtime, 'quickjs-runtime-bigint.wasm'), builtArtifact);
    const git = (...args: string[]) => execFileSync(realGit, ['-C', source, ...args], { stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(source, 'Cargo.lock'), 'locked dependencies\n');
    writeFileSync(join(source, 'source.txt'), 'original\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    const executable = (name: string, body: string) =>
        writeFileSync(name, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
    executable(
        join(bin, 'git'),
        `if [ "$3" = rev-parse ] && [ "$4" = HEAD ]; then echo '${commit}'; else exec '${realGit}' "$@"; fi`,
    );
    executable(join(bin, 'rustc'), `if [ "$1" = --version ]; then echo '${rust}'; else echo '${dir}/target-lib'; fi`);
    mkdirSync(join(dir, 'target-lib'));
    executable(
        join(bin, 'cargo'),
        `if [ "$1" = --version ]; then echo '${cargo}'; else printf '%s\\n' "$@" > '${dir}/cargo-args'; mkdir -p "$CARGO_TARGET_DIR/wasm32-wasip2/release"; cp '${builtArtifact}' "$CARGO_TARGET_DIR/wasm32-wasip2/release/componentize_qjs_runtime.wasm"; fi`,
    );
    executable(join(sdk, 'bin/clang'), `echo '${clang}'`);
    writeFileSync(join(sdk, 'VERSION'), sdkVersion);
    // A real, tiny patch exercises dirty-tree admission independently of the upstream checkout.
    writeFileSync(join(source, 'source.txt'), 'patched\n');
    const patch = git('diff', '--binary', 'HEAD');
    writeFileSync(join(copiedRuntime, 'componentize-qjs-bigint.patch'), patch);
    writeFileSync(join(source, 'source.txt'), 'original\n');
    const expectedPath = join(copiedRuntime, 'provenance.json');
    if (existsSync(expectedPath)) {
        const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
        expected.patchSha256 = createHash('sha256').update(patch).digest('hex');
        expected.cargoLockSha256 = createHash('sha256').update('locked dependencies\n').digest('hex');
        writeFileSync(expectedPath, JSON.stringify(expected));
    }
    const output = join(dir, 'candidate');
    const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QJS_SOURCE_DIR: source,
        WASI_SDK_PATH: sdk,
        CARGO_TARGET_DIR: join(dir, 'target'),
        RUNTIME_OUTPUT_DIR: output,
    };
    const verifyCandidate = () =>
        spawnSync(process.execPath, [join(copiedRuntime, 'provenance.mjs'), 'verify-candidate', output], {
            encoding: 'utf8',
            timeout: 5000,
        });
    const verifyShipped = (path = copiedRuntime) =>
        spawnSync(process.execPath, [join(copiedRuntime, 'provenance.mjs'), 'verify', path], {
            encoding: 'utf8',
            timeout: 5000,
        });
    const run = () =>
        spawnSync('sh', [join(copiedRuntime, 'build.sh')], {
            encoding: 'utf8',
            timeout: 15000,
            env,
        });
    return {
        dir,
        source,
        sdk,
        bin,
        copiedRuntime,
        output,
        builtArtifact,
        run,
        verifyCandidate,
        verifyShipped,
        env,
        git,
        executable,
    };
}

function rejects(f: ReturnType<typeof fixture>, message: string) {
    const result = f.run();
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(message);
}

// build.sh and the tool stubs are POSIX shell scripts, so these checks cannot run on Windows.
describe.skipIf(process.platform === 'win32')('runtime provenance build', () => {
    it('builds only locked inputs and emits a verified candidate manifest', () => {
        const f = fixture();
        const result = f.run();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(f.dir, 'cargo-args'), 'utf8')).toContain('--locked');
        const manifest = JSON.parse(readFileSync(join(f.output, 'provenance.json'), 'utf8'));
        expect(manifest.sourceCommit).toBe(commit);
        expect(manifest.outputSha256).toBe(shippedHash);
        expect(
            createHash('sha256')
                .update(readFileSync(join(f.output, 'quickjs-runtime-bigint.wasm')))
                .digest('hex'),
        ).toBe(manifest.outputSha256);
        expect(f.verifyShipped(f.output).stderr).toContain('Candidate provenance cannot verify as shipped runtime');
        expect(f.run().status).toBe(0); // Exactly the declared patch is allowed on repeat builds.
    }, 15_000);
    it('records and verifies a host-specific candidate hash without changing the shipped hash', () => {
        const f = fixture();
        const bytes = Buffer.from('host-specific runtime output');
        writeFileSync(f.builtArtifact, bytes);
        const expectedHash = createHash('sha256').update(bytes).digest('hex');
        const result = f.run();
        expect(result.status, result.stderr).toBe(0);
        const manifest = JSON.parse(readFileSync(join(f.output, 'provenance.json'), 'utf8'));
        expect(manifest.outputSha256).toBe(expectedHash);
        expect(manifest.outputSha256).not.toBe(shippedHash);
        expect(manifest.buildHost).toBe(`${process.platform}-${process.arch}`);
        expect(manifest.buildHostRelease).toEqual(expect.any(String));
        expect(result.stdout).toContain(expectedHash);
        expect(f.verifyCandidate().status).toBe(0);
        expect(f.verifyShipped(f.output).stderr).toContain('Candidate provenance cannot verify as shipped runtime');
    }, 15_000);
    it('verifies the vendored runtime against its pinned output hash', () => {
        const f = fixture();
        const result = f.verifyShipped();
        expect(result.status, result.stderr).toBe(0);
    });
    it('rejects unrelated tracked dirt', () => {
        const f = fixture();
        writeFileSync(join(f.source, 'source.txt'), 'unrelated\n');
        rejects(f, 'Source changes differ from the declared patch');
    });
    it.each(['extra.txt', '.cargo/config.toml'])('rejects untracked input %s', (name) => {
        const f = fixture();
        mkdirSync(join(f.source, '.cargo'), { recursive: true });
        writeFileSync(join(f.source, name), 'extra');
        rejects(f, 'Untracked source inputs');
    });
    it('rejects ignored source inputs', () => {
        const f = fixture();
        writeFileSync(join(f.source, '.git/info/exclude'), 'ignored\n');
        writeFileSync(join(f.source, 'ignored'), 'extra');
        rejects(f, 'Untracked source inputs');
    });
    it('rejects a different Rust compiler', () => {
        const f = fixture();
        f.executable(join(f.bin, 'rustc'), "echo 'rustc 1.98.0'");
        rejects(f, 'Rust version mismatch');
    });
    it('rejects a different Cargo version', () => {
        const f = fixture();
        f.executable(join(f.bin, 'cargo'), "echo 'cargo 1.98.0'");
        rejects(f, 'Cargo version mismatch');
    });
    it('rejects a different SDK', () => {
        const f = fixture();
        writeFileSync(join(f.sdk, 'VERSION'), '33.0\n');
        rejects(f, 'wasi-sdk version mismatch');
    });
    it('rejects a different SDK compiler', () => {
        const f = fixture();
        f.executable(join(f.sdk, 'bin/clang'), "echo 'clang version 22'");
        rejects(f, 'Clang version mismatch');
    });
    it('rejects dependency lock drift', () => {
        const f = fixture();
        writeFileSync(join(f.source, 'Cargo.lock'), 'drift');
        rejects(f, 'Cargo.lock hash mismatch');
    });
    it('rejects patch drift', () => {
        const f = fixture();
        const patchPath = join(f.copiedRuntime, 'componentize-qjs-bigint.patch');
        writeFileSync(patchPath, readFileSync(patchPath, 'utf8').replace('+patched', '+different'));
        rejects(f, 'Patch hash mismatch');
    });
    it('rejects an unexpected source commit', () => {
        const f = fixture();
        f.executable(join(f.bin, 'git'), 'echo wrong-commit');
        rejects(f, 'Expected componentize-qjs');
    });
    it('rejects an absent Rust target', () => {
        const f = fixture();
        rmSync(join(f.dir, 'target-lib'), { recursive: true });
        rejects(f, 'is not installed');
    });
    it('refuses to overwrite the vendored artifact', () => {
        const f = fixture();
        f.env.RUNTIME_OUTPUT_DIR = f.copiedRuntime;
        rejects(f, 'must not replace the vendored runtime');
    });
    it('replaces output links without following them', () => {
        const f = fixture();
        mkdirSync(f.output);
        const unrelated = join(f.dir, 'unrelated');
        writeFileSync(unrelated, 'preserved');
        symlinkSync(unrelated, join(f.output, 'quickjs-runtime-bigint.wasm'));
        expect(f.run().status).toBe(0);
        expect(readFileSync(unrelated).equals(Buffer.from('preserved'))).toBe(true);
    });
    it('does not publish an invalid candidate over an existing valid one', () => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        f.executable(join(f.bin, 'cargo'), `if [ "$1" = --version ]; then echo '${cargo}'; else exit 1; fi`);
        expect(f.run().status).not.toBe(0);
        expect(f.verifyCandidate().status).toBe(0);
    });
    it.each([
        'sourceCommit',
        'patchSha256',
        'cargoLockSha256',
        'rustVersion',
        'cargoVersion',
        'sdkVersion',
        'clangVersion',
        'target',
        'features',
        'rustFlags',
        'cFlags',
    ])('rejects candidate manifest drift in %s', (key) => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        const path = join(f.output, 'provenance.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        manifest[key] = 'different';
        writeFileSync(path, JSON.stringify(manifest));
        const result = f.verifyCandidate();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`Provenance mismatch: ${key}`);
    });
    it('rejects candidate output hash metadata that does not match the artifact', () => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        const path = join(f.output, 'provenance.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        const actualHash = manifest.outputSha256;
        manifest.outputSha256 = '0'.repeat(64);
        writeFileSync(path, JSON.stringify(manifest));
        const result = f.verifyCandidate();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`Runtime output hash mismatch: expected ${'0'.repeat(64)}, got ${actualHash}`);
    });
    it.each(['buildHost', 'buildHostRelease'])('rejects a candidate manifest missing %s', (key) => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        const path = join(f.output, 'provenance.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        delete manifest[key];
        writeFileSync(path, JSON.stringify(manifest));
        const result = f.verifyCandidate();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
            key === 'buildHost' ? 'Missing runtime candidate build host' : 'Missing runtime candidate host release',
        );
    });
    it('rejects candidate artifact drift', () => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        writeFileSync(join(f.output, 'quickjs-runtime-bigint.wasm'), 'changed');
        const result = f.verifyCandidate();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Runtime output hash mismatch');
    });
});
