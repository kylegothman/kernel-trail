# Golden leg runs

This directory holds the recorded golden playthroughs of every shipped leg,
two files per fixture path:

    <leg_id>.good.fingerprint.txt
    <leg_id>.good.summary.txt
    <leg_id>.bad.fingerprint.txt
    <leg_id>.bad.summary.txt

The fingerprint is the seed, tick count, event count and canonical event log
hash of the run. The summary is the per-event-type count with first and last
tick. Neither is a full log; a full log is never checked in.

Recording is a human action. Run it deliberately, one leg and one path at a
time, and read the closing ledger it prints before committing:

    npm run golden:record -- --leg <leg_id> --path good
    npm run golden:record -- --leg <leg_id> --path bad

The tool refuses to overwrite an existing golden without --force, and prints
both hashes when it does. UPDATE_GOLDEN and any other environment variable
change nothing.

A regenerated golden is a behaviour change. Review it as one: the pull
request that regenerates a fingerprint says what moved the hash and why, and
`npm run golden:explain -- <leg_id> <good|bad>` names the first divergent
tick and sequence number for the reviewer.

Nothing else lives here. The harness reads only the four file names above per
leg, and `tests/legs/goldens.test.ts` skips a leg whose files are absent with
a printed line rather than a skipped test.
