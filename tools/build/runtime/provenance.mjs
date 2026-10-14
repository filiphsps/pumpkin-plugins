import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { join, resolve } from 'node:path';
import { Argument, Command } from 'commander';

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
        `Expected componentize-qjs at ${expected.sourceCommit}`,
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
        'HEAD',
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
        'wasi-sdk version mismatch',
    );
    requireMatch(
        run(join(sdkDir, 'bin/clang'), ['--version']).split('\n')[0],
        expected.clangVersion,
        'Clang version mismatch',
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
    const program = new Command().name('provenance.mjs').description('Inspect and record QuickJS runtime provenance.');
    program
        .command('value')
        .description('Print one pinned build value.')
        .addArgument(new Argument('<name>', 'Pinned value name').choices(['target', 'features', 'rustFlags', 'cFlags']))
        .action((name) => process.stdout.write(`${expected[name]}\n`));
    program
        .command('inputs')
        .description('Verify the pinned source tree and WASI SDK inputs.')
        .argument('<source>', 'QuickJS source directory')
        .argument('<sdk>', 'WASI SDK directory')
        .action((source, sdk) => checkInputs(resolve(source), resolve(sdk)));
    program
        .command('record')
        .description('Verify inputs and record the generated runtime candidate hash.')
        .argument('<source>', 'QuickJS source directory')
        .argument('<sdk>', 'WASI SDK directory')
        .argument('<output>', 'Runtime output directory')
        .action((source, sdk, output) => {
            checkInputs(resolve(source), resolve(sdk));
            const outputSha256 = hash(join(resolve(output), artifactName));
            const buildHost = `${process.platform}-${process.arch}`;
            const buildHostRelease = osRelease();
            writeFileSync(
                join(output, 'provenance.json'),
                `${JSON.stringify({ ...expected, outputSha256, buildHost, buildHostRelease }, null, 4)}\n`,
            );
            process.stdout.write(
                `Runtime candidate output SHA-256: ${outputSha256} (${buildHost}, ${buildHostRelease})\n`,
            );
        });
    program
        .command('verify')
        .description('Verify a shipped runtime directory against the pinned provenance.')
        .argument('<output>', 'Shipped runtime directory')
        .action((output) => {
            checkPatch();
            verifyShipped(resolve(output));
        });
    program
        .command('verify-candidate')
        .description('Verify a build candidate directory and its recorded host hash.')
        .argument('<output>', 'Runtime candidate directory')
        .action((output) => {
            checkPatch();
            verifyCandidate(resolve(output));
        });
    await program.parseAsync(process.argv);
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
}
