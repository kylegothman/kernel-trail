import { makeDiskPolicy } from '../DiskQueue';
export const createSstf = () => makeDiskPolicy('sstf', 'Shortest seek time first');
