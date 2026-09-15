import { abs, cameraPosition, fract, fwidth, min, positionWorld, smoothstep, uniform } from 'three/tsl';
import { CYAN, GRID, linearColor } from '@design';
export function gridNode(minorRange: number) {
  const p = positionWorld.xz;
  const distance = p.sub(cameraPosition.xz).length();
  const line = (pitch: number, width: number) => {
    const c = p.div(pitch);
    const d = abs(fract(c.sub(0.5)).sub(0.5)).div(fwidth(c).max(0.00001));
    return smoothstep(0, width, min(d.x, d.y)).oneMinus();
  };
  const minor = line(GRID.minorPitchM, GRID.minorWidthPx).mul(smoothstep(GRID.fadeStartM * 0.25, GRID.fadeStartM, distance).oneMinus());
  const major = line(GRID.majorPitchM, GRID.majorWidthPx).mul(smoothstep(GRID.fadeStartM, GRID.fadeEndM, distance).oneMinus());
  const visible = Number.isFinite(minorRange) ? distance.lessThan(minorRange).select(1, 0) : 1;
  return uniform(linearColor(CYAN.trace)).mul(minor).mul(GRID.minorWeight).mul(visible)
    .add(uniform(linearColor(CYAN.dim)).mul(major).mul(GRID.majorWeight));
}
