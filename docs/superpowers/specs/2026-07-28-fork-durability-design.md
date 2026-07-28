# Fork Durability: keeping `@phu-le/skills` current with upstream without silent regressions

**Status:** Approved design, awaiting implementation plan
**Date:** 2026-07-28
**Owner:** Phu Le

## Problem

`@phu-le/skills` is a patch-on-top rebased fork of `vercel-labs/skills`. We use
it occasionally and want to pull upstream enhancements periodically without each
sync becoming a crisis. The most recent realign (rebase onto upstream v1.5.20,
~10k lines) exposed the core failure mode:

**A rebase only ever shows conflicts.** The lines that were silently lost lived
*inside* otherwise-upstream blocks — no conflict markers, just gone. They were
caught only by luck:

| Dropped line | Caught by |
| --- | --- |
| `SkillLockEntry.pluginVersion` | `pnpm type-check` |
| `setDetectedAgent` stub | `pnpm type-check` |
| 3 hand-added keywords in `package.json` | a human reading `sync-agents.ts` by hand |

Typed drops were protected by type-check. **Untyped/behavioral drops had no
detector** — Codex's agent classification, telemetry being disabled, the
remove-master semantics would all have silently reverted and shipped. "Read the
10k-line diff more carefully" was never going to help, because the drops were
never shown to the reader.

The usage pattern makes this *more* acute, not less: occasional syncs mean each
one re-derives the realign pain from cold memory, which is exactly when silent
drops slip through.

## Goal

Give every fork deviation a machine-detectable gate, so a realign becomes "run
one command" instead of "read 10k lines vigilantly." Convert the fork's
deviations from "a vigilant human remembers them" into "a test fails if one
disappears."

## Non-goals

- Changing the fork model (patch-on-top / rebase stays).
- Making each topic commit compile independently (bisectability). Out of scope;
  the gate is "final HEAD verifies green," not "each commit builds."
- Scheduled drift alerting. Cut — it solves the wrong problem for occasional use
  (see "Decisions considered").

## Architecture

The design is one centerpiece (a deviation registry enforced by a test) plus
five supporting pieces that make it run on the realign path, keep history
readable, document the procedure, and shrink the patch over time.

```
┌─────────────────────────────────────────────────────────────┐
│  tests/fork-invariants.test.ts   ← the registry + assertion  │
│  (8 deviations, behavioral assertions, tagged)               │
└─────────────────────────────────────────────────────────────┘
        ▲ verified by            ▲ wired into
        │                        │
┌───────┴────────┐      ┌────────┴─────────────────────────────┐
│ "test the test"│      │ pnpm fork:verify  (the named gate)    │
│  once, on edit │      │ pnpm fork:check-drift (manual step 0) │
└────────────────┘      └───────────────────────────────────────┘
                                 │ gates
        ┌────────────────────────┼─────────────────────────┐
        ▼                        ▼                         ▼
┌──────────────────┐  ┌──────────────────────┐  ┌───────────────────┐
│ commit split     │  │ docs/rebase-procedure│  │ Codex upstream PR │
│ (proven lossless │  │ .md runbook          │  │ (async; retires   │
│  via empty diff) │  │                      │  │  invariant #1)    │
└──────────────────┘  └──────────────────────┘  └───────────────────┘
```

The non-negotiable dependency: **invariants must exist before the commit split.**
The split is itself a rebase operation that can drop things; it is only safe
because invariants (plus an empty-diff proof) certify it lossless.

---

## Component 1 — Deviation registry + invariant test (centerpiece)

### Form

One file: `tests/fork-invariants.test.ts`. Deliberately not a separate data
file. For a maintenance tool, indirection hurts: the person running the test
should see the deviation, its tag, and its WHY in one place. Each deviation is a
`describe` block; the `permanent` / `pending-upstream` tag and a one-sentence WHY
live in the block's comment. **The test file is simultaneously the registry, the
inventory, and the primary documentation of fork-ness.**

Revisit the single-file form only when one of these trips:
- entries grow past ~12 (the cognitive scan limit for one file), or
- a non-test consumer appears (a `skills fork:audit` CLI, a docs generator), or
- a second test file needs the same data.

