const DEFAULT_TURBO_FLAGS = [
    ['--output-logs', '--output-logs=new-only'],
    ['--log-order', '--log-order=grouped'],
    ['--log-prefix', '--log-prefix=task'],
];

/** Add default Turbo flags unless the caller supplied those options.
 * @param args - Turbo arguments, excluding the Turbo executable.
 * @returns The arguments with missing defaults added before any task arguments after `--`.
 */
export function withDefaultTurboFlags(args) {
    const separator = args.indexOf('--');
    const turboArgs = separator === -1 ? args : args.slice(0, separator);
    const callerOptions = new Set(
        turboArgs.flatMap((arg) => {
            const option = DEFAULT_TURBO_FLAGS.find(([name]) => arg === name || arg.startsWith(`${name}=`));
            return option ? [option[0]] : [];
        }),
    );
    const defaults = DEFAULT_TURBO_FLAGS.filter(([name]) => !callerOptions.has(name)).map(([, flag]) => flag);

    if (separator === -1) return [...args, ...defaults];
    return [...turboArgs, ...defaults, ...args.slice(separator)];
}
