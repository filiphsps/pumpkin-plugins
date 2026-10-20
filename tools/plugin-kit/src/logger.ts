/** Where the plugin writes its messages. */
export interface Logger {
    /** A detail that only helps when working out what the plugin is doing. */
    debug(message: string): void;
    /** Something failed. */
    error(message: string): void;
    /** Something worth knowing. */
    info(message: string): void;
    /** Something is off but the plugin carries on. */
    warn(message: string): void;
}

/**
 * Returns a logger that starts every message with `tag`. Pumpkin prints a plugin's messages as
 * `[plugin] <message>` without the plugin's name, so a plugin passes this around instead of `hostLogger`
 * to make every line name it.
 * @param tag - How the lines name the plugin, such as `ansi.named.name(PLUGIN_NAME)`. A space follows it.
 * @param target - Where the tagged messages go, usually `hostLogger`.
 */
export function taggedLogger(tag: string, target: Logger): Logger {
    return {
        debug: (message) => target.debug(`${tag} ${message}`),
        info: (message) => target.info(`${tag} ${message}`),
        warn: (message) => target.warn(`${tag} ${message}`),
        error: (message) => target.error(`${tag} ${message}`),
    };
}
