#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from '@commander-js/extra-typings';

/** Starter language written into a generated plugin project. */
type Language = 'typescript' | 'javascript';

/** Supported package managers that can launch the creator and install dependencies. */
type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** Command-line options used while generating a plugin project. */
interface CreatorOptions {
    /** Generate the TypeScript starter. */
    ts?: boolean;
    /** Generate the JavaScript starter. */
    js?: boolean;
    /** Create files without invoking the detected package manager. */
    skipInstall?: boolean;
}

/** Filesystem entries created while publishing a generated project. */
interface CreatedEntry {
    /** Path created by this invocation. */
    path: string;
    /** Filesystem identity used to avoid removing an entry that replaced ours. */
    device: number;
    inode: number;
    /** Entry type, which determines the safe rollback operation. */
    kind: 'file' | 'directory';
}

/** Select a requested language or prompt on an interactive terminal.
 *
 * @param options - Language flags supplied on the command line.
 * @param interactive - Whether standard input is connected to a terminal.
 * @param prompt - Language prompt used when no flag is supplied interactively.
 * @returns The selected starter language.
 * @throws {Error} If both flags are set or a non-interactive caller omits both flags.
 */
export async function chooseLanguage(
    options: Pick<CreatorOptions, 'ts' | 'js'>,
    interactive: boolean,
    prompt: () => Promise<Language> = promptForLanguage
): Promise<Language> {
    if (options.ts && options.js) throw new Error('--ts and --js cannot be used together');
    if (options.ts) return 'typescript';
    if (options.js) return 'javascript';
    if (!interactive) {
        throw new Error('Choose a language with --ts or --js.\nChoices: TypeScript (--ts) or JavaScript (--js).');
    }
    return prompt();
}

/** Detect the package manager that launched this command.
 *
 * @param environment - Environment variables supplied by the package-manager launcher.
 * @returns The detected package manager, or `undefined` when the launcher is unknown.
 */
export function detectPackageManager(environment: NodeJS.ProcessEnv = process.env): PackageManager | undefined {
    const userAgent = environment.npm_config_user_agent ?? environment.NPM_CONFIG_USER_AGENT ?? '';
    const match = userAgent.match(/(?:^|\s)(pnpm|npm|yarn|bun)\//i);
    if (match?.[1]) return normalizePackageManager(match[1]);

    const executable = environment.npm_execpath ?? '';
    const executableMatch = executable.match(/(?:^|[\\/])(pnpm|npm|yarn|bun)(?:\.[^\\/]*)?$/i);
    return executableMatch?.[1] ? normalizePackageManager(executableMatch[1]) : undefined;
}

/** Normalize a package-manager name captured from launcher metadata.
 *
 * @param value - Package-manager name captured from the environment.
 * @returns A supported lower-case package-manager identifier.
 */
function normalizePackageManager(value: string): PackageManager {
    return value.toLowerCase() as PackageManager;
}

/** Reuse the launching package manager's JavaScript entry point when available.
 *
 * @param packageManager - Detected package manager to invoke.
 * @param environment - Launcher environment that may contain its executable path.
 * @returns The executable and leading arguments used to start the package manager.
 */
function packageManagerInvocation(
    packageManager: PackageManager,
    environment: NodeJS.ProcessEnv = process.env
): { command: string; args: string[] } {
    const executable = environment.npm_execpath ?? environment.NPM_CONFIG_EXECPATH;
    const launchers: Record<PackageManager, RegExp> = {
        pnpm: /^pnpm(?:-cli)?\.(?:cjs|mjs|js)$/,
        npm: /^npm(?:-cli)?\.(?:cjs|mjs|js)$/,
        yarn: /^yarn(?:-cli)?\.(?:cjs|mjs|js)$/,
        bun: /^bun(?:-cli)?\.(?:cjs|mjs|js)$/
    };
    const scriptName = executable ? path.basename(executable).toLowerCase() : '';
    if (executable && launchers[packageManager].test(scriptName)) {
        return { command: process.execPath, args: [executable] };
    }
    if (process.platform === 'win32') {
        return { command: environment.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `${packageManager}.cmd`] };
    }
    return { command: packageManager, args: [] };
}

/** Create the Commander program that parses creator arguments and options. */
function createProgram() {
    return new Command()
        .name('create-pumpkin-plugin')
        .description('Create a minimal standalone Pumpkin plugin project')
        .argument('<directory>', 'project directory to create')
        .option('--ts', 'create the TypeScript starter')
        .option('--js', 'create the JavaScript starter')
        .option('--skip-install', 'write the project without installing dependencies')
        .showHelpAfterError()
        .exitOverride()
        .action(async (directory, options) => {
            await createProject(directory, options);
        });
}

/** Validate inputs, copy the selected starter, and optionally install its dependencies.
 *
 * @param directory - Requested output path, relative to the current working directory when not absolute.
 * @param options - Language and installation flags parsed from the command line.
 * @throws {Error} If the project name or destination is invalid or installation fails.
 */
