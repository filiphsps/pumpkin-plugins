import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { BuildError } from './errors.ts';
import { replaceOutput } from './replace-output.ts';

const require = createRequire(import.meta.url);

/**
 * Generates TypeScript declarations for the Pumpkin (and WASI) modules a plugin imports.
 * @param witDir - The WIT to generate from.
 * @param outDir - Where to write the declarations.
 * @throws {BuildError} If jco is not installed or cannot generate declarations from the WIT.
 */
export function generateTypes(witDir: string, outDir: string): void {
    const jco = resolveJcoCli();
    const output = path.resolve(outDir);
    const parent = path.dirname(output);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}-`));
    const generated = path.join(temporary, 'generated');
    let preserveTemporary = false;
    try {
        fs.mkdirSync(generated);
        try {
            execFileSync(
                process.execPath,
                [jco, 'guest-types', witDir, '-n', 'plugin', '-o', generated, '--name', 'index', '--quiet'],
                { stdio: 'inherit' },
            );
        } catch (error) {
            // jco has already written its diagnostics to the inherited stderr.
            const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
            throw new BuildError(
                `jco could not generate guest types from ${witDir}${typeof status === 'number' ? ` (exit ${status})` : ''}`,
            );
        }
        publishTypes(generated, output, temporary, () => {
            preserveTemporary = true;
        });
    } finally {
        if (!preserveTemporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
}

/** Resolve the installed `jco` executable from its package metadata.
 *
 * @returns Absolute path to the installed `jco` executable.
 * @throws {Error} If the package, binary declaration, or executable cannot be found.
 */
function resolveJcoCli(): string {
    let entry: string;
    try {
        entry = require.resolve('@bytecodealliance/jco');
    } catch {
        throw new BuildError(
            '@bytecodealliance/jco is missing from @pumpkin-plugins/build dependencies; reinstall the project dependencies',
        );
    }

    for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
        const packagePath = path.join(directory, 'package.json');
        if (fs.existsSync(packagePath)) {
            const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
                name?: string;
                bin?: string | Record<string, string>;
            };
            if (packageJson.name === '@bytecodealliance/jco') {
                const command = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.jco;
                if (!command) throw new Error('@bytecodealliance/jco package metadata does not declare its jco binary');
                const binaryPath = path.resolve(directory, command);
                if (!fs.existsSync(binaryPath))
                    throw new Error(`jco binary is missing from its package: ${binaryPath}`);
                return binaryPath;
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
    }
    throw new Error(`could not locate @bytecodealliance/jco package metadata from ${entry}`);
}

function publishTypes(generated: string, output: string, temporary: string, preserveForRecovery: () => void): void {
    if (!fs.existsSync(output)) {
        fs.renameSync(generated, output);
        return;
    }

    if (!fs.statSync(output).isDirectory()) throw new Error(`type output is not a directory: ${output}`);
    const previous = path.join(temporary, 'previous');
    replaceOutput(
        generated,
        output,
        previous,
        `could not publish or restore ${output}; previous declarations preserved at ${previous}`,
        preserveForRecovery,
    );
}
