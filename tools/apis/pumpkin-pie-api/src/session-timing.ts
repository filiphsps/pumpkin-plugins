/** Session scheduling defaults and bounds in milliseconds; shared with documentation generation. */
export const SESSION_TIMING = {
    defaultPingMs: 30000,
    minPingMs: 1000,
    maxPingMs: 30000,
    initialRetryMs: 1000,
    maxRetryMs: 300_000,
} as const;