async function createProject(directory: string, options: CreatorOptions): Promise<void> {
    if (options.ts && options.js) throw new Error('--ts and --js cannot be used together');
    const destination = path.resolve(process.cwd(), directory);
    const projectName = path.basename(destination);
    validateProjectName(projectName);
    rejectExistingDestination(destination);

    const language = await chooseLanguage(options, stdin.isTTY === true);
    const packageManager = detectPackageManager();
    const templateName = language === 'typescript' ? 'typescript' : 'javascript';
    const templateRoot = path.resolve(import.meta.dirname, '../templates', templateName);
    createProjectFiles(destination, (stagingDirectory) => {
        copyTemplate(templateRoot, stagingDirectory, projectName);
        pinPnpmVersion(stagingDirectory, packageManager, process.env);
    });

    console.log(`Created ${projectName} (${language}).`);
    if (options.skipInstall || packageManager === undefined) {
        printNextSteps(packageManager, destination);
        return;
    }

    console.log(`Installing dependencies with ${packageManager}...`);
    const invocation = packageManagerInvocation(packageManager);
    const installation = spawnSync(invocation.command, [...invocation.args, 'install'], {
        cwd: destination,
        stdio: 'inherit'
    });
    if (installation.error) {
        throw new Error(
            `could not start ${packageManager} install: ${installation.error.message}; project kept at ${destination}`
        );
    }
    if (installation.status !== 0) {
        throw new Error(
            `${packageManager} install exited with status ${installation.status ?? installation.signal}; project kept at ${destination}`
        );
    }
    console.log(`Project directory: ${destination}`);
    console.log(`Next: from the project directory, run ${packageManager} run build.`);
}

/** Generate a project in a sibling staging directory and publish it after generation succeeds.
 *
 * @param destination - Final absolute path where the project should be published.
 * @param generate - Copies and finalizes project files inside the staging directory.
 * @throws {Error} If generation fails or another entry claims the destination before publication.
 */
function createProjectFiles(destination: string, generate: (stagingDirectory: string) => void): void {
    const parentDirectory = path.dirname(destination);
    fs.mkdirSync(parentDirectory, { recursive: true });
    const stagingDirectory = fs.mkdtempSync(path.join(parentDirectory, `.${path.basename(destination)}-`));

    try {
        generate(stagingDirectory);
        publishStagedProject(stagingDirectory, destination);
    } catch (error) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        throw error;
    }
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
}

/** Claim the destination atomically and copy the complete staged project into it.
 *
 * @param stagingDirectory - Complete generated project tree in a sibling directory.
 * @param destination - Final absolute path that must not already exist.
 * @throws {Error} If another process claims the destination or publishing its contents fails.
 */
function publishStagedProject(stagingDirectory: string, destination: string): void {
    try {
        fs.mkdirSync(destination);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            throw new Error(`destination already exists: ${destination}`, { cause: error });
        }
        throw error;
    }

    const createdEntries: CreatedEntry[] = [];
    createdEntries.push(createdDirectory(destination));
    try {
        copyStagedProject(stagingDirectory, destination, createdEntries);
    } catch (error) {
        try {
            removeCreatedEntries(createdEntries);
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `project publication failed and its owned files could not be fully removed: ${destination}`
            );
        }
        throw error;
    }
}

/** Copy staged files without replacing entries another process created.
 *
 * @param source - Staged directory to copy.
 * @param destination - Directory receiving the staged entries.
 * @param createdEntries - Entries created during publication, used for rollback.
 * @throws {Error} If a destination entry already exists or cannot be copied.
 */
function copyStagedProject(source: string, destination: string, createdEntries: CreatedEntry[]): void {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(destinationPath);
            createdEntries.push(createdDirectory(destinationPath));
            copyStagedProject(sourcePath, destinationPath, createdEntries);
        } else if (entry.isFile()) {
            copyStagedFile(sourcePath, destinationPath, createdEntries);
        } else {
            throw new Error(`unsupported staged entry: ${sourcePath}`);
        }
    }
}

/** Create an exclusive file from staged content and remember its filesystem identity.
 *
 * @param source - Staged source file.
 * @param destination - File path to create without replacing an existing entry.
 * @param createdEntries - Entries created during publication, used for rollback.
 */
function copyStagedFile(source: string, destination: string, createdEntries: CreatedEntry[]): void {
    const contents = fs.readFileSync(source);
    const descriptor = fs.openSync(destination, 'wx');
    try {
        createdEntries.push(createdEntry(destination, fs.fstatSync(descriptor), 'file'));
        fs.writeFileSync(descriptor, contents);
    } finally {
        fs.closeSync(descriptor);
    }
}

/** Capture the identity of a newly created directory. */
function createdDirectory(destination: string): CreatedEntry {
    return createdEntry(destination, fs.lstatSync(destination), 'directory');
}

/** Build rollback metadata from an open file or a freshly created directory. */
function createdEntry(entryPath: string, stats: fs.Stats, kind: CreatedEntry['kind']): CreatedEntry {
    return { path: entryPath, device: stats.dev, inode: stats.ino, kind };
}

