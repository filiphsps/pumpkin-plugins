/** Defines a named transformation the codemod CLI can discover and run. */
export interface CodemodDefinition {
    /** Short summary shown by the codemod list command. */
    description: string;
    /** Stable identifier used as the CLI argument. */
    id: string;

    /** Selects files this codemod understands, using a project-relative path. */
    matchesFile(relativePath: string): boolean;

    /** Transforms one selected file synchronously or asynchronously and may return review notes. */
    transform(context: TransformContext): TransformResult | Promise<TransformResult>;
}

/** Input supplied to a codemod for one file. */
export interface TransformContext {
    /** Absolute path to the file being transformed. */
    absolutePath: string;

    /** Working directory the runner resolves input paths against. */
    projectRoot: string;

    /** File path relative to the runner's current working directory. */
    relativePath: string;

    /** Original file contents as UTF-8 text. */
    source: string;
}

/** Source text and optional user-facing notes returned by a codemod. */
export interface TransformResult {
    /** Manual checks or limitations relevant to this file. */
    messages?: readonly string[];
    /** Complete transformed file contents. */
    source: string;
}

/** One changed file reported by a codemod run. */
export interface CodemodFileChange {
    /** Absolute path written when write mode is enabled. */
    absolutePath: string;

    /** Contents after the transformation. */
    after: string;

    /** Contents before the transformation. */
    before: string;

    /** Path relative to the runner's current working directory. */
    relativePath: string;
}

/** A message associated with the file that produced it. */
export interface CodemodMessage {
    /** Path relative to the runner's current working directory. */
    relativePath: string;

    /** Human-readable review note. */
    text: string;
}

/** Counts and changes produced by a codemod run. */
export interface CodemodRunReport {
    /** Files whose transformed contents differ from their original contents. */
    changedFiles: CodemodFileChange[];
    /** Number of matching files passed to the transformation. */
    filesScanned: number;

    /** Review notes returned by changed or unchanged transforms. */
    messages: CodemodMessage[];

    /** Whether this run wrote at least one changed file. */
    wroteFiles: boolean;
}

/** Options for discovering and applying a codemod. */
export interface RunCodemodOptions {
    /** Base directory for relative input paths; defaults to the current directory. */
    cwd?: string;

    /** Write changed files atomically after every selected file has transformed successfully. */
    write?: boolean;
}
