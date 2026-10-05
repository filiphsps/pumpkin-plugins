// AppleSkin's client identifies each server-to-client payload by its channel name. The channel
// constants stay here; their bare values use plugin-kit's reusable binary encoders.

/** The player's saturation level, which vanilla only sends when it reaches zero. */
export const SATURATION_CHANNEL = 'appleskin:saturation';

/** The player's exhaustion level, which vanilla never sends at all. */
export const EXHAUSTION_CHANNEL = 'appleskin:exhaustion';

/** Whether the player's world heals them by food, which the client assumes is on. */
export const NATURAL_REGENERATION_CHANNEL = 'appleskin:natural_regeneration';
