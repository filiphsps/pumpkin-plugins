import type { ForcedLodPeer } from '../lod/force-generation.ts';

/** A player snapshot and terrain access, valid only during an adapter callback. */
export interface PlayerTerrain extends ForcedLodPeer {
    dimension: string;
    x: number;
    z: number;
}
/** A Java player that can exchange DH messages, valid only during an adapter callback. */
export interface Peer extends PlayerTerrain {
    send(bytes: Uint8Array): void;
}
/** Runs work with one player's host handles; the work must not keep the peer after its callback. */
export interface Peers {
    /** Returns false when the player is offline or has no Java handle for DH messages. */
    withPeer(name: string, use: (peer: Peer) => void): boolean;
    /** Returns false when the player is offline; Bedrock players get terrain access too. */
    withTerrain(name: string, use: (peer: PlayerTerrain) => void): boolean;
}
