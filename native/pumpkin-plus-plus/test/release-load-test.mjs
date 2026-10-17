#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPassingVitestSummary } from '../../../scripts/utils/native-load-test.mjs';
import { nativeTargets } from '../../../scripts/utils/native-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nativeDirectory = join(root, 'native/pumpkin-plus-plus');
const nativeSpec = JSON.parse(readFileSync(join(nativeDirectory, 'release.json'), 'utf8'));
const args = parseArguments(process.argv.slice(2));

try {
    await verifyNativeArtifact(args);
} catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
}

async function verifyNativeArtifact(options) {
    const platform = nativeTargets.find((entry) => entry.target === options.target);
    if (!platform) throw new Error(`Unsupported native target: ${options.target}`);
    if (!runsNatively(options.target)) throw new Error(`Target ${options.target} cannot run on this host`);
    for (const file of [options.library, options.host]) {
        if (!existsSync(file)) throw new Error(`Required test file does not exist: ${file}`);
    }
    if (!isSha256(nativeSpec.host.assets[options.target]?.sha256)) {
        throw new Error(`No pinned host checksum exists for ${options.target}`);
    }
    if (!process.env.RUSTC) throw new Error('RUSTC must point to the pinned native compiler');

    const outputDirectory = dirname(options.library);
    const evidenceDirectory = join(dirname(options.evidence), 'evidence', options.target);
    const cargoTargetDirectory = join(outputDirectory, 'cargo-target');
    mkdirSync(evidenceDirectory, { recursive: true });
    mkdirSync(dirname(options.evidence), { recursive: true });

    const compilerDirectory = dirname(realpathSync(process.env.RUSTC));
    const cargo = join(compilerDirectory, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
    if (!existsSync(cargo)) throw new Error(`Pinned cargo was not found beside RUSTC: ${cargo}`);

    const observerName = `${platform.prefix}lifecycle_observer.${platform.extension}`;
    const observer = join(cargoTargetDirectory, options.target, 'release/examples', observerName);
    const cargoArgs = [
        'build',
        '--manifest-path',
        join(nativeDirectory, 'Cargo.toml'),
        '--locked',
        '--release',
        '--example',
        'lifecycle_observer',
        '--target',
        options.target,
        '--target-dir',
        cargoTargetDirectory,
        '--no-default-features',
    ];
    if (nativeSpec.features.length > 0) cargoArgs.push('--features', nativeSpec.features.join(','));

    const build = spawnSync(cargo, cargoArgs, {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
    });
    writeFileSync(join(evidenceDirectory, 'observer-build.log'), `${build.stdout ?? ''}\n${build.stderr ?? ''}`);
    if (build.error || build.status !== 0) {
        throw new Error(`Failed to build lifecycle observer: ${build.error?.message ?? build.stderr}`);
    }
    if (!existsSync(observer)) throw new Error(`Lifecycle observer was not produced: ${observer}`);

    const packageDirectory = join(root, 'packages/distant-horizons-support-pumpkin');
    const vitestDirectory = realpathSync(join(packageDirectory, 'node_modules/vitest'));
    const vitest = join(vitestDirectory, 'vitest.mjs');
    if (!existsSync(vitest)) throw new Error(`Vitest CLI was not found: ${vitest}`);
    const testArguments = [vitest, 'run', '--root', root, '--config', join(nativeDirectory, 'vitest.config.ts')];
    const engineProofs = [];
    for (const { engine, skipReason } of platform.loadTestEngines) {
        const engineEvidenceDirectory = join(evidenceDirectory, engine);
        mkdirSync(engineEvidenceDirectory, { recursive: true });
        if (skipReason) {
            const engineProof = {
                status: 'skipped',
                engine,
                reason: skipReason,
                testFiles: 0,
                tests: 0,
                vitestLog: null,
                pumpkinLogDirectory: null,
            };
            writeFileSync(join(engineEvidenceDirectory, 'load-test.json'), `${JSON.stringify(engineProof, null, 4)}\n`);
            engineProofs.push(engineProof);
            continue;
        }
        const logDirectory = join(engineEvidenceDirectory, 'pumpkin-logs');
        mkdirSync(logDirectory, { recursive: true });
        const testEnvironment = {
            ...process.env,
            CARGO_TARGET_DIR: cargoTargetDirectory,
            PUMPKIN_BIN: options.host,
            PUMPKIN_KEEP_DIR: '1',
            PUMPKIN_PLUS_PLUS_ARTIFACT: options.library,
            PUMPKIN_PLUS_PLUS_ENGINE: engine,
            PUMPKIN_PLUS_PLUS_INSPECTOR: observer,
            PUMPKIN_TEST_LOG_DIR: logDirectory,
        };
        const test = spawnSync(process.execPath, testArguments, {
            cwd: root,
            encoding: 'utf8',
            env: testEnvironment,
            maxBuffer: 32 * 1024 * 1024,
            timeout: 30 * 60 * 1000,
        });
        const testOutput = `${test.stdout ?? ''}\n${test.stderr ?? ''}`;
        const passed = !test.error && test.status === 0 && hasPassingVitestSummary(testOutput);
        const engineProof = {
            status: passed ? 'passed' : 'failed',
            engine,
            testFiles: 2,
            tests: 6,
            vitestLog: join(engineEvidenceDirectory, 'vitest.log'),
            pumpkinLogDirectory: logDirectory,
            ...(test.error ? { error: test.error.message } : {}),
            ...(test.status === null ? { signal: test.signal } : { exitCode: test.status }),
        };
        writeFileSync(engineProof.vitestLog, testOutput);
        writeFileSync(join(engineEvidenceDirectory, 'load-test.json'), `${JSON.stringify(engineProof, null, 4)}\n`);
        engineProofs.push(engineProof);
    }
    const passed = platform.loadTestEngines.every((expectation, index) => {
        const proof = engineProofs[index];
        return expectation.skipReason
            ? proof.status === 'skipped' && proof.reason === expectation.skipReason
            : proof.status === 'passed';
    });
    const proof = {
        status: passed ? 'passed' : 'failed',
        target: options.target,
        protocolVersion: nativeSpec.protocolVersion,
        artifactSha256: sha256(options.library),
        hostBinarySha256: sha256(options.host),
        rustc: process.env.RUSTC,
        engines: engineProofs,
        observerSha256: sha256(observer),
        evidenceDirectory,
    };
    writeFileSync(options.evidence, `${JSON.stringify(proof, null, 4)}\n`);
    console.log(JSON.stringify(proof, null, 4));
    if (!passed) {
        const failedEngines = engineProofs.filter((engineProof, index) => {
            const expectation = platform.loadTestEngines[index];
            return expectation.skipReason
                ? engineProof.status !== 'skipped' || engineProof.reason !== expectation.skipReason
                : engineProof.status !== 'passed';
        });
        throw new Error(
            `Native real-server verification failed for ${failedEngines.map(({ engine }) => engine).join(', ')}; see ${evidenceDirectory}`,
        );
    }
}

function parseArguments(values) {
    if (values.length !== 8) throw new Error('Expected --library, --host, --target and --evidence');
    const result = {};
    for (let index = 0; index < values.length; index += 2) {
        const key = values[index].slice(2);
        if (!['library', 'host', 'target', 'evidence'].includes(key) || values[index][0] !== '-') {
            throw new Error(`Unknown load-test argument: ${values[index]}`);
        }
        if (result[key]) throw new Error(`Duplicate load-test argument: --${key}`);
        result[key] = key === 'target' ? values[index + 1] : resolve(values[index + 1]);
    }
    for (const key of ['library', 'host', 'target', 'evidence']) {
        if (!result[key]) throw new Error(`Missing load-test argument: --${key}`);
    }
    return result;
}

function runsNatively(target) {
    const os = target.includes('linux-') ? 'linux' : target.includes('apple-darwin') ? 'darwin' : 'win32';
    const architecture = target.startsWith('aarch64-') ? 'arm64' : 'x64';
    return process.platform === os && process.arch === architecture;
}

function isSha256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}