### Assertion style

Behavior only — never line numbers or text matches. Every assertion must survive
upstream rewriting the file from scratch. (`expect(isUniversalAgent('codex')).toBe(false)`
survives a rewrite; `expect(line 142).toMatch(/codex/)` does not.)

### The eight deviations

| # | Deviation | Tag | Assertion |
| --- | --- | --- | --- |
| 1 | Codex non-universal | `pending-upstream` | `isUniversalAgent('codex') === false` |
| 2 | `gemini-cli` removed | `permanent` | absent from agents registry / `AgentType` |
| 3 | Telemetry disabled | `permanent` | stub global `fetch`; call all 5 exports by hardcoded name (`setVersion`, `setDetectedAgent`, `track`, `fetchAuditData`, `flushTelemetry`); `await flushTelemetry()`; assert `fetch` never called — **plus** a structural regex asserting `telemetry.ts` source imports none of `http`/`https`/`undici`/`axios`/`node:fetch` |
| 4 | Lock-key resolution for symlinked skills | `pending-upstream` | drive `remove()` with a skill name that exists **only in the lock** (no on-disk entry); assert the lock entry is removed. Secondary: assert master gone, with a comment that it depends on sandbox topology. |
| 5 | Fork keywords survive `sync-agents` | `permanent` | `generateKeywords()` returns `skill-migration`, `claude-code-migration`, `agent-migration` |
| 6 | `SkillLockEntry.pluginVersion` present | `permanent` | the lock entry type carries the field |
| 7 | Antigravity stays universal | `permanent` | `isUniversalAgent('antigravity') === true` |
| 8 | `detect-agent.ts` gemini-cli remap | `permanent` | the internal agent map contains no `gemini-cli` key |

**Why #4 is resolution, not master-deletion.** "Remove deletes the master" is a
deployment-topology property (the stow symlink makes `~/.claude/skills` and
`~/.agents/skills` physically the same dir), not a code deviation in `remove.ts`.
The real fork deviation is `resolveSkillsToRemove` resolving against lock keys,
because `scanDir()`'s `isDirectory()` check is false for symlinks and finds
nothing — without it, `remove <name> -g` is a silent no-op for every imported
skill. The invariant pins that.

**Why #3 has a structural check.** A `fetch`-only stub is blind to `http`/`https`,
`undici`, `axios`, dynamic imports, and lazy flushes. The structural regex on the
file's own source closes every regression path the behavioral check misses, at
zero maintenance cost. Hardcoding the five export names (rather than iterating
`Object.entries`) means a renamed export surfaces loudly instead of being
silently absorbed.

### Tagging

