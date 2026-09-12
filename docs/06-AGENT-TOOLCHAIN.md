# KERNEL TRAIL: agent toolchain

How the project is built, as opposed to what is built. Three controls: a
reproducible environment, a contract guard that runs beside the test suite, and a
bounded context compression layer.

---

## 1. The environment is pinned, and node_modules is never shared

Native binaries are per platform. When one agent installs on darwin-arm64 and
another installs into the same checkout from linux-arm64, npm prunes the optional
dependency the first one needs. The toolchain then fails in ways that read as
code faults:

```
Error: Cannot find native binding            (rolldown, so vitest will not start)
Error: Unable to resolve @typescript/typescript-linux-arm64
```

This cost real time during WP-01, twice, and both times the reflex was to look
for a bug in the code. There was none.

The rule: one platform per checkout. `.devcontainer/devcontainer.json` pins Node
22 and mounts `node_modules` as a named volume rather than through the bind
mount, so a host install and a container install cannot overwrite each other. If
you build outside the container, do not also build inside it against the same
directory.

If you see either error, delete `node_modules` and reinstall. Do not work around
it, and do not file it as a defect in whatever package you were building.

## 2. The contract guard

`npm run check:contracts`, also the first CI job, and it runs with no
dependencies installed so that it still works when the dependency tree is broken.

It checks five things that a green test suite cannot detect, because in every one
of these cases the suite IS green:

| Rule | What it catches |
|---|---|
| `frozen-contract` | An agent edited `src/kernel/types.ts` or `src/game/types.ts` to make its own package compile. Thirteen other packages are building against that file. |
| `single-scanner` | A second source scanner with a policy contradicting the first. This exact failure blocked WP-01. |
| `skip-budget` | A failing test made to pass by skipping it. The budget only moves down, and only by human decision. |
| `no-em-dashes` | House style, in code comments and generated documents as well as player-facing copy. Agents reintroduce these constantly. |
| `ip-leak` | A borrowed name reaching a file that ships. |

State lives in `contracts.lock.json`. Changing a value there is how a human
approves something the guard would otherwise block, and the commit message has to
say why.

The guard reports the file, the line and the remedy for every violation. That is
deliberate. A check that says only "failed" teaches people to disable it.

Two known limits, stated rather than hidden. The IP rule deliberately omits
`grid`, `bit`, `ram`, `kevin` and `sam`, because each is an ordinary English or
technical word in this codebase (a grid floor, RAM, a bit field) and scanning for
them produces noise. Those five stay a human review item. And the guard cannot
detect a specification that contradicts itself, which is what actually blocked
WP-01. Nothing automated can. Escalation covers that, and it worked.

## 3. Headroom, and the narrow place it belongs

[Headroom](https://github.com/headroom) sits between the build agent and the
model provider, compressing bulk out of tool output before it becomes billable
input, caching the original locally so the model can pull it back on demand.

### Why it is dangerous here specifically

This project's specifications are dense with exact numbers that are load bearing:

```
RNG first draw          0.6523296025
FIFO / LRU / OPT faults 15 / 12 / 9
Belady, 3 vs 4 frames   9 vs 10
SCAN total head movement 236
Banker's safe sequence  <P1, P3, P0, P2, P4>
```

Every one of those is a test fixture. A compressor that classifies a table of
numbers as bulk and paraphrases it hands the agent fabricated constants, and the
agent then writes code that passes tests built on them. The suite is green, the
simulator is wrong, and nothing downstream ever notices. That is the worst
failure mode available in this project, and it is exactly the kind of content a
general-purpose summariser is most likely to flatten.

The architecture also already manages context structurally. The rule that a
package reads only the document sections it names, and the package index's
instruction to stop reading at each step, exist so the bulk never enters the
window. Compression removes bulk after it exists. Prevention beats it and is
already in place.

### Where it does earn its place

One workload qualifies: **long headless traces**, which means golden run event
logs from WP-20 and full kernel event streams from a failed determinism run.
These are large, highly repetitive, mechanically generated, and genuinely
re-fetchable from the seed. They are the one thing here that compresses well and
loses nothing that cannot be recovered exactly.

### The cheaper fix comes first

Before any of that reaches a model, WP-20 reduces it. A golden log is stored and
compared as a hash plus a structural summary, never as prose. The full log is
materialised only on a mismatch, and even then only the diverging window plus
context, not the whole run. Most failures are then a few hundred tokens.
Compression handles the residue, not the bulk.

### Hard exclusions

Never compressible, in any configuration:

- `src/kernel/types.ts` and `src/game/types.ts`, the frozen contracts
- everything under `docs/`, the five specifications and the build packages
- `contracts.lock.json`
- any test file, any fixture file, and any content with a citation of the form
  `Ch. N.N` or a numeric test vector
- tool output from `typecheck`, `test`, `build` or `check:contracts`. These are
  small, and they are the signal the agent is acting on.

### Allowed

- golden run event logs under `tests/golden/`
- captured kernel event streams over roughly 200 lines
- `npm install` output and dependency resolution noise
- git history output beyond the last few commits

### Before it is trusted, it must prove itself

Wire Headroom up in shadow mode first and add a canary: take a known golden log,
send it through compress and then expand, and assert the result is byte identical
to the original. Assert the same for a document containing the numeric table
above. If either round trip is lossy, Headroom does not enter the loop. A
compression layer that cannot prove fidelity on this project's own data has no
business sitting in front of its specifications.

`tools/headroom/policy.json` encodes the rules above. Its field names are this
project's policy vocabulary, not Headroom's configuration schema. Whoever wires
it up maps them to the real schema by reading Headroom's own documentation, and
does not guess.
