/**
 * The UI layer barrel. Cross-layer imports come through here.
 */
export { DomBatch } from './DomBatch';
export { SILENT_SOUNDS } from './sounds';
export type { UiSounds } from './sounds';
export { Hud, createHud, HUD_CELL_CLASS } from './hud/Hud';
export type { HudOptions, HudVisibility } from './hud/Hud';
export * from './hud/layout';
export { contrastRatio, compositeOver, relativeLuminance } from './hud/contrast';
export { HUD_CSS, buildHudCss, HUD_TEXT_TOKENS, ALERT_STYLE } from './hud/hud.css';
export { HUD_STRUCTURE_NAMES, HUD_KERNEL_NAME } from './hud/structures';
export type { HudStructureName, AlertStructure } from './hud/structures';
export { deriveAlert, composeAlert, AlertModel } from './hud/regions/AlertStack';
export type { HudAlert, AlertSeverity, AlertStackProps } from './hud/regions/AlertStack';
export type { LegRailProps } from './hud/regions/LegRail';
export type { PolicyChipsProps } from './hud/regions/PolicyChips';
export type { MetersProps } from './hud/regions/Meters';
export type { ConvoyPipsProps, ConvoyPipProps } from './hud/regions/ConvoyPips';
export { AFFLICTION_GLYPH } from './hud/regions/ConvoyPips';
export type { ResourceLedgerProps } from './hud/regions/ResourceLedgerView';
export type { FocusHintProps } from './hud/regions/FocusHint';
