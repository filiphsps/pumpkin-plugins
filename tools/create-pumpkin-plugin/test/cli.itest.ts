import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { afterEach, expect, it } from 'vitest';

const cliPath = path.resolve(import.meta.dirname, '../bin/create-pumpkin-plugin.ts');
const temporaryDirectories: string[] = [];

interface GeneratedManifest {
    dependencies: Record<string, string>;
    name: string;
    packageManager?: string;
    pumpkinPlugin: {
        entry: string;
        output: string;
        wasi: unknown[];
    };
    scripts: Record<string, string>;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function runCli(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        cwd: options.cwd,
        encoding: 'utf8',
        env: { ...process.env, ...options.env },
    });
}

it.each([
    ['TypeScript', '--ts', '.ts'],
    ['JavaScript', '--js', '.js'],
] as const)('creates a usable %s starter without installing dependencies', (language, flag, extension) => {
    const cwd = temporaryDirectory(`create-pumpkin-plugin-${extension.slice(1)}-`);
    const projectName = `my-plugin-${extension.slice(1)}`;
    const destination = path.join(cwd, projectName);
    const result = runCli([projectName, flag, '--skip-install'], { cwd });

    expect(result.status).toBe(0);
    const readme = fs.readFileSync(path.join(destination, 'README.md'), 'utf8');
    const setupGuidance =
        language === 'TypeScript'
            ? 'On a fresh project, these commands may need network access.'
            : 'The first `typecheck` fetches the Pumpkin WIT revision pinned by the API package';
    expect(readme).toContain(setupGuidance);
    expect(readme).toContain('https://filiphsps.github.io/pumpkin-plugins/guides/building');
    expect(readme).toContain('https://filiphsps.github.io/pumpkin-plugins/tools/static-hermes-runtime/README');
    expect(fs.existsSync(path.join(destination, 'pnpm-workspace.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(destination, 'node_modules'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, '.gitignore'), 'utf8')).toContain('node_modules/');
    expect(fs.existsSync(path.join(destination, 'gitignore'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'pnpm-workspace.yaml'), 'utf8')).toMatch(
        /allowBuilds:\s*\n\s+esbuild:\s*true/,
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8')) as GeneratedManifest;
    const entryPath = path.resolve(destination, manifest.pumpkinPlugin.entry);
    const outputPath = path.resolve(destination, manifest.pumpkinPlugin.output);
    expect(fs.existsSync(entryPath)).toBe(true);
    const source = fs.readFileSync(entryPath, 'utf8');
    // Stand in for the installed builder so the config can be checked without an install.
    const buildGlobals = path.join(destination, 'node_modules/@pumpkin-plugins/build/globals.d.ts');
    fs.mkdirSync(path.dirname(buildGlobals), { recursive: true });
    fs.writeFileSync(buildGlobals, 'declare const __PLUGIN_VERSION__: string;\n');
    const tsconfigPath = path.join(destination, 'tsconfig.json');
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    expect(configFile.error).toBeUndefined();
    const tsconfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, destination);

    expect(manifest.name).toBe(projectName);
    expect(path.extname(entryPath)).toBe(extension);
    expect(isWithin(destination, entryPath)).toBe(true);
    expect(isWithin(destination, outputPath)).toBe(true);
    expect(path.extname(outputPath)).toBe('.wasm');
    expect(source).toContain(projectName);
    expect(source).not.toContain('__PLUGIN_NAME__');
    // The build injects the package.json version, so the starter must not hard-code one.
    expect(source).not.toMatch(/version:\s*['"]/);
    expect(source).toMatch(/registerPlugin\s*\(/);
    expect(source).toMatch(/export\s+\*\s+from\s+['"]@pumpkin-plugins\/pumpkin-api['"]/);
    expect(manifest.dependencies['@pumpkin-plugins/pumpkin-api']).toBeTruthy();
    expect(manifest.dependencies['@pumpkin-plugins/build']).toBeTruthy();
    expect(manifest.scripts.build).toMatch(/pumpkin-plugins-build/);
    expect(manifest.scripts['build:parse-ts']).toBe('pumpkin-plugins-build --parse-ts');
    expect(manifest.scripts.typecheck).toContain('tsc --noEmit');
    expect(tsconfig.errors).toHaveLength(0);
    expect(tsconfig.fileNames).toContain(entryPath);
    expect(tsconfig.fileNames).toContain(buildGlobals);
    expect(tsconfig.options.allowImportingTsExtensions).toBe(true);

    if (language === 'JavaScript') {
        expect(tsconfig.options.allowJs).toBe(true);
        expect(tsconfig.options.checkJs).toBe(true);
    }
});

it('pins the detected pnpm version in generated projects', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-pnpm-pin-');
    const userAgent = 'pnpm/12.10.1 npm/? node/v24.21.0 darwin arm64';
    const expectedVersion = userAgent.match(/(?:^|\s)pnpm\/([^\s]+)/)?.[1];
    const result = runCli(['my-plugin', '--ts', '--skip-install'], {
        cwd,
        env: { npm_config_user_agent: userAgent },
    });

    expect(result.status).toBe(0);
    expect(expectedVersion).toBeTruthy();
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'my-plugin', 'package.json'), 'utf8')) as {
        packageManager?: string;
    };
    expect(manifest.packageManager).toBe(`pnpm@${expectedVersion}`);
});

it.each([
    ['npm', 'npm/11.0.0 node/v24.21.0 darwin arm64'],
    ['yarn', 'yarn/4.9.2 npm/? node/v24.21.0 darwin arm64'],
    ['bun', 'bun/1.2.0'],
] as const)('writes %s commands and no pnpm workspace file', (manager, userAgent) => {
    const cwd = temporaryDirectory(`create-pumpkin-plugin-${manager}-`);
    const result = runCli(['my-plugin', '--js', '--skip-install'], {
        cwd,
        env: { npm_config_user_agent: userAgent, npm_execpath: '' },
    });

    expect(result.status, result.stderr).toBe(0);
    const destination = path.join(cwd, 'my-plugin');
    const readme = fs.readFileSync(path.join(destination, 'README.md'), 'utf8');
    expect(readme).toContain(`${manager} install`);
    expect(readme).toContain(`${manager} run build`);
    expect(readme).not.toMatch(/\bpnpm\b/);
    expect(fs.existsSync(path.join(destination, 'pnpm-workspace.yaml'))).toBe(false);
});

it('requires a language in non-interactive use and prints the exact choices', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-language-');
    const result = runCli(['my-plugin'], { cwd });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Choose a language with --ts or --js.');
    expect(result.stderr).toContain('TypeScript (--ts)');
    expect(result.stderr).toContain('JavaScript (--js)');
    expect(fs.existsSync(path.join(cwd, 'my-plugin'))).toBe(false);
});

it('rejects conflicting language flags and invalid project names', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-invalid-');
    const conflict = runCli(['my-plugin', '--ts', '--js'], { cwd });
    const invalidName = runCli(['Bad Name', '--ts', '--skip-install'], { cwd });

    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain('--ts and --js cannot be used together');
    expect(invalidName.status).not.toBe(0);
    expect(invalidName.stderr).toContain('project name must use lowercase letters, numbers, and hyphens');
});

it('refuses an existing destination without modifying its files', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-existing-');
    const destination = path.join(cwd, 'my-plugin');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'keep.txt'), 'keep');
    const result = runCli(['my-plugin', '--ts', '--skip-install'], { cwd });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('destination already exists');
    expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.readdirSync(destination)).toEqual(['keep.txt']);
});

