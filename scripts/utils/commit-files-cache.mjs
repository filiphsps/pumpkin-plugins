import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CACHE_VERSION = 1;

function readCache(filePath) {
    try {
        const cache = JSON.parse(readFileSync(filePath, 'utf8'));
        if (
            cache.version !== CACHE_VERSION ||
            !cache.files ||
            typeof cache.files !== 'object' ||
            Array.isArray(cache.files)
        )
            return new Map();
        return new Map(
            Object.entries(cache.files).filter(
                ([, files]) => Array.isArray(files) && files.every((file) => typeof file === 'string'),
            ),
        );
    } catch (error) {
        if (error.code !== 'ENOENT')
            console.warn(`Ignoring unreadable Release Please commit file cache: ${error.message}`);
        return new Map();
    }
}

/** Reuses GitHub commit file lists and persists the ones used by this release run. */
export function installCommitFilesCache(github, filePath) {
    if (typeof github.getCommitFiles !== 'function')
        throw new TypeError('Release Please GitHub client has no getCommitFiles method');

    const filesBySha = readCache(filePath);
    const usedShas = new Set();
    const getCommitFiles = github.getCommitFiles;
    github.getCommitFiles = async (sha) => {
        usedShas.add(sha);
        if (filesBySha.has(sha)) return [...filesBySha.get(sha)];

        const files = await getCommitFiles.call(github, sha);
        filesBySha.set(sha, files);
        return [...files];
    };

    return {
        save() {
            if (usedShas.size === 0) return;
            const usedFiles = Object.fromEntries([...usedShas].map((sha) => [sha, filesBySha.get(sha)]));
            try {
                mkdirSync(dirname(filePath), { recursive: true });
                writeFileSync(filePath, `${JSON.stringify({ version: CACHE_VERSION, files: usedFiles })}\n`);
            } catch (error) {
                console.warn(`Could not save Release Please commit file cache: ${error.message}`);
            }
        },
    };
}
