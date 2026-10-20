/**
 * Extracts a selected item token from Pumpkin's pre-dispatch command event.
 *
 * The pinned Pumpkin never converts item arguments for WASM plugins, so they arrive empty; see
 * `build_consumed_args_from_context` in
 * https://github.com/Pumpkin-MC/Pumpkin/blob/0.2.0%2B26.3-26.51/crates/pumpkin/src/plugin/loader/wasm/wasm_host/args.rs.
 * Remove this workaround once the pinned server passes the item through.
 */
export function itemIconInputFromCommand(command: string): string | undefined {
    const match = /^(?:\/)?(?:[a-z0-9_.-]+:)?wp\s+set\s+icon\s+(?:"(?:[^"\\]|\\.)*"|\S+)\s+(\S+)\s*$/i.exec(
        command.trim(),
    );
    return match?.[1];
}