it('removes the generated destination when copying a template fails', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-copy-failure-');
    const fixtureRoot = fs.mkdtempSync(path.join(path.dirname(cliPath), '.creator-fixture-'));
    temporaryDirectories.push(fixtureRoot);
    const fixtureBin = path.join(fixtureRoot, 'bin');
    const templateRoot = path.join(fixtureRoot, 'templates', 'typescript');
    fs.mkdirSync(fixtureBin, { recursive: true });
    fs.mkdirSync(templateRoot, { recursive: true });
    fs.copyFileSync(cliPath, path.join(fixtureBin, 'create-pumpkin-plugin.ts'));
    fs.writeFileSync(path.join(templateRoot, 'a-first-file.txt'), 'copied before the failure');
    fs.writeFileSync(path.join(templateRoot, 'tsconfig.json'), '{ invalid json');

    const result = spawnSync(
        process.execPath,
        [path.join(fixtureBin, 'create-pumpkin-plugin.ts'), 'my-plugin', '--ts', '--skip-install'],
        {
            cwd,
            encoding: 'utf8',
            env: { ...process.env },
        },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected property name');
    expect(fs.existsSync(path.join(cwd, 'my-plugin'))).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual([]);
});

it('prints the detected package manager install and build commands when skipping install', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-skip-install-');
    const result = runCli(['my-plugin', '--ts', '--skip-install'], {
        cwd,
        env: { npm_config_user_agent: 'pnpm/12.10.1 npm/? node/v24.21.0 darwin arm64' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pnpm install');
    expect(result.stdout).toContain('pnpm run build');
});

it('does not invoke the package manager when installation is skipped', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-no-install-');
    const fakeBin = path.join(cwd, 'bin');
    const marker = path.join(cwd, 'package-manager-was-run');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
        path.join(fakeBin, 'pnpm'),
        '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CREATE_PUMPKIN_MARKER, "called");\n',
    );
    fs.chmodSync(path.join(fakeBin, 'pnpm'), 0o755);

    const result = runCli(['my-plugin', '--ts', '--skip-install'], {
        cwd,
        env: {
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
            CREATE_PUMPKIN_MARKER: marker,
            npm_execpath: '',
            npm_config_user_agent: 'pnpm/12.10.1 npm/? node/v24.21.0',
        },
    });

    expect(result.status).toBe(0);
    const destination = path.join(cwd, 'my-plugin');
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8')) as GeneratedManifest;
    expect(fs.existsSync(path.resolve(destination, manifest.pumpkinPlugin.entry))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
});

it('keeps generated directory paths out of copy-paste shell commands', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-shell-path-');
    const parent = path.join(cwd, 'parent$(touch creator-path-injection)');
    fs.mkdirSync(parent);
    const destination = path.join(parent, 'my-plugin');
    const result = runCli([destination, '--ts', '--skip-install'], {
        cwd,
        env: { npm_config_user_agent: 'pnpm/12.10.1 npm/? node/v24.21.0 darwin arm64' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Project directory: ${destination}`);
    expect(
        result.stdout
            .split('\n')
            .filter((line) => line.includes(destination))
            .every((line) => line.startsWith('Project directory: ')),
    ).toBe(true);
    expect(result.stdout).toContain('From the project directory, run: pnpm install');
    expect(fs.existsSync(path.join(cwd, 'creator-path-injection'))).toBe(false);
});

it('forwards dependency installation to the package manager that launched it', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-install-');
    const fakeBin = path.join(cwd, 'bin');
    const capture = path.join(cwd, 'install.json');
    fs.mkdirSync(fakeBin);
    const fakePnpm = path.join(fakeBin, 'pnpm');
    fs.writeFileSync(
        fakePnpm,
        '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CREATE_PUMPKIN_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n',
    );
    fs.chmodSync(fakePnpm, 0o755);
    const result = runCli(['my-plugin', '--ts'], {
        cwd,
        env: {
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
            CREATE_PUMPKIN_CAPTURE: capture,
            npm_execpath: '',
            npm_config_user_agent: 'pnpm/12.10.1 npm/? node/v24.21.0 darwin arm64',
        },
    });

    expect(result.status).toBe(0);
    const invocation = JSON.parse(fs.readFileSync(capture, 'utf8')) as { args: string[]; cwd: string };
    expect(invocation.args).toContain('install');
    expect(invocation.cwd).toBe(fs.realpathSync(path.join(cwd, 'my-plugin')));
});

it('invokes pnpm through cmd.exe when running on Windows without a JavaScript launcher', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-windows-pnpm-');
    const fakeBin = path.join(cwd, 'bin');
    const capture = path.join(cwd, 'install.txt');
    const platformPreload = path.join(cwd, 'windows-platform.mjs');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
        platformPreload,
        `const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
`,
    );

    const environment: NodeJS.ProcessEnv = {
        NODE_OPTIONS: `--import=${pathToFileURL(platformPreload).href}`,
        CREATE_PUMPKIN_CAPTURE: capture,
        npm_config_user_agent: 'pnpm/12.10.1 npm/? node/v24.21.0 win32 x64',
        npm_execpath: '',
        NPM_CONFIG_EXECPATH: '',
    };

    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(fakeBin, 'pnpm.cmd'), '@echo off\r\n> "%CREATE_PUMPKIN_CAPTURE%" echo %*\r\n');
        environment.ComSpec = process.env.ComSpec ?? 'cmd.exe';
        environment.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`;
    } else {
        const commandShell = path.join(cwd, 'cmd.cjs');
        fs.writeFileSync(
            commandShell,
            '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CREATE_PUMPKIN_CAPTURE, JSON.stringify(process.argv.slice(2)));\n',
        );
        fs.chmodSync(commandShell, 0o755);
        environment.ComSpec = commandShell;
        environment.PATH = `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    }

    const result = runCli(['my-plugin', '--ts'], { cwd, env: environment });

    expect(result.status, result.stderr).toBe(0);
    const invocation = fs.readFileSync(capture, 'utf8').trim();
    if (process.platform === 'win32') {
        expect(invocation).toBe('install');
    } else {
        expect(JSON.parse(invocation)).toEqual(['/d', '/s', '/c', 'pnpm.cmd', 'install']);
    }
});

it('reuses the exact JavaScript package-manager entrypoint when the launcher provides it', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-execpath-');
    const capture = path.join(cwd, 'install.json');
    const packageManagerEntry = path.join(cwd, 'pnpm.cjs');
    fs.writeFileSync(
        packageManagerEntry,
        'require("node:fs").writeFileSync(process.env.CREATE_PUMPKIN_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n',
    );
    const result = runCli(['my-plugin', '--ts'], {
        cwd,
        env: {
            CREATE_PUMPKIN_CAPTURE: capture,
            npm_execpath: packageManagerEntry,
            npm_config_user_agent: 'pnpm/12.10.1 npm/? node/v24.21.0 darwin arm64',
        },
    });

    expect(result.status).toBe(0);
    const invocation = JSON.parse(fs.readFileSync(capture, 'utf8')) as { args: string[]; cwd: string };
    expect(invocation.args).toContain('install');
    expect(invocation.cwd).toBe(fs.realpathSync(path.join(cwd, 'my-plugin')));
});

it('shows Commander help', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-help-');
    const result = runCli(['--help'], { cwd });

    expect(result.status).toBe(0);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(result.stdout).toContain('create-pumpkin-plugin');
    expect(result.stdout).toContain('--skip-install');
    expect(result.stdout).toContain('--ts');
    expect(result.stdout).toContain('--js');
});

it('rejects a missing directory without creating a project', () => {
    const cwd = temporaryDirectory('create-pumpkin-plugin-missing-directory-');
    const result = runCli([], { cwd });

    expect(result.status).not.toBe(0);
    expect(result.stderr.match(/missing required argument/g)).toHaveLength(1);
    expect(fs.readdirSync(cwd)).toEqual([]);
});

function isWithin(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (
        relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
}
