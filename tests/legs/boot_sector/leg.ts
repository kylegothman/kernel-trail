/**
 * The leg with its companion remembered, as the loader would leave it, so a
 * suite that imports the module directly still runs it with its handlers
 * registered (`runLeg` applies `contentOf(leg)` at entry).
 */
import bootSector, { content } from '@legs/boot_sector';
import { rememberContent } from '../harness/loadLeg';

rememberContent(bootSector, content);

export { bootSector, content };
