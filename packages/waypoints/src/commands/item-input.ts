/** Extracts a selected item token from Pumpkin's pre-dispatch command event. */
export function itemIconInputFromCommand(command: string): string | undefined {
    const match = /^(?:\/)?wp\s+set\s+icon\s+(?:"(?:[^"\\]|\\.)*"|\S+)\s+(\S+)\s*$/i.exec(command.trim());
    return match?.[1];
}
