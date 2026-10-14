const maxDiagnosticBytes = 1000;
const maxJsonResponseBytes = 1_048_576;
const redactionMarker = '[REDACTED]';

/** Redacts the exact credential before limiting an API failure diagnostic. */
export function safeBody(body, secret) {
    const redacted = secret ? body.replaceAll(secret, redactionMarker) : body;
    return redacted.slice(0, maxDiagnosticBytes);
}

function redactPossibleTruncatedSecret(body, secret) {
    if (!secret) return body;
    for (let length = Math.min(secret.length - 1, body.length); length > 0; length -= 1) {
        if (!body.endsWith(secret.slice(0, length))) continue;
        const safePrefix = body.slice(0, -length).slice(0, maxDiagnosticBytes - redactionMarker.length);
        return `${safePrefix}${redactionMarker}`;
    }
    return body;
}

/** Reads and redacts a bounded prefix of an API failure response. */
export async function safeResponseBody(response, secret) {
    const reader = response.body?.getReader();
    if (!reader) return '';

    const bytes = new Uint8Array(maxDiagnosticBytes);
    let byteLength = 0;
    let truncated = false;
    try {
        while (byteLength < bytes.length) {
            const { done, value } = await reader.read();
            if (done) break;

            const copyLength = Math.min(value.byteLength, bytes.length - byteLength);
            bytes.set(value.subarray(0, copyLength), byteLength);
            byteLength += copyLength;
            if (copyLength < value.byteLength || byteLength === bytes.length) {
                truncated = true;
                await reader.cancel().catch(() => {});
                break;
            }
        }
    } finally {
        reader.releaseLock();
    }

    const body = new TextDecoder().decode(bytes.subarray(0, byteLength));
    return safeBody(truncated ? redactPossibleTruncatedSecret(body, secret) : body, secret);
}

/** Parses a JSON response while limiting its buffered body to 1 MiB. */
export async function readBoundedJson(response) {
    const contentLength = response.headers.get('content-length');
    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    const hasContentEncoding = contentEncoding && contentEncoding !== 'identity';
    if (
        !hasContentEncoding &&
        contentLength !== null &&
        /^\d+$/.test(contentLength) &&
        Number(contentLength) > maxJsonResponseBytes
    ) {
        await cancelResponseBody(response);
        throw responseSizeLimitError();
    }

    const reader = response.body?.getReader();
    let bytes = new Uint8Array(0);
    let byteLength = 0;
    if (reader) {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const nextByteLength = byteLength + value.byteLength;
                if (nextByteLength > maxJsonResponseBytes) {
                    await reader.cancel().catch(() => {});
                    throw responseSizeLimitError();
                }
                if (nextByteLength > bytes.byteLength) {
                    const capacity = Math.min(
                        maxJsonResponseBytes,
                        Math.max(nextByteLength, bytes.byteLength * 2, 1024),
                    );
                    const expanded = new Uint8Array(capacity);
                    expanded.set(bytes.subarray(0, byteLength));
                    bytes = expanded;
                }
                bytes.set(value, byteLength);
                byteLength = nextByteLength;
            }
        } finally {
            reader.releaseLock();
        }
    }

    const text = new TextDecoder().decode(bytes.subarray(0, byteLength));
    return JSON.parse(text);
}

function responseSizeLimitError() {
    return new RangeError(`JSON response exceeds ${maxJsonResponseBytes} byte limit`);
}

async function cancelResponseBody(response) {
    try {
        await response.body?.cancel();
    } catch {}
}
