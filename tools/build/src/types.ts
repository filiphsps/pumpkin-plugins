import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Generates TypeScript declarations for the Pumpkin (and WASI) modules a plugin imports.
 * @param witDir - The WIT to generate from.
 * @param outDir - Where to write the declarations.
 */
export function generateTypes(witDir: string, outDir: string): void {
    const jco = path.join(import.meta.dirname, '../node_modules/.bin/jco');
    const output = path.resolve(outDir);
    const parent = path.dirname(output);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}-`));
    const generated = path.join(temporary, 'generated');
    let preserveTemporary = false;
    try {
        fs.mkdirSync(generated);
        execFileSync(jco, ['guest-types', witDir, '-n', 'plugin', '-o', generated, '--name', 'index'], {
            stdio: 'inherit'
        });
        publishTypes(generated, output, temporary, () => {
            preserveTemporary = true;
        });
    } finally {
        if (!preserveTemporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
}

function publishTypes(generated: string, output: string, temporary: string, preserveForRecovery: () => void): void {
    if (!fs.existsSync(output)) {
        fs.renameSync(generated, output);
        return;
    }

    if (!fs.statSync(output).isDirectory()) throw new Error(`type output is not a directory: ${output}`);
    const previous = path.join(temporary, 'previous');
    fs.renameSync(output, previous);
    try {
        fs.renameSync(generated, output);
    } catch (publishError) {
        try {
            fs.renameSync(previous, output);
        } catch (restoreError) {
            preserveForRecovery();
            throw new AggregateError(
                [publishError, restoreError],
                `could not publish or restore ${output}; previous declarations preserved at ${previous}`
            );
        }
        throw publishError;
    }
}
