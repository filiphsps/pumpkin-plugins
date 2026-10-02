// Keeps Turborepo runs short in an agent's context. A full run replays the logs of every package,
// cached or not (the type generation alone lists every file it writes), so a passing `pnpm test`
// buries the one line that matters. With `--output-logs=errors-only` passing tasks print nothing
// and a failing task prints its whole log, followed by Turborepo's summary either way.

/** Root scripts that are a single `turbo run`, so an extra flag reaches Turborepo. */
const TURBO_SCRIPTS = /^pnpm\s+(?:run\s+)?(?:build|typecheck|test|test:integration)(?:\s|$)/;
const TURBO_RUN = /^(?:pnpm\s+(?:exec\s+)?|pnpm\s+dlx\s+)?turbo\s+run\s/;

/**
 * The command with `--output-logs=errors-only` added when it is a plain Turborepo run that doesn't
 * choose its own log level. Anything with shell syntax is left alone, since the flag could end up
 * on the wrong command.
 *
 * @param {string} command
 * @returns {string}
 */
export function quietTurbo(command) {
    const trimmed = command.trim();
    // After a bare `--` the flag would be passed on to the tasks instead of Turborepo.
    if (/[|;&<>`$()\n]/.test(trimmed) || /--output-logs\b|\s--(\s|$)/.test(trimmed)) return command;
    if (!TURBO_SCRIPTS.test(trimmed) && !TURBO_RUN.test(trimmed)) return command;
    return `${trimmed} --output-logs=errors-only`;
}
