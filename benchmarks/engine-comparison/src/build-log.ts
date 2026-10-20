/** The fields of a `pumpkin-plugins-build` JSON message that the comparison reads. */
interface BuildLogMessage {
    parseTypeScript?: unknown;
    type: unknown;
}

/**
 * Reads whether a plugin build compiled its bundle with Hermes's TypeScript parser.
 *
 * @param buildLog - Standard output of `pumpkin-plugins-build` run with `PUMPKIN_PLUGINS_BUILD_LOG_FORMAT=json`.
 * Lines that aren't JSON messages, such as verbose toolchain output, are skipped.
 * @returns The parser mode that the build's componentize message reports.
 * @throws {Error} If the log doesn't contain exactly one componentize message.
 */
export function readParseTypeScript(buildLog: string): boolean {
    const messages = buildLog
        .split(/\r?\n/)
        .flatMap(parseMessage)
        .filter(({ type }) => type === 'componentize');
    const [componentize] = messages;
    if (componentize === undefined || messages.length > 1) {
        throw new Error(`Expected one componentize message in the build log, found ${messages.length}`);
    }
    return componentize.parseTypeScript === true;
}

function parseMessage(line: string): BuildLogMessage[] {
    try {
        const message: unknown = JSON.parse(line);
        return typeof message === 'object' && message !== null && 'type' in message ? [message] : [];
    } catch {
        return [];
    }
}
