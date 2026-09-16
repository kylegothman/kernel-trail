/**
 * The leg 0 event table, verbatim from narrative bible section 8. Weights sum
 * to 100. `boot.vendor_string` is the one seeded line about virtualization and
 * it stays unexplained.
 */
import type { RandomEventDef } from '@game/types';

export const bootSectorEvents: readonly RandomEventDef[] = [
  {
    id: 'boot.firmware_handoff',
    weight: 16,
    title: 'Clean Handoff',
    narration: 'The firmware finishes its self-test and hands control over without an error line. Whatever it did not have to retry is time the convoy keeps.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 40 },
    onlyIf: null,
  },
  {
    id: 'boot.misread_vector',
    weight: 14,
    title: 'Misread Vector',
    narration: 'An interrupt vector is loaded one entry off and the handler runs against the wrong device. The Substrate corrects it silently and bills the convoy for the attempt.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -30 },
    onlyIf: null,
  },
  {
    id: 'boot.mode_switch_tax',
    weight: 15,
    title: 'Mode Switch Tax',
    narration: 'Every request the convoy makes crosses from user mode into the kernel and back. The crossing is cheap and there are a great many of them.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -4 },
    onlyIf: null,
  },
  {
    id: 'boot.vendor_string',
    weight: 10,
    title: 'Vendor String',
    narration: 'The sign-on banner names a machine model nobody in the Boot Sector recognises, with a version suffix after it. VESPER copies it down and does not say why.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'boot.syscall_overcharge',
    weight: 14,
    title: 'Trap Overcharge',
    narration: 'The requisition desk charges the full trap cost for a call that was serviced from cache. There is no counter to complain at.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'boot.surplus_requisition',
    weight: 17,
    title: 'Surplus Requisition',
    narration: 'A workload that was scheduled to launch this cycle did not, and its frames are unassigned. The desk issues them to the convoy without comment.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 60 },
    onlyIf: null,
  },
  {
    id: 'boot.dual_mode_drill',
    weight: 14,
    title: 'Dual Mode Drill',
    narration: 'The convoy runs the privilege boundary drill twice and clears it twice. The Substrate widens their I/O grant on the strength of it.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 8 },
    onlyIf: null,
  },
];