/** Remove only entries that still have the identity recorded during publication. */
function removeCreatedEntries(createdEntries: CreatedEntry[]): void {
    for (const created of createdEntries.slice().reverse()) {
        let current: fs.Stats;
        try {
            current = fs.lstatSync(created.path);
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
            throw error;
        }
        if (current.dev !== created.device || current.ino !== created.inode) continue;

        try {
            if (created.kind === 'file' && current.isFile()) fs.unlinkSync(created.path);
            else if (created.kind === 'directory' && current.isDirectory()) fs.rmdirSync(created.path);
        } catch (error) {
            if (
                error instanceof Error &&
                'code' in error &&
                (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST')
            ) {
                continue;
            }
            throw error;
        }
    }
}

/** Record the launching pnpm version in the generated package manifest when known.
 *
 * @param destination - Generated project directory containing `package.json`.
 * @param packageManager - Detected package manager.
 * @param environment - Launcher environment containing pnpm's version when available.
 */
function pinPnpmVersion(
    destination: string,
    packageManager: PackageManager | undefined,
    environment: NodeJS.ProcessEnv
): void {
    if (packageManager !== 'pnpm') return;
    const userAgent = environment.npm_config_user_agent ?? environment.NPM_CONFIG_USER_AGENT ?? '';
    const version = userAgent.match(/(?:^|\s)pnpm\/([^\s]+)/i)?.[1];
    if (!version) return;

    const manifestPath = path.join(destination, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.packageManager = `pnpm@${version}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Ensure the destination basename is a valid npm package name.
 *
 * @param projectName - Destination basename to validate.
 * @throws {Error} If the name is too long or contains unsupported characters.
 */
function validateProjectName(projectName: string): void {
    if (projectName.length > 214 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(projectName)) {
        throw new Error(
            'project name must use lowercase letters, numbers, and hyphens, and start and end with a letter or number'
        );
    }
}

/** Refuse to create a project over any existing filesystem entry.
 *
 * @param destination - Absolute path where the new project would be created.
 * @throws {Error} If the destination exists or cannot be inspected.
 */
function rejectExistingDestination(destination: string): void {
    try {
        fs.lstatSync(destination);
        throw new Error(`destination already exists: ${destination}`);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
    }
}

/** Copy a starter tree, replace plugin-name markers, and remove workspace-only TypeScript config inheritance.
 *
 * @param source - Template directory to copy.
 * @param destination - New project directory to populate.
 * @param projectName - Name substituted for `__PLUGIN_NAME__` markers.
 * @throws {Error} If a template entry is not a regular file or directory.
 */
function copyTemplate(source: string, destination: string, projectName: string): void {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(destinationPath);
            copyTemplate(sourcePath, destinationPath, projectName);
        } else if (entry.isFile()) {
            let contents = fs.readFileSync(sourcePath, 'utf8').replaceAll('__PLUGIN_NAME__', projectName);
            if (entry.name === 'tsconfig.json') {
                const config = JSON.parse(contents) as { extends?: unknown };
                if (config.extends === '../../tsconfig.templates.json') {
                    config.extends = undefined;
                    contents = `${JSON.stringify(config, null, 4)}\n`;
                }
            }
            fs.writeFileSync(destinationPath, contents, { flag: 'wx' });
        } else {
            throw new Error(`unsupported template entry: ${sourcePath}`);
        }
    }
}

/** Print install, build, and typecheck commands for the generated project.
 *
 * @param packageManager - Detected package manager, if the command was launched by one.
 * @param destination - Absolute path to the generated project.
 */
function printNextSteps(packageManager: PackageManager | undefined, destination: string): void {
    const manager = packageManager ?? 'pnpm';
    if (packageManager === undefined) console.log('Package manager was not detected; example commands use pnpm.');
    console.log(`Project directory: ${destination}`);
    console.log(`From the project directory, run: ${manager} install`);
    console.log(`Build the plugin with: ${manager} run build`);
    console.log(`Typecheck the project with: ${manager} run typecheck`);
}

/** Prompt repeatedly until the user selects a supported starter language.
 *
 * @returns The selected starter language.
 */
async function promptForLanguage(): Promise<Language> {
    const interfaceHandle = createInterface({ input: stdin, output: stdout });
    try {
        while (true) {
            const answer = (
                await interfaceHandle.question('Choose a starter: TypeScript (1) or JavaScript (2): ')
            ).trim();
            if (answer === '1' || answer.toLowerCase() === 'typescript' || answer.toLowerCase() === 'ts') {
                return 'typescript';
            }
            if (answer === '2' || answer.toLowerCase() === 'javascript' || answer.toLowerCase() === 'js') {
                return 'javascript';
            }
            console.error('Enter 1 for TypeScript or 2 for JavaScript.');
        }
    } finally {
        interfaceHandle.close();
    }
}

/** Parse CLI arguments and convert expected command errors into a non-zero exit status.
 *
 * @param args - Argument vector passed to Commander, including the executable and script names.
 */
async function main(args: string[] = process.argv): Promise<void> {
    try {
        await createProgram().parseAsync(args);
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'commander.helpDisplayed' || code === 'commander.help') return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`create-pumpkin-plugin: ${message}`);
        process.exitCode = 1;
    }
}

if (
    process.argv[1] &&
    pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href ===
        pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href
) {
    await main();
}
