import type { BuildOptions } from 'esbuild';

/** esbuild settings that select modules or determine how source files are parsed. */
export type ResolutionSettings = Pick<
    BuildOptions,
    | 'alias'
    | 'conditions'
    | 'external'
    | 'packages'
    | 'platform'
    | 'mainFields'
    | 'resolveExtensions'
    | 'nodePaths'
    | 'preserveSymlinks'
    | 'tsconfig'
    | 'tsconfigRaw'
    | 'loader'
>;

/** Analysis roots and the consuming build's resolver configuration. */
export interface AnalyzeModuleGraphOptions {
    /** Nonempty project-relative file paths; paths escaping the project are rejected. */
    entryPoints: readonly string[];
    /** Project directory, resolved against the current directory; esbuild's working directory. */
    projectRoot: string;
    /** esbuild resolver settings from the consuming build; esbuild defaults apply when omitted. */
    resolution?: ResolutionSettings;
}

/** Whether a dependency supplies executable code or only TypeScript information. */
export type EdgeKind = 'runtime' | 'type-only';

/** The syntax that introduced a dependency, including computed calls. */
export type ImportForm = 'import' | 're-export' | 'require' | 'dynamic-import' | 'import-type' | 'import-equals';

/** One-based line/column and zero-based UTF-16 offset/length in the original source. */
export interface SourceLocation {
    column: number;
    length: number;
    line: number;
    offset: number;
}

/** File resolution, a build boundary that must not be traversed, or a missing target. */
export type ModuleResolution =
    | { status: 'resolved'; path: string; suffix?: string }
    | { status: 'external'; path: string }
    | { status: 'unresolved' };

/** A source dependency; nonliteral edges omit the specifier and remain unresolved. */
export interface ModuleEdge {
    form: ImportForm;
    importer: string;
    kind: EdgeKind;
    location: SourceLocation;
    resolution: ModuleResolution;
    specifier?: string;
}

/** A recoverable analysis gap; other roots and edges are still returned. */
export interface AnalysisDiagnostic {
    code: 'unresolved-entry' | 'unresolved-import' | 'nonliteral-import' | 'unreadable-file' | 'parse-error';
    form?: ImportForm;
    importer: string;
    /** Present for diagnostics associated with a dependency edge. */
    kind?: EdgeKind;
    location: SourceLocation;
    message: string;
    specifier?: string;
}

/** A file reached exclusively by runtime paths, paths containing a type edge, or both. */
export interface ModuleFile {
    path: string;
    reachability: EdgeKind | 'both';
}

/** Combined graph; absolute paths identify files and roots preserve input order. */
export interface ModuleGraph {
    diagnostics: AnalysisDiagnostic[];
    edges: ModuleEdge[];
    files: ModuleFile[];
    roots: { entryPoint: string; resolution: ModuleResolution }[];
}
