import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SchedulerId, SchedulerParams } from '@kernel/types';
import { renderGantt, runWorkload, type WorkloadRow } from './workloadRunner';

const fcfs: readonly WorkloadRow[] = [
  { name: 'P1', arrival: 0, burst: 24 }, { name: 'P2', arrival: 0, burst: 3 }, { name: 'P3', arrival: 0, burst: 3 },
];
const aging: readonly WorkloadRow[] = [
  { name: 'PL', arrival: 0, burst: 5, priority: 5 },
  ...[1, 2, 3, 4].map(index => ({ name: `H${index}`, arrival: (index - 1) * 4, burst: 4, priority: 1 })),
];
const fixtures: readonly {
  name: string; id: SchedulerId; params: Partial<SchedulerParams>; rows: readonly WorkloadRow[];
}[] = [
  { name: 'sched-fcfs-1', id: 'fcfs', params: {}, rows: fcfs },
  { name: 'sched-fcfs-2', id: 'fcfs', params: {}, rows: [fcfs[1]!, fcfs[2]!, fcfs[0]!] },
  { name: 'sched-sjf-1', id: 'sjf', params: {}, rows: [
    { name: 'P1', arrival: 0, burst: 6 }, { name: 'P2', arrival: 0, burst: 8 },
    { name: 'P3', arrival: 0, burst: 7 }, { name: 'P4', arrival: 0, burst: 3 },
  ] },
  { name: 'sched-srtf-1', id: 'srtf', params: {}, rows: [
    { name: 'P1', arrival: 0, burst: 8 }, { name: 'P2', arrival: 1, burst: 4 },
    { name: 'P3', arrival: 2, burst: 9 }, { name: 'P4', arrival: 3, burst: 5 },
  ] },
  { name: 'sched-prio-1', id: 'priority', params: {}, rows: [
    { name: 'P1', arrival: 0, burst: 10, priority: 3 }, { name: 'P2', arrival: 0, burst: 1, priority: 1 },
    { name: 'P3', arrival: 0, burst: 2, priority: 4 }, { name: 'P4', arrival: 0, burst: 1, priority: 5 },
    { name: 'P5', arrival: 0, burst: 5, priority: 2 },
  ] },
  { name: 'sched-aging-1a', id: 'priority', params: { agingInterval: 0 }, rows: aging },
  { name: 'sched-aging-1b', id: 'priority_aging', params: { agingInterval: 2 }, rows: aging },
  { name: 'sched-rr-1', id: 'rr', params: { quantum: 4 }, rows: fcfs },
  { name: 'sched-mlfq-1', id: 'mlfq', params: { levelQuanta: [4, 8, 16], agingInterval: 50 }, rows: [
    { name: 'P1', arrival: 0, burst: 20 }, { name: 'P2', arrival: 0, burst: 6 }, { name: 'P3', arrival: 10, burst: 4 },
  ] },
];

function readGolden(name: string): string {
  let contents: string;
  try { contents = readFileSync(new URL(`../golden/${name}.gantt`, import.meta.url), 'utf8'); }
  catch (cause) { throw new Error(`Missing Gantt golden: ${name}.gantt`, { cause }); }
  if (!contents.endsWith('\n') || contents.slice(0, -1).includes('\n')) throw new Error(`Expected one line and one newline: ${name}.gantt`);
  return contents.slice(0, -1);
}

function compareGolden(name: string, actual: string): void {
  const expected = readGolden(name);
  expect(actual, `Gantt ${name}\nexpected: ${expected}\nactual:   ${actual}`).toBe(expected);
}

describe('handwritten textbook Gantt goldens', () => {
  it.each(fixtures)('$name', ({ name, id, params, rows }) => {
    compareGolden(name, runWorkload(id, params, rows).gantt);
  });
  it('names a missing golden instead of accepting it', () => {
    expect(() => readGolden('missing-fixture')).toThrow('Missing Gantt golden: missing-fixture.gantt');
  });
  it('shows aligned expected and actual strings on disagreement', () => {
    expect(() => compareGolden('sched-fcfs-1', 'P1[0-1]')).toThrow('expected: P1[0-24] P2[24-27] P3[27-30]\nactual:   P1[0-1]');
  });
  it('renders ASCII segments without adding a dispatch between contiguous same-owner quanta', () => {
    expect(renderGantt([{ name: 'P1', start: 10, end: 30 }])).toBe('P1[10-30]');
    expect(renderGantt([])).toBe('');
  });
});
