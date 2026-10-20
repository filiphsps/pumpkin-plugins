/** The mapper key of one of the server's own ports, such as `own:java`. */
export const ownKey = (name: string): string => `own:${name}`;

/**
 * The mapper key of a port another plugin asked for. The sender and its key are written as JSON, so
 * colons in either can't make two plugins share a key.
 */
export const pluginKey = (sender: string, key: string): string => `plugin:${JSON.stringify([sender, key])}`;

/** Turns a mapper key into a name for people: `own:java` is `java`, a plugin's key is `<plugin> <key>`. */
export function keyName(key: string): string {
    if (key.startsWith('own:')) return key.slice(4);
    const [sender, name] = JSON.parse(key.slice('plugin:'.length)) as [string, string];
    return `${sender} ${name}`;
}
