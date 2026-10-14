import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { createInternalRegistry } from './utils/external-consumer-registry.mjs';
import {
    assertPackedBuilderDependencies,
    assertPublicToolPackage,
    assertPublicToolPackageContents,
    assertStarterToolDependencies,
    PUBLIC_TOOL_PACKAGE_PATHS,
    parseTarEntries,
} from './utils/tool-packages.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const program = new Command()
    .name('test-external-consumer')
    .description('Check packed tool dependencies in an isolated consumer project.')
    .option('--build-cli-only', 'Check the packed builder CLI without compiling starter projects')
    .parse(process.argv);
const buildCliOnly = program.opts().buildCliOnly ?? false;
const buildPackagePaths = ['tools/pumpkin-api', 'tools/static-hermes-runtime', 'tools/build'];
const packagePaths = buildCliOnly
    ? buildPackagePaths
    : [
          'tools/pumpkin-api',
          'tools/static-hermes-runtime',
          'tools/build',
          'tools/docs',
          'tools/update-check',
          'tools/plugin-kit',
          'tools/create-pumpkin-plugin',
          'tools/codemod',
          'tools/cspell-dict-minecraft',
      ];
const requiredNodeVersion = 'v24.21.0';
const requiredPnpmVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).devEngines
    ?.packageManager?.version;

if (typeof requiredPnpmVersion !== 'string') {
    throw new Error('Root package.json must set devEngines.packageManager.version');
}

if (process.version !== requiredNodeVersion) {
    throw new Error(`External consumer requires Node ${requiredNodeVersion}; received ${process.version}`);
}

