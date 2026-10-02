/** Where the plugin writes its messages. */
export interface Logger {
    /** Something worth knowing. */
    info(message: string): void;
    /** Something is off but the plugin carries on. */
    warn(message: string): void;
    /** Something failed. */
    error(message: string): void;
}
