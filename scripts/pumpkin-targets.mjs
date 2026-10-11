import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

function relativeFile(value, label) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        throw new Error(`Invalid ${label}: expected a relative path within the source tree`);
    }
}

function knownFields(record, keys, label) {
    if (!record || typeof record !== 'object' || Array.isArray(record))
        throw new Error(`Invalid ${label}: expected an object`);
    const unknown = Object.keys(record).find((key) => !keys.includes(key));
    if (unknown) throw new Error(`Unknown ${label} field "${unknown}"`);
}

/** Reads and validates a named, pinned API/WIT/server compatibility record. */
export function readTarget(root = REPO_ROOT, name = process.env.PUMPKIN_API_TARGET) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'pumpkin-api-targets.json'), 'utf8'));
    knownFields(config, ['default', 'compatibility', 'targets'], 'target config');
    knownFields(config.targets, Object.keys(config.targets || {}), 'targets');
    name ||= config.default;
    if (!Object.hasOwn(config.targets ?? {}, name) || !/^[\w.-]+$/.test(name)) {
        throw new Error(`Unknown Pumpkin API target "${name}"`);
    }
    const target = config.targets[name];
    knownFields(target, ['api', 'wit', 'server'], name);
    knownFields(target.api, ['repository', 'ref', 'entry', 'installedVersion'], `${name}.api`);
    knownFields(target.wit, ['repository', 'ref', 'path', 'installedPath'], `${name}.wit`);
    knownFields(target.server, ['repository', 'ref', 'tag', 'sha256', 'checksums'], `${name}.server`);
    for (const [label, source] of Object.entries({ api: target.api, wit: target.wit, server: target.server })) {
        if (!source || !REPOSITORY.test(source.repository ?? '') || !SHA.test(source.ref ?? '')) {
            throw new Error(`Invalid ${name}.${label}: repository and full 40-character Git commit required`);
        }
    }
    relativeFile(target.api.entry, `${name}.api.entry`);
    relativeFile(target.wit.path, `${name}.wit.path`);
    if (target.wit.installedPath !== undefined) relativeFile(target.wit.installedPath, `${name}.wit.installedPath`);
    if (target.api.installedVersion !== undefined && typeof target.api.installedVersion !== 'string') {
        throw new Error(`Invalid ${name}.api.installedVersion`);
    }
    if (typeof target.server.tag !== 'string' || !target.server.tag) throw new Error(`Missing ${name}.server.tag`);
    const digests = target.server.sha256;
    if (digests) {
        if (!Object.keys(digests).length || Object.values(digests).some((digest) => !DIGEST.test(digest))) {
            throw new Error(`Invalid ${name}.server digest: each platform needs a SHA-256 pin`);
        }
    } else if (target.server.tag === 'nightly' || target.server.checksums !== 'checksums.sha256') {
        throw new Error(`Missing ${name}.server digest pins or release checksum manifest`);
    }
    return { ...target, name };
}

/** Returns the target names configured for isolated CI compatibility jobs. */
export function compatibilityTargets(root = REPO_ROOT) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'pumpkin-api-targets.json'), 'utf8'));
    if (!Array.isArray(config.compatibility) || !config.compatibility.length)
        throw new Error('No compatibility targets');
    for (const name of config.compatibility) readTarget(root, name);
    return config.compatibility;
}
