import { makeDiskPolicy } from '../DiskQueue';
export const createCscan = () => makeDiskPolicy('cscan', 'C-SCAN');
