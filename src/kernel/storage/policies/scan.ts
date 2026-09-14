import { makeDiskPolicy } from '../DiskQueue';
export const createScan = () => makeDiskPolicy('scan', 'SCAN');
