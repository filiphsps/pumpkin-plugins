import { PUMPKIN_RELEASE } from '../tools/test-harness/src/pumpkin-version.ts';

const pumpkinRef = encodeURIComponent(PUMPKIN_RELEASE);

function updateSourceLink(source, file, expectedCount) {
    const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `https://github\\.com/Pumpkin-MC/Pumpkin/blob/[^/]+/${escapedFile}(?:#L\\d+(?:-L\\d+)?)?`,
        'g',
    );
    const count = source.match(pattern)?.length ?? 0;
    if (count !== expectedCount) {
        throw new Error(`Expected ${expectedCount} pinned Pumpkin link(s) to ${file}; found ${count}`);
    }
    // Drop `#L…` anchors: line numbers from another release would point at the wrong code.
    return source.replace(pattern, `https://github.com/Pumpkin-MC/Pumpkin/blob/${pumpkinRef}/${file}`);
}

/** Updates Pumpkin source links to the release used by the integration-test harness. */
export const documents = [
    {
        file: 'docs/code-style.md',
        transform: (source) =>
            updateSourceLink(
                updateSourceLink(source, 'crates/pumpkin/src/plugin/mod.rs', 1),
                'crates/pumpkin/src/logging.rs',
                1,
            ),
    },
];
