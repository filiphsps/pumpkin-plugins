import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverComponents } from './discovery.ts';
import { generateDocuments, type Status, type TransformDocumentSpec } from './documents.ts';

/** Update action example tags from release metadata; unreleased actions use their release-as pin. */
export function generateActionVersions(root: string, check = false): Status {
    const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8'));
    const documents: TransformDocumentSpec[] = discoverComponents(root, 'actions').map(({ slug }) => {
        const releasePath = `actions/${slug}`;
        const releaseConfig = config.packages?.[releasePath];
        if (!releaseConfig)
            throw new Error(`${releasePath} has action metadata but is missing from release-please-config.json`);
        const component = releaseConfig.component;
        if (typeof component !== 'string' || !component)
            throw new Error(`${releasePath} needs a component in release-please-config.json`);
        const manifestVersion = manifest[releasePath];
        if (typeof manifestVersion !== 'string')
            throw new Error(`${releasePath} is missing a string version in .release-please-manifest.json`);
        const version = manifestVersion === '0.0.0' ? releaseConfig['release-as'] : manifestVersion;
        if (typeof version !== 'string' || !version)
            throw new Error(`${releasePath} is still at 0.0.0 but has no release-as first-release version`);
        const escaped = component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tagPattern = new RegExp(`(${escaped}-v)[0-9][0-9A-Za-z.+-]*`, 'g');
        return {
            file: `${releasePath}/README.md`,
            transform: (source) => {
                tagPattern.lastIndex = 0;
                if (!tagPattern.test(source))
                    throw new Error(`${releasePath}/README.md has no example tag starting with ${component}-v`);
                tagPattern.lastIndex = 0;
                return source.replace(tagPattern, (_match, prefix) => `${prefix}${version}`);
            },
        };
    });
    return generateDocuments(documents, root, check);
}
