import { makeDiskPolicy } from '../DiskQueue';
export const createFcfs = () => makeDiskPolicy('fcfs', 'First come, first served');