const packageManager = packageManagerInvocation();
const pnpmVersion = await capture(packageManager.command, [...packageManager.args, '--version'], repositoryRoot);
if (pnpmVersion.trim() !== requiredPnpmVersion) {
    throw new Error(`External consumer requires pnpm ${requiredPnpmVersion}; received ${pnpmVersion.trim()}`);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-external-consumer-'));
let registry;

try {
    if (isWithin(repositoryRoot, temporaryRoot))
        throw new Error(`Temporary consumer is inside the repository: ${temporaryRoot}`);
    const resolvedTemporaryRoot = fs.realpathSync(temporaryRoot);

    const tarballDirectory = path.join(temporaryRoot, 'tarballs');
    const consumerDirectory = path.join(temporaryRoot, 'consumer');
    const storeDirectory = path.resolve(
        process.env.PUMPKIN_EXTERNAL_CONSUMER_PNPM_STORE_DIR ?? path.join(temporaryRoot, 'pnpm-store'),
    );
    const cacheDirectory = path.resolve(
        process.env.STATIC_HERMES_CACHE_DIR ?? path.join(temporaryRoot, 'cache', 'hermes'),
    );
    const pnpmConfigDirectory = path.join(temporaryRoot, 'pnpm-config');
    fs.mkdirSync(tarballDirectory, { recursive: true });
    fs.mkdirSync(consumerDirectory, { recursive: true });
    fs.mkdirSync(storeDirectory, { recursive: true });
    fs.mkdirSync(cacheDirectory, { recursive: true });

    const packedPackages = new Map();
    for (const packagePath of packagePaths) {
        const packageDirectory = path.join(repositoryRoot, packagePath);
        await run(
            packageManager.command,
            [...packageManager.args, 'pack', '--pack-destination', tarballDirectory],
            packageDirectory,
            process.env,
            ['ignore', 'ignore', 'inherit'],
        );
        const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
        const tarball = fs
            .readdirSync(tarballDirectory)
            .find((filename) => filename.startsWith(tarballName(packageJson.name)));
        if (!tarball) throw new Error(`pnpm pack did not create a tarball for ${packageJson.name}`);
        const tarballPath = path.join(tarballDirectory, tarball);
        const packedPackageJson = JSON.parse(
            execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], { encoding: 'utf8' }),
        );
        if (packedPackageJson.name !== packageJson.name) {
            throw new Error(`Packed package name changed from ${packageJson.name} to ${packedPackageJson.name}`);
        }
        const expectedPublicName = PUBLIC_TOOL_PACKAGE_PATHS[packagePath];
        if (expectedPublicName) {
            assertPublicToolPackage(packedPackageJson, expectedPublicName);
            const entries = parseTarEntries(execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' }));
            assertPublicToolPackageContents(entries, packagePath);
        }
        if (packedPackageJson.name === '@pumpkin-plugins/pumpkin-api') {
            assertPumpkinApiPackageContents(tarballPath);
        }
        packedPackages.set(packedPackageJson.name, {
            packageJson: packedPackageJson,
            filename: tarball,
            bytes: fs.readFileSync(tarballPath),
        });
    }

    const packedToolVersions = Object.fromEntries(
        [...packedPackages].map(([name, { packageJson }]) => [name, packageJson.version]),
    );
    assertPackedBuilderDependencies(packedPackages.get('@pumpkin-plugins/build').packageJson, packedToolVersions);
    if (!buildCliOnly) {
        const creatorPackage = packedPackages.get('create-pumpkin-plugin');
        for (const language of ['typescript', 'javascript']) {
            const templatePackageJson = JSON.parse(
                execFileSync(
                    'tar',
                    [
                        '-xOf',
                        path.join(tarballDirectory, creatorPackage.filename),
                        `package/templates/${language}/package.json`,
                    ],
                    { encoding: 'utf8' },
                ),
            );
            assertStarterToolDependencies(templatePackageJson, packedToolVersions);
        }
    }

    registry = createInternalRegistry(packedPackages);
    await new Promise((resolve, reject) => {
        registry.once('error', reject);
        registry.listen(0, '127.0.0.1', resolve);
    });
    const address = registry.address();
    if (!address || typeof address === 'string') throw new Error('Temporary registry did not bind to a TCP port');
    const registryUrl = `http://127.0.0.1:${address.port}/`;
    const authFilePath = path.join(temporaryRoot, 'auth.ini');
    fs.mkdirSync(path.join(pnpmConfigDirectory, 'pnpm'), { recursive: true });
    fs.writeFileSync(authFilePath, '');
    fs.writeFileSync(
        path.join(pnpmConfigDirectory, 'pnpm', 'config.yaml'),
        `storeDir: ${JSON.stringify(storeDirectory)}\nminimumReleaseAge: 0\nnpmrcAuthFile: ${JSON.stringify(authFilePath)}\n`,
    );
    const environment = {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        XDG_CONFIG_HOME: pnpmConfigDirectory,
        pnpm_config_registry: registryUrl,
        STATIC_HERMES_CACHE_DIR: cacheDirectory,
        CI: 'true',
    };

    const builderConsumer = path.join(temporaryRoot, 'builder-consumer');
    fs.mkdirSync(builderConsumer);
    fs.writeFileSync(
        path.join(builderConsumer, 'package.json'),
        `${JSON.stringify(
            {
                name: 'pumpkin-production-builder-check',
                private: true,
                packageManager: `pnpm@${requiredPnpmVersion}`,
                dependencies: {
                    '@pumpkin-plugins/build': `^${packedPackages.get('@pumpkin-plugins/build').packageJson.version}`,
                },
            },
            null,
            2,
        )}\n`,
    );
    fs.writeFileSync(
        path.join(builderConsumer, 'pnpm-workspace.yaml'),
        `packages:\n  - .\nhoist: false\nregistries:\n  default: ${JSON.stringify(registryUrl)}\n  "@pumpkin-plugins": ${JSON.stringify(registryUrl)}\nallowBuilds:\n  esbuild: true\nminimumReleaseAge: 0\n`,
    );
    await run(packageManager.command, [...packageManager.args, 'install', '--prod'], builderConsumer, environment);
    if (fs.existsSync(path.join(builderConsumer, 'node_modules', 'typescript'))) {
        throw new Error('Production builder check unexpectedly exposes an ambient TypeScript dependency');
    }
    const help = await capture(
        packageManager.command,
        [...packageManager.args, 'exec', 'pumpkin-plugins-build', '--help'],
        builderConsumer,
        { ...environment, NODE_PATH: '' },
    );
    if (!help.includes('--types-only')) {
        throw new Error(`Packed build CLI did not print its supported commands: ${help}`);
    }
    console.log('Packed build CLI passed with production dependencies and no ambient TypeScript');

    if (!buildCliOnly) {
        const dependencies = Object.fromEntries(
            [...packedPackages].map(([name, { packageJson }]) => [name, `^${packageJson.version}`]),
        );
        fs.writeFileSync(
            path.join(consumerDirectory, 'package.json'),
            `${JSON.stringify(
                {
                    name: 'pumpkin-packed-consumer-check',
                    version: '1.0.0',
                    private: true,
                    packageManager: `pnpm@${requiredPnpmVersion}`,
                    dependencies,
                },
                null,
                2,
            )}\n`,
        );
        fs.writeFileSync(
            path.join(consumerDirectory, 'pnpm-workspace.yaml'),
            `packages:\n  - .\n  - "*/"\nregistries:\n  default: ${JSON.stringify(registryUrl)}\n  "@pumpkin-plugins": ${JSON.stringify(registryUrl)}\nallowBuilds:\n  esbuild: true\nminimumReleaseAge: 0\n`,
        );
        const effectiveRegistry = await capture(
            packageManager.command,
            [...packageManager.args, 'config', 'get', 'registry'],
            consumerDirectory,
            environment,
        );
        if (effectiveRegistry.trim() !== registryUrl) {
            throw new Error(`Temporary consumer registry is not active: ${effectiveRegistry.trim()}`);
        }
        await run(packageManager.command, [...packageManager.args, 'install'], consumerDirectory, environment);

        const codemodList = await capture(
            packageManager.command,
            [...packageManager.args, 'exec', 'pumpkin-codemod', 'list'],
            consumerDirectory,
            environment,
        );
        if (!codemodList.includes('migrate-pumpkin-api-ts')) {
            throw new Error(`Packed codemod CLI did not list the Pumpkin API migration: ${codemodList}`);
        }

        for (const name of packedPackages.keys()) {
            const installedPath = path.join(consumerDirectory, 'node_modules', ...name.split('/'));
            const resolvedPath = fs.realpathSync(installedPath);
            if (!isWithin(resolvedTemporaryRoot, resolvedPath)) {
                throw new Error(`${name} resolved outside the temporary consumer: ${resolvedPath}`);
            }
            if (isWithin(repositoryRoot, resolvedPath)) {
                throw new Error(`${name} resolved from the monorepo: ${resolvedPath}`);
            }
        }

        await run(
            packageManager.command,
            [...packageManager.args, 'exec', 'create-pumpkin-plugin', 'packed-bin', '--ts', '--skip-install'],
            consumerDirectory,
            environment,
        );
        assertStarter(path.join(consumerDirectory, 'packed-bin'), 'typescript', pnpmVersion.trim(), packedToolVersions);

        for (const [directory, language] of [
            ['pnpm-create-typescript', 'typescript'],
            ['pnpm-create-javascript', 'javascript'],
        ]) {
            await run(
                packageManager.command,
                [
                    ...packageManager.args,
                    'create',
                    'pumpkin-plugin',
                    directory,
                    language === 'typescript' ? '--ts' : '--js',
                ],
                consumerDirectory,
                environment,
            );
            const starter = path.join(consumerDirectory, directory);
            assertStarter(starter, language, pnpmVersion.trim(), packedToolVersions);
            await run(packageManager.command, [...packageManager.args, 'run', 'typecheck'], starter, environment);
            await run(packageManager.command, [...packageManager.args, 'run', 'build'], starter, environment);

            const output = JSON.parse(fs.readFileSync(path.join(starter, 'package.json'), 'utf8')).pumpkinPlugin.output;
            const outputPath = path.resolve(starter, output);
            if (!fs.existsSync(outputPath) || isWithin(path.join(starter, 'node_modules'), outputPath)) {
                throw new Error(`${language} component output is missing or inside node_modules: ${outputPath}`);
            }
            const component = fs.readFileSync(outputPath);
            if (!isWebAssemblyComponent(component)) {
                throw new Error(`${language} build output is not a WebAssembly component: ${outputPath}`);
            }
            assertExternalCache(cacheDirectory, storeDirectory, starter);
            assertPumpkinWitCacheIgnored(starter, storeDirectory);
        }

        console.log(`Packed consumer and pnpm create flows passed outside the repository: ${temporaryRoot}`);
    }
} finally {
    try {
        if (registry) {
            await new Promise((resolve, reject) => {
                registry.close((error) => {
                    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                    else resolve();
                });
            });
        }
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function tarballName(name) {
    return `${name.replace(/^@/, '').replaceAll('/', '-')}-`;
}

function assertStarter(directory, language, expectedPnpmVersion, versions) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assertStarterToolDependencies(packageJson, versions);
    const sourcePath = path.resolve(directory, packageJson.pumpkinPlugin.entry);
    const expectedExtension = language === 'typescript' ? '.ts' : '.js';
    if (
        !isWithin(directory, sourcePath) ||
        path.extname(sourcePath) !== expectedExtension ||
        !fs.existsSync(sourcePath)
    ) {
        throw new Error(`${language} starter entry is not a project source file: ${packageJson.pumpkinPlugin.entry}`);
    }
    if (!packageJson.dependencies?.['@pumpkin-plugins/pumpkin-api']) {
        throw new Error(`${language} starter does not declare the Pumpkin API dependency`);
    }
    if (!packageJson.dependencies?.['@pumpkin-plugins/build']) {
        throw new Error(`${language} starter does not declare the plugin builder dependency`);
    }
    if (!packageJson.scripts?.typecheck || !packageJson.scripts?.build) {
        throw new Error(`${language} starter does not provide its typecheck and build commands`);
    }
    if (packageJson.packageManager !== `pnpm@${expectedPnpmVersion}`) {
        throw new Error(`${language} starter does not pin the launching pnpm version: ${packageJson.packageManager}`);
    }
}

function assertPumpkinApiPackageContents(tarballPath) {
    const entries = parseTarEntries(execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' }));
    if (!entries.includes('package/wit.lock.json')) {
        throw new Error('Packed Pumpkin API package is missing wit.lock.json');
    }

    const bundledWit = entries.find(
        (entry) => entry === 'package/wit' || entry.startsWith('package/wit/') || entry.endsWith('.wit'),
    );
    if (bundledWit) throw new Error(`Packed Pumpkin API package contains vendored WIT: ${bundledWit}`);

    const generatedOutput = entries.find((entry) => /^package\/(?:\.cache|build|generated)\//.test(entry));
    if (generatedOutput) throw new Error(`Packed Pumpkin API package contains generated output: ${generatedOutput}`);
}

function assertExternalCache(cache, store, starter) {
    if (isWithin(starter, cache) || isWithin(path.join(starter, 'node_modules'), cache)) {
        throw new Error(`Static Hermes cache is inside the starter project: ${cache}`);
    }
    if (isWithin(store, cache) || isWithin(cache, store))
        throw new Error('Static Hermes cache overlaps the pnpm store');
}

function assertPumpkinWitCacheIgnored(starter, store) {
    const cacheRoot = path.join(starter, '.cache');
    const witCache = path.join(cacheRoot, 'pumpkin-api-wit');
    const apiLockPath = path.join(starter, 'node_modules', '@pumpkin-plugins', 'pumpkin-api', 'wit.lock.json');
    const apiLock = JSON.parse(fs.readFileSync(apiLockPath, 'utf8'));
    const matchingDigest = fs.readdirSync(witCache).find((entry) => {
        if (!/^[a-f0-9]{64}$/.test(entry)) return false;
        const pinPath = path.join(witCache, entry, 'pin.json');
        if (!fs.existsSync(pinPath)) return false;
        const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
        return (
            pin.lockDigest === entry &&
            pin.repository === apiLock.repository &&
            pin.branch === apiLock.branch &&
            pin.commit === apiLock.commit
        );
    });
    if (!matchingDigest) throw new Error(`Cache for the API package's pinned WIT source is missing: ${witCache}`);

    const cachedWit = findFilesNamed(path.join(witCache, matchingDigest), 'plugin.wit').find((filename) =>
        /\bworld\s+plugin\s*\{/.test(fs.readFileSync(filename, 'utf8')),
    );
    if (!cachedWit) throw new Error(`Fetched Pumpkin WIT does not contain the plugin world: ${witCache}`);
    if (isWithin(path.join(starter, 'node_modules'), cachedWit) || isWithin(store, cachedWit)) {
        throw new Error(`Pumpkin WIT cache is inside node_modules or the pnpm store: ${cachedWit}`);
    }

    execFileSync('git', ['-C', starter, 'init', '--quiet']);
    execFileSync('git', ['-C', starter, 'check-ignore', '--quiet', path.relative(starter, cachedWit)]);
}

function findFilesNamed(root, filename) {
    const matches = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) matches.push(...findFilesNamed(entryPath, filename));
        else if (entry.isFile() && entry.name === filename) matches.push(entryPath);
    }
    return matches;
}

function isWebAssemblyComponent(bytes) {
    return (
        bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]))
    );
}

function isWithin(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (
        relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
}

function packageManagerInvocation() {
    const packageManagerPath = process.env.npm_execpath;
    if (packageManagerPath && /\.(?:c|m)?js$/i.test(packageManagerPath)) {
        return { command: process.execPath, args: [packageManagerPath] };
    }
    if (process.platform === 'win32') {
        return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm.cmd'] };
    }
    return { command: 'pnpm', args: [] };
}

function capture(command, args, cwd, env = process.env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
        child.once('error', reject);
        child.once('close', (code) =>
            code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}`)),
        );
    });
}

function run(command, args, cwd, env = process.env, stdio = 'inherit') {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio });
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${code ?? signal}`));
        });
    });
}
