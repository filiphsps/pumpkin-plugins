import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import * as path from 'node:path';

// SSRF guard: every passthrough request stays on npm, regardless of the consumer's request target.
const npmRegistryOrigin = 'https://registry.npmjs.org';

/** Creates a temporary registry for packed packages and proxies other paths to npm. */
export function createInternalRegistry(packages) {
    const packageNames = new Set(packages.keys());
    const tarballs = new Map([...packages.values()].map(({ filename, bytes }) => [filename, bytes]));

    return createServer(async (request, response) => {
        try {
            // Fail closed if npm sends credentials to this unauthenticated local proxy.
            if (request.headers.authorization) {
                throw new Error('Temporary registry request unexpectedly included authorization');
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            const decodedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            if (decodedPath.startsWith('tarballs/')) {
                const filename = path.basename(decodedPath.slice('tarballs/'.length));
                const bytes = tarballs.get(filename);
                if (!bytes) {
                    response.writeHead(404).end('Unknown tarball');
                    return;
                }
                response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
                response.end(bytes);
                return;
            }

            const latestPackage = decodedPath.endsWith('/latest') ? decodedPath.slice(0, -'/latest'.length) : undefined;
            if (latestPackage && packageNames.has(latestPackage)) {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify(packageVersionMetadata(packages.get(latestPackage), request)));
                return;
            }

            if (packageNames.has(decodedPath)) {
                const packageMetadata = packages.get(decodedPath);
                const version = packageMetadata.packageJson.version;
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        name: decodedPath,
                        'dist-tags': { latest: version },
                        versions: { [version]: packageVersionMetadata(packageMetadata, request) }
                    })
                );
                return;
            }

            const upstreamUrl = npmRegistryUrl(request.url ?? '/');
            if (!upstreamUrl) {
                response.writeHead(400, { 'content-type': 'text/plain' });
                response.end('Invalid registry request target');
                return;
            }

            const upstream = await fetch(upstreamUrl);
            const body = Buffer.from(await upstream.arrayBuffer());
            response.writeHead(upstream.status, {
                'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
                'content-length': body.length
            });
            response.end(body);
        } catch {
            // Keep upstream errors and local stack details out of the registry response.
            response.writeHead(500, { 'content-type': 'text/plain' });
            response.end('Temporary registry request failed');
        }
    });
}

function npmRegistryUrl(requestTarget) {
    // Reject absolute-form and backslash targets so consumer input cannot redirect fetch to another host.
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//') || requestTarget.includes('\\')) {
        return undefined;
    }

    const queryIndex = requestTarget.indexOf('?');
    const fragmentIndex = requestTarget.indexOf('#');
    const pathEnd = Math.min(
        queryIndex < 0 ? requestTarget.length : queryIndex,
        fragmentIndex < 0 ? requestTarget.length : fragmentIndex
    );

    try {
        const segments = requestTarget
            .slice(0, pathEnd)
            .split('/')
            .map((segment) => decodeURIComponent(segment));
        // Decode before checking to catch encoded traversal; re-encode so hostile path syntax cannot alter the URL.
        if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;

        const url = new URL(segments.map((segment) => encodeURIComponent(segment)).join('/'), npmRegistryOrigin);
        if (queryIndex >= 0 && (fragmentIndex < 0 || queryIndex < fragmentIndex)) {
            const query = new URLSearchParams(
                requestTarget.slice(queryIndex + 1, fragmentIndex < 0 ? requestTarget.length : fragmentIndex)
            );
            const encodedQuery = [...query]
                .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
                .join('&');
            url.search = encodedQuery;
        }

        return url.origin === npmRegistryOrigin ? url : undefined;
    } catch {
        return undefined;
    }
}

function packageVersionMetadata({ packageJson, filename, bytes }, request) {
    return {
        ...packageJson,
        dist: {
            tarball: `${registryOrigin(request)}/tarballs/${encodeURIComponent(filename)}`,
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
            shasum: createHash('sha1').update(bytes).digest('hex')
        }
    };
}

function registryOrigin(request) {
    // Ignore the client-controlled Host header so tarball URLs point only to this loopback proxy.
    const port = request.socket.localPort;
    if (!port) throw new Error('Temporary registry request has no local port');
    return `http://127.0.0.1:${port}`;
}
