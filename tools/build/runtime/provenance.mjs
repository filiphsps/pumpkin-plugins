import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function checkArtifact(outputDir) {
    requireMatch(hash(join(outputDir, artifactName)), expected.outputSha256, 'Runtime output hash mismatch');
}

try {
    const [command, first, second, third] = process.argv.slice(2);
    if (command === 'value' && ['target', 'features', 'rustFlags', 'cFlags'].includes(first) && !second) {
        process.stdout.write(`${expected[first]}\n`);
    } else if (command === 'inputs' && first && second && !third) {
        checkInputs(resolve(first), resolve(second));
    } else if (command === 'record' && first && second && third) {
        checkInputs(resolve(first), resolve(second));
        checkArtifact(resolve(third));
        writeFileSync(
            join(third, 'provenance.json'),
            `${JSON.stringify({ ...expected, buildHost: `${process.platform}-${process.arch}` }, null, 4)}\n`
        );
    } else if (command === 'verify' && first && !second) {
        checkPatch();
        const manifest = JSON.parse(readFileSync(join(first, 'provenance.json'), 'utf8'));
        for (const [key, value] of Object.entries(expected)) {
            requireMatch(manifest[key], value, `Provenance mismatch: ${key}`);
        }
        checkArtifact(resolve(first));
    } else {
        throw new Error('Usage: provenance.mjs inputs SOURCE SDK | record SOURCE SDK OUTPUT | verify OUTPUT');
    }
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
