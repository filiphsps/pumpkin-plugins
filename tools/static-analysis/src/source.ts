import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ts from 'typescript';
import type { AnalysisDiagnostic, ResolutionSettings } from './types.ts';

const defaultLoaders: Record<string, string> = {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.mts': 'ts',
    '.cts': 'ts',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'js',
    '.cjs': 'js',
};

// One host serves every file; each program swaps in its own parsed source.
const compilerHost = ts.createCompilerHost({});

/** Parses code loaders and returns recoverable syntax/read diagnostics; other assets are leaves. */
export async function readSource(file: string, settings: ResolutionSettings, diagnostics: AnalysisDiagnostic[]) {
    const extension = extname(file);
    const loader = settings.loader?.[extension] ?? defaultLoaders[extension];
    if (!loader || !['js', 'jsx', 'ts', 'tsx'].includes(loader)) return undefined;
    let contents: string;
    try {
        contents = await readFile(file, 'utf8');
    } catch (error) {
        diagnostics.push({
            code: 'unreadable-file',
            importer: file,
            location: { line: 1, column: 1, offset: 0, length: 0 },
            message: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
    const source = ts.createSourceFile(
        file,
        contents,
        ts.ScriptTarget.Latest,
        true,
        loader === 'tsx'
            ? ts.ScriptKind.TSX
            : loader === 'ts'
              ? ts.ScriptKind.TS
              : loader === 'jsx'
                ? ts.ScriptKind.JSX
                : ts.ScriptKind.JS,
    );
    const program = ts.createProgram(
        [file],
        { noResolve: true, noLib: true, allowJs: true, noEmit: true },
        {
            ...compilerHost,
            getSourceFile: (path) => (path === file ? source : undefined),
        },
    );
    for (const diagnostic of program.getSyntacticDiagnostics(source)) {
        const offset = diagnostic.start ?? 0;
        const { line, character } = source.getLineAndCharacterOfPosition(offset);
        diagnostics.push({
            code: 'parse-error',
            importer: file,
            location: { line: line + 1, column: character + 1, offset, length: diagnostic.length ?? 0 },
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        });
    }
    return { source, checker: program.getTypeChecker() };
}
