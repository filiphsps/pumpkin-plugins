/** Where the plugin writes its messages. */
export interface Logger {
    /** A detail that only helps when working out what the plugin is doing. */
    debug(message: string): void;
    /** Something worth knowing. */
    info(message: string): void;
    /** Something is off but the plugin carries on. */
    warn(message: string): void;
    /** Something failed. */
    error(message: string): void;
}

/** A color from Pumpkin's console palette. */
export type LogColor = 'cyan' | 'green' | 'yellow';

const ANSI_COLOR: Record<LogColor, number> = { cyan: 36, green: 32, yellow: 33 };

/** Colors one high-signal value in a log message with Pumpkin's console palette. */
export function colorLogValue(value: string, color: LogColor): string {
    return `\u001b[${ANSI_COLOR[color]}m${value}\u001b[0m`;
}
