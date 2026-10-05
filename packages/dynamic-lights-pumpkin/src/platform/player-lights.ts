import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Entity } from 'pumpkin:plugin/world@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { BlockPosition } from '../lights/client-light.ts';
import type { VisibleEntityLight } from '../lights/entity-lights.ts';
import type { HeldItemLightLevels } from '../lights/held-items.ts';
import { findClientLightPosition } from './client-light-position.ts';

/** Reads the held source and its safe client position from the player's current world. */
export function readHeldLight(player: Player, levels: HeldItemLightLevels | undefined) {
    const position = blockPosition(player.getPosition());
    const world = player.getWorld();
    try {
        const right = player.getItemInHand('right');
        let level: number;
        try {
            const left = player.getItemInHand('left');
            try {
                level = levels?.levelForHands(right?.getRegistryKey(), left?.getRegistryKey()) ?? 0;
            } finally {
                disposeWasiResource(left);
            }
        } finally {
            disposeWasiResource(right);
        }
        const lightPosition = level === 0 ? position : findClientLightPosition(world, position);
        return {
            worldId: world.getId(),
            position,
            lightPosition: lightPosition ?? position,
            level: lightPosition === undefined ? 0 : level
        };
    } finally {
        disposeWasiResource(world);
    }
}

/** Reads nearby source positions, releasing acquired handles even when a host query fails. */
export function readEntityLights(player: Player, levelFor: (entity: Entity) => number) {
    const world = player.getWorld();
    try {
        const visible = withNearbyEntities(player, 15, (entities) => {
            const lights: VisibleEntityLight[] = [];
            for (const entity of entities) {
                const level = levelFor(entity);
                if (level === 0) continue;
                const position = findClientLightPosition(world, blockPosition(entity.getPosition()));
                if (position !== undefined) lights.push({ entityId: entity.getId(), position, level });
            }
            return lights;
        });
        return { worldId: world.getId(), visible };
    } finally {
        disposeWasiResource(world);
    }
}

/** Snapshots nearby item IDs so a later refresh can distinguish new drops from old ones. */
export function nearbyItemIds(player: Player): number[] {
    return withNearbyEntities(player, 2, (entities) =>
        entities.filter((entity) => entity.getType() === 'item').map((entity) => entity.getId())
    );
}

/** Reads a player's current world without retaining the returned world handle. */
export function playerWorldId(player: Player): string {
    const world = player.getWorld();
    try {
        return world.getId();
    } finally {
        disposeWasiResource(world);
    }
}

/** Converts a precise entity location to its containing block. */
export function blockPosition([x, y, z]: [number, number, number]): BlockPosition {
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

function withNearbyEntities<T>(player: Player, radius: number, read: (entities: Entity[]) => T): T {
    const self = player.asEntity();
    try {
        const entities = self.getNearbyEntities(radius, radius, radius);
        try {
            return read(entities);
        } finally {
            for (const entity of entities) disposeWasiResource(entity);
        }
    } finally {
        disposeWasiResource(self);
    }
}
