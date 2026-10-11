import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { join, resolve } from 'node:path';

const runtimeDir = import.meta.dirname;
const expected = JSON.parse(readFileSync(join(runtimeDir, 'provenance.json'), 'utf8'));
const patchPath = join(runtimeDir, 'componentize-qjs-bigint.patch');
const artifactName = 'quickjs-runtime-bigint.wasm';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args) =>
    execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const requireMatch = (actual, wanted, message) => {
    if (actual !== wanted) throw new Error(message);
};

function checkPatch() {
    requireMatch(hash(patchPath), expected.patchSha256, 'Patch hash mismatch');
}

function checkInputs(sourceDir, sdkDir) {
    checkPatch();
    const git = (...args) => run('git', ['-C', sourceDir, ...args]);
    requireMatch(
        git('rev-parse', 'HEAD'),
        expected.sourceCommit,
        `Expected componentize-qjs at ${expected.sourceCommit}`
    );
    requireMatch(hash(join(sourceDir, 'Cargo.lock')), expected.cargoLockSha256, 'Cargo.lock hash mismatch');
    // Include ignored files: .cargo/config and local source overrides are also build inputs.
    if (
        git('ls-files', '--others', '--exclude-standard') ||
        git('ls-files', '--others', '--ignored', '--exclude-standard')
    ) {
        throw new Error('Untracked source inputs');
    }
    const diff = git(
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        'HEAD'
    );
    // Git writes a space on empty context lines; the checked-in patch omits it.
    const normalize = (text) => text.replace(/^ $/gm, '').trim();
    if (diff && normalize(diff) !== normalize(readFileSync(patchPath, 'utf8'))) {
        throw new Error('Source changes differ from the declared patch');
    }
    requireMatch(run('rustc', ['--version']), expected.rustVersion, 'Rust version mismatch');
    requireMatch(run('cargo', ['--version']), expected.cargoVersion, 'Cargo version mismatch');
    requireMatch(
        readFileSync(join(sdkDir, 'VERSION'), 'utf8').trim(),
        expected.sdkVersion,
        'wasi-sdk version mismatch'
    );
    requireMatch(
        run(join(sdkDir, 'bin/clang'), ['--version']).split('\n')[0],
        expected.clangVersion,
        'Clang version mismatch'
    );
    const targetLib = run('rustc', ['--print', 'target-libdir', '--target', expected.target]);
    if (!existsSync(targetLib)) throw new Error(`Rust target ${expected.target} is not installed`);
}

function checkArtifact(outputDir, wanted = expected.outputSha256) {
    const actual = hash(join(outputDir, artifactName));
    requireMatch(actual, wanted, `Runtime output hash mismatch: expected ${wanted}, got ${actual}`);
}

function verifyShipped(outputDir) {
    const manifest = JSON.parse(readFileSync(join(outputDir, 'provenance.json'), 'utf8'));
    if ('buildHost' in manifest || 'buildHostRelease' in manifest) {
        throw new Error('Candidate provenance cannot verify as shipped runtime');
    }
    for (const [key, value] of Object.entries(expected)) {
        requireMatch(manifest[key], value, `Provenance mismatch: ${key}`);
    }
    checkArtifact(outputDir);
}

function verifyCandidate(outputDir) {
    const manifest = JSON.parse(readFileSync(join(outputDir, 'provenance.json'), 'utf8'));
    for (const [key, value] of Object.entries(expected)) {
        if (key !== 'outputSha256') requireMatch(manifest[key], value, `Provenance mismatch: ${key}`);
    }
    if (typeof manifest.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.outputSha256)) {
        throw new Error('Invalid runtime candidate output SHA-256');
    }
    if (typeof manifest.buildHost !== 'string' || !manifest.buildHost.trim()) {
        throw new Error('Missing runtime candidate build host');
    }
    if (typeof manifest.buildHostRelease !== 'string' || !manifest.buildHostRelease.trim()) {
        throw new Error('Missing runtime candidate host release');
    }
    checkArtifact(outputDir, manifest.outputSha256);
}

try {
    const [command, first, second, third] = process.argv.slice(2);
    if (command === 'value' && ['target', 'features', 'rustFlags', 'cFlags'].includes(first) && !second) {
        process.stdout.write(`${expected[first]}\n`);
    } else if (command === 'inputs' && first && second && !third) {
        checkInputs(resolve(first), resolve(second));
    } else if (command === 'record' && first && second && third) {
        checkInputs(resolve(first), resolve(second));
        const outputSha256 = hash(join(resolve(third), artifactName));
        const buildHost = `${process.platform}-${process.arch}`;
        const buildHostRelease = osRelease();
        writeFileSync(
            join(third, 'provenance.json'),
            `${JSON.stringify({ ...expected, outputSha256, buildHost, buildHostRelease }, null, 4)}\n`
        );
        process.stdout.write(`Runtime candidate output SHA-256: ${outputSha256} (${buildHost}, ${buildHostRelease})\n`);
    } else if (command === 'verify' && first && !second) {
        checkPatch();
        verifyShipped(resolve(first));
    } else if (command === 'verify-candidate' && first && !second) {
        checkPatch();
        verifyCandidate(resolve(first));
    } else {
        throw new Error(
            'Usage: provenance.mjs inputs SOURCE SDK | record SOURCE SDK OUTPUT | verify OUTPUT | verify-candidate OUTPUT'
        );
    }
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
