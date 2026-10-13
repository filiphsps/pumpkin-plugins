/** A problem the user can fix. The CLI prints the message without a stack trace. */
export class BuildError extends Error {}

/** Convert a captured runtime failure into a user-facing error while retaining its diagnostics. */
export function runtimeBuildError(runtime: string, error: unknown): BuildError {
    const output = capturedOutput(error);
    const status = errorField(error, 'status');
    const statusLabel = typeof status === 'number' ? ` (exit ${status})` : '';
    const details = output.length > 0 ? `:\n${output.join('\n')}` : `: ${errorMessage(error)}`;
    return new BuildError(`${runtime} componentizer failed${statusLabel}${details}`);
}

function capturedOutput(error: unknown): string[] {
    const output = [errorField(error, 'stderr'), errorField(error, 'stdout')]
        .map((value) => (typeof value === 'string' || Buffer.isBuffer(value) ? String(value).trim() : ''))
        .filter(Boolean);
    return output;
}

function errorField(error: unknown, name: string): unknown {
    return typeof error === 'object' && error !== null && name in error
        ? (error as Record<string, unknown>)[name]
        : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
