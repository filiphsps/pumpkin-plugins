import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
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

function checkoutSource(root, source, sparsePath, env) {
    const cache = env.PUMPKIN_PLUGINS_CACHE_DIR || path.join(root, '.cache');
    const destination = path.join(
        cache,
        'api-sources',
        source.repository.replace('/', '-'),
        `${source.ref}-${createHash('sha256')
            .update(sparsePath || 'full')
            .digest('hex')
            .slice(0, 12)}`
    );
    if (fs.existsSync(destination)) {
        const head = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        if (head !== source.ref) throw new Error(`Cached API source has wrong revision: ${destination}`);
        return destination;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = fs.mkdtempSync(`${destination}-`);
    const git = (...args) => execFileSync('git', ['-C', staging, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
    try {
        git('init', '--quiet');
        git('remote', 'add', 'origin', `https://github.com/${source.repository}.git`);
        git('fetch', '--quiet', '--depth=1', '--filter=blob:none', 'origin', source.ref);
        if (sparsePath) {
            git('sparse-checkout', 'init', '--cone');
            git('sparse-checkout', 'set', sparsePath);
        }
        git('checkout', '--quiet', '--detach', source.ref);
        try {
            fs.renameSync(staging, destination);
        } catch (error) {
            if (!fs.existsSync(destination)) throw error;
        }
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
    return destination;
}

/** Resolves independently selected API runtime code and WIT before any build output is written. */
export async function resolveBuildTarget(pluginDir, { root = REPO_ROOT, env = process.env } = {}) {
    const target = readTarget(root, env.PUMPKIN_API_TARGET);
    let apiRoot;
    if (env.PUMPKIN_API_DIR) apiRoot = path.resolve(env.PUMPKIN_API_DIR);
    else if (target.api.installedVersion) {
        const require = createRequire(path.join(pluginDir, 'package.json'));
        apiRoot = path.dirname(require.resolve('@pumpkinmc/pumpkin-api-ts/package.json'));
        const pkg = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
        if (pkg.version !== target.api.installedVersion)
            throw new Error(`API ${pkg.version} does not match ${target.name} pin ${target.api.installedVersion}`);
    } else apiRoot = checkoutSource(root, target.api, undefined, env);
    const pkg = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
    const entry = env.PUMPKIN_API_ENTRY
        ? path.relative(apiRoot, path.resolve(env.PUMPKIN_API_ENTRY))
        : env.PUMPKIN_API_DIR
          ? pkg.main
          : target.api.entry;
    relativeFile(entry, 'API package entry');
    const apiEntry = path.join(apiRoot, entry);
    if (!fs.existsSync(apiEntry)) throw new Error(`API entry does not exist: ${apiEntry}`);
    const witRoot = env.PUMPKIN_WIT_DIR
        ? path.resolve(env.PUMPKIN_WIT_DIR)
        : target.wit.installedPath
          ? path.join(
                path.dirname(
                    createRequire(path.join(root, 'tools/plugin-kit/package.json')).resolve(
                        '@pumpkinmc/pumpkin-api-ts/package.json'
                    )
                ),
                target.wit.installedPath
            )
          : path.join(checkoutSource(root, target.wit, target.wit.path, env), target.wit.path);
    if (!fs.existsSync(path.join(witRoot, 'plugin.wit'))) throw new Error(`Missing plugin.wit in ${witRoot}`);
    const reference = /<reference\s+path=["'](\.\/bindings\/index\.d\.ts)["']/.exec(fs.readFileSync(apiEntry, 'utf8'));
    if (reference && !fs.existsSync(path.join(path.dirname(apiEntry), reference[1]))) {
        const identity = `${fingerprint(apiRoot)}-${fingerprint(witRoot)}`;
        const prepared = path.join(
            env.PUMPKIN_PLUGINS_CACHE_DIR || path.join(root, '.cache'),
            'api-prepared',
            identity
        );
        const selectedEntry = path.relative(apiRoot, apiEntry);
        if (!fs.existsSync(prepared)) {
            fs.mkdirSync(path.dirname(prepared), { recursive: true });
            const staging = fs.mkdtempSync(`${prepared}-`);
            try {
                fs.cpSync(apiRoot, staging, {
                    recursive: true,
                    filter: (file) => !['.git', 'node_modules'].includes(path.basename(file))
                });
                const output = path.join(staging, path.dirname(selectedEntry), 'bindings');
                const jco = path.join(REPO_ROOT, 'tools/build/node_modules/.bin/jco');
                execFileSync(jco, ['guest-types', witRoot, '-n', 'plugin', '-o', output, '--name', 'index'], {
                    stdio: ['ignore', 'ignore', 'inherit']
                });
                try {
                    fs.renameSync(staging, prepared);
                } catch (error) {
                    if (!fs.existsSync(prepared)) throw error;
                }
            } finally {
                fs.rmSync(staging, { recursive: true, force: true });
            }
        }
        return { target, apiRoot: prepared, apiEntry: path.join(prepared, selectedEntry), witRoot };
    }
    return { target, apiRoot, apiEntry, witRoot };
}

function fingerprint(root) {
    const hash = createHash('sha256');
    const ancestors = new Set();
    function visit(dir, relative = '') {
        const real = fs.realpathSync(dir);
        if (ancestors.has(real)) throw new Error(`Cyclic source directory symlink: ${dir}`);
        ancestors.add(real);
        for (const name of fs.readdirSync(dir).sort()) {
            if (['.git', 'node_modules', '.cache', '.turbo'].includes(name)) continue;
            const file = path.join(dir, name);
            const rel = `${relative}/${name}`;
            const stat = fs.statSync(file);
            hash.update(stat.isDirectory() ? 'directory' : 'file')
                .update(rel)
                .update('\0');
            if (fs.lstatSync(file).isSymbolicLink()) hash.update(fs.readlinkSync(file)).update('\0');
            if (stat.isDirectory()) visit(file, rel);
            else if (stat.isFile()) hash.update(createHash('sha256').update(fs.readFileSync(file)).digest());
            hash.update('\0');
        }
        ancestors.delete(real);
    }
    visit(root);
    return hash.digest('hex');
}
