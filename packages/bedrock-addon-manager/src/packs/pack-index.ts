import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Config } from '../config/schema.ts';
import type { DataFiles, RandomAccessFile } from '../platform/files.ts';
import type { Logger } from '../platform/logger.ts';
import { type BuiltEntries, buildEntries, type PackEntry } from './entries.ts';
import { PackScanner, type ScanResult } from './scanner.ts';

/** The packs the plugin currently knows about: scans the packs folder and works out the entry for each pack. */
export class PackIndex {
    private readonly scanner: PackScanner;
    private current: readonly PackEntry[] = [];
    private reported = new Set<string>();
    private scan: ScanResult = { packs: [], problems: [] };

    /** Creates an empty index. Call `refresh` to fill it. */
    constructor(
        private readonly files: DataFiles,
        private readonly log: Logger
    ) {
        this.scanner = new PackScanner(files);
    }

    /** The packs to announce to clients, in the order they are listed. */
    get entries(): readonly PackEntry[] {
        return this.current;
    }

    /**
     * Scans the packs folder again and logs what it found.
     * @param config - The current settings.
     * @param reachableUrl - Where port forwarding made the web server reachable, if it did.
     */
    refresh(config: Config, reachableUrl?: string): void {
        const { directory } = config.packs;
        this.scan = this.scanner.scan(directory);
        const built = this.rebuild(config, reachableUrl);

        if (built.entries.length === 0) {
            this.log.info(
                `No packs in ${ansi.named.name(`${directory}/`)}. Put .mcpack or .mcaddon files there and run /baddon reload.`
            );
            return;
        }
        const list = built.entries
            .map((e) => `${ansi.named.name(e.fileName)} (${ansi.named.uuid(e.uuid)} v${ansi.named.version(e.version)})`)
            .join(', ');
        this.log.info(
            `Found ${ansi.named.number(built.entries.length)} Bedrock pack${built.entries.length === 1 ? '' : 's'}: ${list}.`
        );
    }

    /**
     * Works out the entries again for the packs found by the last `refresh`, without scanning the folder.
     * @param config - The current settings.
     * @param reachableUrl - Where port forwarding made the web server reachable, if it did.
     */
    rebuild(config: Config, reachableUrl?: string): BuiltEntries {
        const built = buildEntries(this.scan.packs, config, reachableUrl);
        this.reportOnce([...this.scan.problems, ...built.warnings]);
        this.current = built.entries;
        return built;
    }

    /**
     * Opens a listed pack for serving. Only packs in the current list can be opened.
     * @param fileName - The pack's name, as in its download URL.
     * @returns The open file, or undefined when the pack isn't listed or can't be opened.
     */
    open(fileName: string): RandomAccessFile | undefined {
        const entry = this.current.find((e) => e.fileName === fileName);
        if (!entry) return undefined;
        try {
            return this.files.open(entry.path);
        } catch {
            return undefined;
        }
    }

    /** Logs each problem the first time it appears, and again if it comes back after being fixed. */
    private reportOnce(messages: string[]): void {
        const now = new Set(messages);
        for (const message of now) if (!this.reported.has(message)) this.log.warn(message);
        this.reported = now;
    }
}
