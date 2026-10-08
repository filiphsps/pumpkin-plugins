import type { Waypoint, WaypointPosition } from '../waypoints/model.ts';
import type { WaypointHudPlacement } from './layout.ts';

const FOCUS_ENTER_COSINE = Math.cos((14 * Math.PI) / 180);
const FOCUS_EXIT_COSINE = Math.cos((22 * Math.PI) / 180);
const FOCUS_SETTLE_TICKS = 6;
const NEAR_DETAIL_DISTANCE = 16;
const NEAR_DETAIL_EXIT_DISTANCE = 18;
const MIN_VIEW_DEPTH_RATIO = 0.35;
const ARRIVAL_HIDDEN_DISTANCE = 0.75;
const ARRIVAL_VISIBLE_DISTANCE = 2;
const MAX_LABEL_CHARACTERS = 32;

/** Transient visual state, separate from waypoint data and world placement. */
export interface WaypointHudPresentation {
    readonly detailed: boolean;
    readonly focusTicks: number;
    readonly distance: number;
    readonly scale: number;
    readonly opacity: number;
}

/** Camera inputs affect detail and perspective sizing, never the marker's position. */
export interface WaypointHudView {
    readonly eyePosition: WaypointPosition;
    readonly yaw: number;
    readonly pitch: number;
}

/** Chooses quiet peripheral labels, stable distance text, and arrival visibility. */
export function presentWaypointHud(
    view: WaypointHudView,
    placement: WaypointHudPlacement,
    distance: number,
    previous: WaypointHudPresentation | undefined
): WaypointHudPresentation {
    const x = placement.position.x - view.eyePosition.x;
    const y = placement.position.y - view.eyePosition.y;
    const z = placement.position.z - view.eyePosition.z;
    const yaw = (view.yaw * Math.PI) / 180;
    const pitch = (view.pitch * Math.PI) / 180;
    const radius = Math.hypot(x, y, z);
    const cosine =
        radius === 0
            ? 1
            : (-x * Math.sin(yaw) * Math.cos(pitch) - y * Math.sin(pitch) + z * Math.cos(yaw) * Math.cos(pitch)) /
              radius;
    const near = distance <= (previous?.detailed ? NEAR_DETAIL_EXIT_DISTANCE : NEAR_DETAIL_DISTANCE);
    const wantsDetail = near || cosine >= (previous?.detailed ? FOCUS_EXIT_COSINE : FOCUS_ENTER_COSINE);
    const focusTicks = previous !== undefined && wantsDetail !== previous.detailed ? previous.focusTicks + 1 : 0;
    const detailed =
        previous === undefined || near || focusTicks >= FOCUS_SETTLE_TICKS ? wantsDetail : previous.detailed;
    const distanceStep = distance < 1000 ? 1 : 100;
    const shownDistance =
        previous === undefined || Math.abs(distance - previous.distance) > distanceStep * 0.65
            ? Math.round(distance / distanceStep) * distanceStep
            : previous.distance;
    const arrival = Math.max(
        0,
        Math.min(1, (distance - ARRIVAL_HIDDEN_DISTANCE) / (ARRIVAL_VISIBLE_DISTANCE - ARRIVAL_HIDDEN_DISTANCE))
    );
    return {
        detailed,
        focusTicks: detailed === wantsDetail ? 0 : focusTicks,
        distance: shownDistance,
        // Billboard planes are camera-facing, so view depth avoids enlargement near the screen corners.
        scale: Math.round(placement.scale * Math.max(MIN_VIEW_DEPTH_RATIO, cosine) * 4096) / 4096,
        opacity: Math.round(arrival * arrival * (3 - 2 * arrival) * 15) * 17
    };
}

/** Creates bounded literal text and a fallback marker; atlas icons are appended after host encoding. */
export function createWaypointHudTextJson(waypoint: Waypoint, distanceBlocks: number, detailed = true): string {
    const characters = Array.from(waypoint.label ?? waypoint.name);
    const label =
        characters.length > MAX_LABEL_CHARACTERS
            ? `${characters.slice(0, MAX_LABEL_CHARACTERS - 1).join('')}…`
            : characters.join('');
    const distanceText =
        distanceBlocks >= 1000 ? `${(distanceBlocks / 1000).toFixed(1)}km` : `${Math.round(distanceBlocks)}m`;
    const extra = detailed
        ? [
              { text: label, color: waypoint.color, bold: true },
              { text: ` (${distanceText})`, color: '#FFFFFF' }
          ]
        : [{ text: distanceText, color: waypoint.color }];
    if (waypoint.icon === undefined) extra.push({ text: '\n◆', color: waypoint.color });
    return JSON.stringify({ text: '', extra });
}
