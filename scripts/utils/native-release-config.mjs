/** Checks whether effective release settings produce independent native version tags. */
export function hasIndependentNativeTagSettings(config, entry) {
    return (
        (entry?.['include-component-in-tag'] ?? config['include-component-in-tag'] ?? true) === true &&
        (entry?.['include-v-in-tag'] ?? config['include-v-in-tag'] ?? true) === true &&
        (entry?.['tag-separator'] ?? config['tag-separator'] ?? '-') === '-'
    );
}
