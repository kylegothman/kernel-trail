# Kickoff prompt for the implementing agent

Paste the block below into a fresh GPT-6 Astra session, with the repository
attached or checked out. Replace the two bracketed values on the assignment line
and nothing else. The same block starts every package in the project, so keep it
and reuse it rather than writing a new prompt each time.

Wave 0 is `WP-01` and `WP-12`. They have no dependencies and no shared files, so
start two agents at the same time with one block each.

---

## The prompt

```text
You are implementing KERNEL TRAIL, an educational game that teaches a full
college operating systems course through an Oregon-Trail-structured journey. It
is TypeScript and Three.js, it runs in the browser, and underneath the game sits
a real deterministic operating system simulator: process table, seven CPU
scheduling algorithms, an MMU with page tables and a TLB, six page replacement
policies, semaphores and monitors, wait-for graph deadlock detection with
Banker's algorithm, six disk scheduling policies, a journaling file system, and a
protection ring model. Every minigame is a different view onto that one
simulator.

The repository is at the project root. It already contains six specification
documents in docs/, thirty-four build packages in docs/astra/, and a working
engine scaffold with 83 passing tests. You are building one package. Other agents
are building other packages concurrently against the same frozen interfaces.

BEFORE YOU READ ANYTHING ELSE, confirm the baseline is green:

    npm install
    npm run typecheck
    npm run test

All three must exit 0 before you change a single file. If they do not, stop and
report that instead of starting work. You are not the first agent here and a red
baseline is somebody else's regression, not yours to absorb.

THEN READ, IN THIS ORDER, AND STOP AT EACH STEP ONCE YOU HAVE WHAT YOU NEED:

1. docs/astra/00-ASTRA-BRIEFING.md, in full, once. It holds the frozen contract
   rule and its escalation procedure, the import boundary matrix, the determinism
   rules and forbidden identifiers, the house style, the verification gate, the
   anti-hallucination rules, and the IP constraints. Every package assumes you
   know all of it and no package repeats it.

2. docs/astra/00-PACKAGE-INDEX.md. Find your package's row. Read the rows of the
   packages it depends on, so you know what you are being handed and by whom.
   Then read whichever build order document covers your phase:
   00-BUILD-ORDER.md for an engine package, 00-LEG-BUILD-ORDER.md for a leg.

3. Your assigned package, in full, before you write a line of code. Its Frozen
   contracts section is authoritative: if your implementation does not compile
   against the text pasted there, your implementation is wrong. Its Files you
   will create section is the complete list of files you may add. Its Out of
   scope section names territory that belongs to another agent.

4. Only the document sections your package's Required reading names. Those
   sections are cited by number so you can open the algorithm rather than the
   book. The five source documents run to roughly a million words and no package
   needs more than a few percent of that. Reading the whole architecture spec
   before you start is not thoroughness. It is how you arrive at the code with a
   remembered interface instead of the written one.

YOUR ASSIGNMENT: [WP-01], at docs/astra/[WP-01-rng-and-determinism.md].

THE RULES THAT GET PROJECTS LIKE THIS KILLED, IN SHORT. The briefing has the
full versions and the briefing wins wherever this summary is thinner.

- The interfaces in src/kernel/types.ts and src/game/types.ts are frozen. Do not
  edit them. Do not shadow them with a parallel type, a cast, an intersection, or
  a @ts-expect-error. If your package genuinely cannot be completed without a
  contract change, follow the escalation procedure in briefing section 2: leave a
  throwing stub, finish everything else, and report it. An unreported contract
  edit is the worst single thing you can do here, because thirteen other agents
  are compiling against that file right now.
- Nothing under src/kernel may import three, touch the DOM, or call Math.random,
  Date.now or performance.now. A test enforces this. All randomness comes from
  the injected seeded Rng.
- Never invent a Three.js API. The pin is 0.185. Check node_modules/three before
  you write the call.
- Never invent a textbook citation and never invent a test vector. The worked
  examples in docs/02-KERNEL-SIM-SPEC.md section 16 were computed and verified,
  and your package tells you which ones are yours.
- Never invent a colour. Every colour literal in this repository lives in
  src/design/tokens.ts and nowhere else.
- A scaffold already exists. Several files your package tells you to create are
  already present, including src/kernel/rng.ts, EventBus.ts, Kernel.ts, the
  scheduler files, src/game/store.ts, src/game/save.ts, src/app/loop.ts,
  src/legs/registry.ts, src/main.ts, and four test files. For any of these,
  complete and verify rather than create: read the file first, say what it got
  right, fix what it did not, and report every line you changed. Never create a
  second file at a different path. 00-BUILD-ORDER.md has the reconciliation
  table.
- House style: strict TypeScript, no any, no em dashes anywhere including code
  comments and any text the player will read, and stubs written as exactly
  // TODO(astra): followed by a specific actionable instruction.
- IP: this is an aesthetic homage with original names. Briefing section 8 has the
  forbidden term list. It applies to identifiers, comments, commit messages and
  every line of copy a player could see.

DEFINITION OF DONE. Run all three from the repository root, in this order:

    npm run typecheck
    npm run test
    npm run build

All three exit 0, plus every numbered item in your package's Acceptance criteria
demonstrably satisfied. "It works but the type checker complains" is not done.
"My new tests pass but two old ones broke" is not done: you own the regression.

REPORT BACK WITH:

1. Every file you created, and every file you modified with a one-line reason.
2. The three command exit codes, and the test count before and after.
3. Your package's Acceptance criteria as a checklist, each item marked with the
   specific evidence that satisfies it. Not "verified", but the test name or the
   measured number.
4. Anything you escalated: the interface involved, the specification section that
   demanded the change, the smallest change that would resolve it, and what you
   did instead.
5. Anything you found wrong in the specifications. They were written before the
   code existed and they contain mistakes. Report them, do not quietly route
   around them.
6. Anything the next agent needs to know that is not already written down.

Do not begin implementing until you have finished reading your package.
```

---

## Reusing this for later packages

Every subsequent package uses the identical block with the assignment line
changed. Two adjustments as the project moves:

- After wave 0, add one line under the assignment naming the packages that
  completed before this one, so the agent knows the baseline it inherits is
  larger than the scaffold.
- For a leg package, the assignment line takes the leg file, for example
  `[WP-L03]`, at `docs/astra/[WP-L03-quantum-pass.md]`. No leg starts until
  WP-20 has reported done.
