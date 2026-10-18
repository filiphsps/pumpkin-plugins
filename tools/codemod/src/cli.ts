import { Command } from '@commander-js/extra-typings';
import { availableCodemods } from './codemods/available.js';
import { codemods } from './codemods/index.js';
import { runCodemod } from './runner.js';
import { runUpdateBuild, type UpdateBuildOptions } from './update-build.js';

/** Output functions and working directory used by the CLI. */
export interface CliOptions {
    /** Directory used to resolve migration paths. */
    cwd?: string;

    /** Receives diagnostics and errors. */
    stderr?: (text: string) => void;

    /** Receives help text, summaries, and printed transformed files. */
    stdout?: (text: string) => void;

    /** Testable dependencies for the explicit builder update workflow. */
    updateBuild?: Omit<UpdateBuildOptions, 'cwd' | 'write'>;
}

/** Parses CLI arguments, lists codemods, or runs a selected migration. */
export async function runCli(argv: string[] = process.argv, options: CliOptions = {}): Promise<number> {
    const cwd = options.cwd ?? process.cwd();
    const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
    const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
    const program = new Command();

    program
        .name('pumpkin-codemod')
        .description('Preview and apply codemods for Pumpkin plugins.')
        .argument('<codemod>', 'codemod name, or "list" to show available codemods')
        .argument('[paths...]', 'files or directories to transform; defaults to the current directory')
        .option('--write', 'write transformed files; without this option, changes are only previewed')
        .option('--print', 'print complete transformed files to standard output')
        .configureOutput({ writeOut: stdout, writeErr: stderr })
        .showHelpAfterError()
        .exitOverride()
        .action(async (codemodId, paths, flags) => {
            if (codemodId === 'list') {
                if (paths.length > 0) throw new Error('The list command does not accept file paths.');
                stdout(
                    `Available codemods:\n${availableCodemods.map(({ id, description }) => `  ${id}  ${description}`).join('\n')}\n`,
                );
                return;
            }

            if (codemodId === 'update-build') {
                const report = await runUpdateBuild(paths, {
                    ...options.updateBuild,
                    cwd,
                    write: flags.write,
                });
                printReport(report, flags.print === true, stdout);
                if (report.changedFiles.length > 0) {
                    stdout('Once the changes are written, run your package manager to update the lockfile.\n');
                }
                return;
            }

            const codemod = codemods.find(({ id }) => id === codemodId);
            if (!codemod) {
                throw new Error(`Unknown codemod "${codemodId}". Run pumpkin-codemod list to see available codemods.`);
            }

            const report = await runCodemod(codemod, paths.length > 0 ? paths : ['.'], {
                cwd,
                write: flags.write,
            });
            printReport(report, flags.print === true, stdout);
        });

    try {
        await program.parseAsync(argv);
        return 0;
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'commander.helpDisplayed' || code === 'commander.help') return 0;
        if (typeof code === 'string' && code.startsWith('commander.')) return 1;
        stderr(`pumpkin-codemod: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}

function printReport(
    report: Awaited<ReturnType<typeof runCodemod>>,
    printContents: boolean,
    stdout: (text: string) => void,
): void {
    if (printContents) {
        for (const change of report.changedFiles) stdout(`--- ${change.relativePath} ---\n${change.after}\n`);
    }

    if (report.changedFiles.length === 0) {
        stdout(`No changes. Scanned ${report.filesScanned} matching file(s).\n`);
    } else {
        const action = report.wroteFiles ? 'Updated' : 'Would update';
        stdout(
            `${action} ${report.changedFiles.length} file(s):\n${report.changedFiles
                .map(({ relativePath }) => `  ${relativePath}`)
                .join('\n')}\n`,
        );
    }
    for (const message of report.messages) stdout(`NOTE ${message.relativePath}: ${message.text}\n`);
    if (report.changedFiles.length > 0 && !report.wroteFiles) {
        stdout('Preview only; no files were changed. To apply these changes, rerun the command with --write.\n');
    }
}
