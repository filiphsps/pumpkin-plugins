import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { ensurePumpkinWit } from '../src/wit.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(apiRoot, '../..');

/** Generate the plugin guest types using the pinned Pumpkin WIT package. */
export function generateTypes(args = process.argv) {
    const program = new Command()
        .name('gen-types')
        .description('Generate TypeScript bindings for the pinned Pumpkin WIT.')
        .argument('[output-directory]', 'Directory where guest types are written', path.join(apiRoot, 'build/types'))
        .parse(args);
    const [outputDirectoryArgument] = program.processedArgs;
    const cacheRoot = process.env.PUMPKIN_PLUGINS_CACHE_DIR || path.join(workspaceRoot, '.cache');
    const witDir = ensurePumpkinWit({ lockFile: path.join(apiRoot, 'wit.lock.json'), cacheRoot });
    const jco = resolveJcoCli(path.join(apiRoot, 'package.json'));
    const outputDirectory = path.resolve(outputDirectoryArgument);

    execFileSync(
        process.execPath,
        [jco, 'guest-types', witDir, '-n', 'plugin', '-o', outputDirectory, '--name', 'index', '--quiet'],
        { cwd: apiRoot, stdio: 'inherit' },
    );
}

function resolveJcoCli(packageJsonPath) {
    const require = createRequire(packageJsonPath);
    let entry;
    try {
        entry = require.resolve('@bytecodealliance/jco');
    } catch {
        throw new Error('@bytecodealliance/jco is missing from @pumpkin-plugins/pumpkin-api development dependencies');
    }

    for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
        const candidate = path.join(directory, 'package.json');
        if (fs.existsSync(candidate)) {
            const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            if (pkg.name === '@bytecodealliance/jco') {
                const command = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.jco;
                if (!command) throw new Error('@bytecodealliance/jco package metadata does not declare its jco binary');
                const binary = path.resolve(directory, command);
                if (!fs.existsSync(binary)) throw new Error(`jco binary is missing from its package: ${binary}`);
                return binary;
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
    }
    throw new Error(`could not locate @bytecodealliance/jco package metadata from ${entry}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) generateTypes();
