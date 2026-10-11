/** Redacts the exact credential before limiting an API failure diagnostic. */
export function safeBody(body, secret) {
    const redacted = secret ? body.replaceAll(secret, '[REDACTED]') : body;
    return redacted.slice(0, 1000);
}