- `pending-upstream` (#1, #4): the deviation should converge upstream. Each must
  carry the **upstream tracking link** (PR/issue URL) in its comment. When
  upstream takes the fix, the invariant fails *healthily*, signaling "retire this
  deviation." Update the file with a dated rationale.
- `permanent` (#2, #3, #5, #6, #7, #8): fork identity. A failure means something
  real was lost; there is no upstream convergence to wait for.

### Cultural rule (file header)

> When this test fails after a rebase, there are exactly two valid responses:
> (a) the deviation was dropped — restore it, or (b) the deviation is no longer
> needed — update this file with a dated rationale. **Never delete an assertion
> to make the test green.** If you do delete one, the commit message must cite
> the dated rationale.
>
> On each anniversary of this file, re-evaluate every `pending-upstream` tag —
> has upstream taken the fix? Has the rationale gone stale?

### "Test the test" — once, on creation

For each entry, temporarily apply the *realistic* regression (e.g. revert Codex's
`skillsDir` back to `.agents/skills`, not just delete the function), confirm the
assertion fails, then restore. If it does not fail, the assertion is wrong and
protects nothing. This is one-shot mutation testing on creation of the entry —
not a per-rebase step (that becomes ceremony future-you will skip).

---

## Component 2 — `fork:verify` and `fork:check-drift`

### `fork:verify` (the named gate)

```jsonc
"fork:verify": "pnpm type-check && pnpm build && pnpm exec vitest run && pnpm format:check"
```

The single command that must be green before any force-push. Uses `vitest run`
(not `pnpm test`, which is `vitest` with no subcommand and enters watch mode in a
TTY). Supersedes the four-command test list currently in `fork-strategy.md`
Step 4.

### `fork:check-drift` (manual step 0 of a sync)

```jsonc
"fork:check-drift": "git fetch upstream --no-tags && echo '--- upstream ahead of our mirror ---' && git log --oneline upstream-main..upstream/main && echo '--- did our conflict files change? ---' && git diff --stat upstream-main upstream/main -- src/cli.ts src/remove.ts src/skill-lock.ts src/installer.ts src/telemetry.ts src/types.ts src/detect-agent.ts"
```

The demoted form of the cut scheduled-workflow item. Generic "upstream moved N
commits" is noise; "the 7 files where 100% of your rebase pain lives moved" is
signal. Run on demand, never on a schedule.

---

## Component 3 — Commit split

### Why (honest framing)

The primary payoff for occasional use is the **inventory** — `git log
upstream-main..main` becomes a readable answer to "what does this fork change?",
which matters most when syncing from cold memory. Per-topic conflict resolution
is secondary. The split is a one-time rewrite; it never repeats.

### Safety (two proofs, in order)

1. `git diff <pre-split-SHA> HEAD` is **empty** — the split changed zero final
   tree state. Byte-level losslessness.
2. `pnpm fork:verify` is green — including the invariants. (This is why
   invariants must exist first.)

### Topic seams (~8 commits)

| Commit | Files | Content |
| --- | --- | --- |
| `feat(agents)` | agents.ts, types.ts, detect-agent.ts | Codex non-universal, gemini-cli removal |
| `feat(sync)` | distribute, import-skills, extract-claude-plugins, sync-managed, list-agents, skill-intent, stow | canonical-store commands (all new files) |
| `feat(lock)` | skill-lock.ts, local-lock.ts | v4 schema, intent/lock split, backup-on-migration |
| `feat(remove)` | remove.ts | dry-run, intent tracking, lock-key resolution |
| `feat(installer)` | installer.ts | distribute wiring, atomic symlink, isPathSafe |
| `chore(telemetry)` | telemetry.ts | remove telemetry, no-op stubs |
| `feat(cli)` | cli.ts | register sync commands, banner |
| `chore` | workflows, .npmrc, sync-agents.ts, docs, README | CI, tagging, keywords, docs |

Topic commits need not each compile independently. The gate is "final HEAD
verifies green," not "each commit builds."

### Procedure

```
git checkout -b refactor/split-patch
git reset --mixed upstream-main          # unstage everything; changes stay in working tree
# stage + commit by topic (git add per file; git add -p for shared files)
git diff main HEAD                        # MUST be empty — lossless proof
pnpm fork:verify                          # MUST be green
git checkout main && git reset --hard refactor/split-patch
git push --force-with-lease origin main
```

---

## Component 4 — Rebase runbook + upstream-base recording

New **`docs/rebase-procedure.md`** — a short, pure-commands checklist for
cold-memory syncs, pointing at `fork-strategy.md` for the *why* (no duplication).
It absorbs the four-command test list currently in `fork-strategy.md` Step 4
(replace that list with "run `pnpm fork:verify`"):

```
0. pnpm fork:check-drift              # what moved? did our 7 conflict files change?
1. git fetch upstream --no-tags
   git checkout upstream-main && git merge --ff-only upstream/main
2. git checkout main && git rebase upstream-main
3. resolve conflicts in the ~7 shared files (see fork-strategy.md conflict table)
4. pnpm fork:verify                   # MUST be green
   on invariant failure → tests/fork-invariants.test.ts → restore or retire (dated rationale)
5. update the "currently rebased on" line below
6. git push --force-with-lease origin main

Currently rebased on: v1.5.20   ← update each sync
```

The **upstream-base line** lives at the bottom of this file — single source of
truth, the natural place since you read the runbook at sync time.

### Adjacent fix-up

`tests/skill-lock-migration.test.ts` mirrors `CURRENT_VERSION = 4` as a local
constant rather than importing it from source. Switch to importing from
`src/skill-lock.ts` — removes the "fix the test by updating the mirror" hole.
(The existing test does pin v4 behaviorally — it writes a v3 file and asserts
migration to v4 — so this is hardening, not filling a coverage gap.)

---

## Component 5 — Codex upstream PR

Async, non-blocking, on the owner's schedule only. Upstream classes Codex
universal, but its binary reads `_codex_home()/skills`, so it silently gets zero
hub skills. The one-line fix is already in our patch. Scope:

1. Re-verify Codex reads `~/.codex/skills` against the current binary (same
   discipline as the Antigravity check) — do not assume the prior finding.
2. Open an issue or PR on `vercel-labs/skills` citing the evidence.
3. Paste the link into invariant #1's comment as its retirement trigger.

When/if merged, invariant #1 fails healthily and is retired with a dated
rationale.

---

## Component 6 — `--name` security fix

Independent of everything. `import-skills.ts` is fork-only (does not exist
upstream), so it has zero conflict surface and survives every rebase — the
"prefer a new file" principle paying off. One line, its own commit:

```ts
const skillName =
  options.name && expandedPaths.length === 1
    ? sanitizeName(options.name)   // was: options.name (unsanitized)
    : sanitizeName(basename(absolutePath));
```

Without it, `skills import ./x -g --name '../VICTIM' --force` deletes a directory
outside the skills store and plants a symlink in its place (confirmed by sandbox
repro). `sanitizeName` turns `../` into `-`, keeping the name inside the store.

---

## Whole-program order

1. **`--name` security fix** — standalone commit; independent; fixes a live bug.
2. **Invariants + `fork:verify` / `fork:check-drift`** — the protection;
   everything downstream depends on it.
3. **Commit split** — gated behind #2; proven lossless via empty diff + green verify.
4. **Rebase runbook + lock-constant fix-up** — documents the procedure the gate enforces.
5. **Codex upstream PR** — fully independent, whenever the owner chooses.

Steps 1 and 2 have no dependency on each other and may land in either order or
together. Step 3 is gated behind 2. Step 5 is fully independent.

## Decisions considered

- **Scheduled drift workflow (originally item #4) — CUT.** It solves "we don't
  know upstream moved," which `git fetch && git log upstream-main..main` answers
  in 2 seconds when you sit down to sync. Our problem is silent drops *during* a
  sync. A scheduled alert fires on a schedule we didn't choose and gets ignored
  19 times out of 20 — ignored alerts train you to ignore all alerts. Demoted to
  the manual `fork:check-drift` above.
- **Detection mechanism — registry + behavioral test, not snapshot/checksum.** A
  `.patch` snapshot or `git diff` checksum explodes on any legitimate upstream
  refactor of adjacent lines (hunk reordering, whitespace), and trust dies within
  a week as you learn to `--update-snapshot` past it. Behavioral assertions are
  stable across upstream churn: "Codex is non-universal" stays true whether
  upstream rewrites `agents.ts` or merely adjusts a regex.
- **Single-file registry, not data+test.** A split pays off only when a non-test
  consumer appears. With 8 deviations and one consumer, separation is pure
  indirection.
- **`permanent` / `pending-upstream` tagging.** Keeps the registry an inventory
  of fork-ness. `pending-upstream` failures are healthy retirement signals, not
  regressions; `permanent` failures mean something real was lost.

## Success criteria

- `pnpm fork:verify` is green on `main` after every change in this program.
- Every behavioral fork deviation has a failing-on-revert assertion in
  `tests/fork-invariants.test.ts`.
- Reverting any one deviation locally turns the suite red (verified once per entry
  on creation).
- `git log upstream-main..main` reads as a topic-grouped inventory, and
  `git diff <pre-split> HEAD` over the split is empty.
- A cold-memory operator can execute a full upstream sync by following
  `docs/rebase-procedure.md` with no external memory of prior syncs.
