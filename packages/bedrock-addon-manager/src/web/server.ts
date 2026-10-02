import type { Ipv4 } from './ipv4.ts';

/** Where the web server listens. */
export interface WebServerSettings {
    /** IPv4 address to listen on. */
    bind: string;
    /** TCP port to listen on. */
    port: number;
}

/** A web server that is driven by ticks rather than by its own thread. */
export interface WebServer {
    /**
     * Starts listening.
     * @throws {Error} With a message fit for the server log when the address can't be used.
     */
    start(settings: WebServerSettings): void;
    /** Accepts new connections and moves the running downloads forward. Call once per game tick. */
    tick(): void;
    /** Stops listening and drops every connection. Safe to call when not started. */
    stop(): void;
}

export type { Ipv4 };
