/**
 * The forbidden variant of the synthetic leg (WP-20 W8): it imports `three`
 * at module scope, which the loader must refuse before importing. Nothing
 * imports this module; the loader's source scan is what the test exercises.
 */
import { Vector3 } from 'three';
import { createHarnessLeg } from '../syntheticLeg';

export const ORIGIN = new Vector3();
export default createHarnessLeg();
