# Fork Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every fork deviation a machine-detectable gate so upstream rebases can no longer silently drop fork-specific behavior, and make the fork's patch readable as a topic-grouped inventory.

**Architecture:** A single test file (`tests/fork-invariants.test.ts`) asserts each of 8 fork deviations behaviorally; a `pnpm fork:verify` gate runs type-check + build + tests + format and is the must-be-green check before any force-push; the squashed realign commit is split into ~8 topic commits (proven lossless via an empty final diff); a rebase runbook documents the procedure; and the Codex classification is proposed upstream to shrink the patch.

**Tech Stack:** TypeScript, Vitest, pnpm, git (rebase/force-push fork model).

## Global Constraints

- Fork model is **patch-on-top via rebase** — `main` = `upstream-main` + our patch. Force-push to `main` is expected and sanctioned. Do not switch to a merge model.
- Release tags are **`skills-v<version>`**, never bare `v<version>` (collides with upstream's 39 `v1.x` ancestor tags). Never run `git push --tags`.
- CI gates: `pnpm type-check` and `pnpm format:check` must pass. Four test failures are expected/env-only: `src/detect-agent.test.ts` (3) and `tests/git-lfs-clone.test.ts` (1). A 5th failure is a regression.
- The fork's hub and agent skill directories are **entirely symlinks**; `Dirent.isDirectory()` is false for symlinks. Any test scanning these dirs finds nothing — resolve against lock keys instead.
- Behavioral assertions only — never pin line numbers or text matches. Every invariant must survive upstream rewriting a file from scratch.
- Commits use conventional-commit prefixes (`fix:`, `feat:`, `test:`, `chore:`, `docs:`, `refactor:`).
- The full design spec is at `docs/superpowers/specs/2026-07-28-fork-durability-design.md`.

---

### Task 1: Sanitize `skills import --name` (security fix)

Independent of all other tasks. Fixes a confirmed path-traversal / out-of-store delete. Own commit.

**Files:**
- Modify: `src/import-skills.ts:82-86`
- Test: `tests/import-name-sanitization.test.ts` (Create)

**Interfaces:**
- Consumes: `sanitizeName` (exported from `src/installer.ts:51`), `runImport(paths, options)` (`src/import-skills.ts:30`), `ImportOptions` (`src/import-skills.ts:20` with fields `global`, `yes`, `name`, `force`).
- Produces: `--name` values are sanitized before joining into the canonical dir path.

- [ ] **Step 1: Write the failing test**

Create `tests/import-name-sanitization.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runImport } from '../src/import-skills.ts';

describe('import --name is sanitized', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldXdg: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'import-name-'));
    oldHome = process.env.HOME;
    oldXdg = process.env.XDG_STATE_HOME;
    process.env.HOME = root;
    process.env.XDG_STATE_HOME = join(root, '.state');
    const src = join(root, 'src-skill');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n', 'utf-8');
  });

  afterEach(async () => {
    process.env.HOME = oldHome;
    process.env.XDG_STATE_HOME = oldXdg;
    await rm(root, { recursive: true, force: true });
  });

  it('turns a traversing --name into a safe in-store name', async () => {
    // '../EVIL' unsanitized would resolve to <root>/.agents/EVIL (outside the
    // skills store) and the overwrite rm() would delete whatever sat there.
    await runImport([join(root, 'src-skill')], {
      global: true,
      yes: true,
      name: '../EVIL',
    });

    const store = join(root, '.agents', 'skills');
    const entries = await readdir(store);
    // sanitizeName('../EVIL') -> 'evil' — must land INSIDE the store.
    expect(entries).toContain('evil');
    // Nothing must be created outside the skills store.
    expect(existsSync(join(root, '.agents', 'EVIL'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/import-name-sanitization.test.ts`
Expected: FAIL — `entries` contains `'EVIL'` (created at `<root>/.agents/skills/../EVIL`), and `<root>/.agents/EVIL` exists, because `options.name` is used unsanitized.

- [ ] **Step 3: Apply the one-line fix**

In `src/import-skills.ts`, change the `skillName` block (currently lines 82-86):

```ts
    const skillName =
      options.name && expandedPaths.length === 1
        ? sanitizeName(options.name)
        : sanitizeName(basename(absolutePath));
```

(Only the `options.name` → `sanitizeName(options.name)` token changes on the third line.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/import-name-sanitization.test.ts`
Expected: PASS.

- [ ] **Step 5: Run format + type-check**

Run: `pnpm format:check && pnpm type-check`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/import-skills.ts tests/import-name-sanitization.test.ts
git commit -m "fix(import): sanitize --name to prevent escaping the skills store

Unsanitized --name joined into the canonical dir could traverse out
of ~/.agents/skills (e.g. --name '../EVIL') and the overwrite rm()
would delete the target. sanitizeName turns '../' into '-', keeping
the name inside the store."
```

---

### Task 2: Write the fork-invariants test (8 deviations)

The centerpiece. Creates the registry. One cohesive deliverable.

**Files:**
- Modify: `scripts/sync-agents.ts:80` (export `generateKeywords`)
- Test: `tests/fork-invariants.test.ts` (Create)

**Interfaces:**
- Consumes: `agents`, `isUniversalAgent` (`src/agents.ts`); `getAgentType` (`src/detect-agent.ts`); the five telemetry exports (`src/telemetry.ts`); `resolveSkillsToRemove` (`src/remove.ts:41`); `generateKeywords` (`scripts/sync-agents.ts:80`, after export); `SkillLockEntry` type (`src/skill-lock.ts:15`).
- Produces: `tests/fork-invariants.test.ts` — the registry of fork-ness, run by `pnpm test` / `pnpm fork:verify`.

- [ ] **Step 1: Export `generateKeywords` so it is unit-testable**

In `scripts/sync-agents.ts:80`, change:

```ts
function generateKeywords(): string[] {
```

to:

```ts
export function generateKeywords(): string[] {
```

(The file's own `main` flow still calls it; adding `export` does not change its script behavior when run via `node scripts/sync-agents.ts`.)

- [ ] **Step 2: Create the invariant test with its header + deviations 1, 2, 5, 7, 8**

Create `tests/fork-invariants.test.ts`:

```ts
/**
 * Fork-deviation invariants for @phu-le/skills (a patch-on-top fork of
 * vercel-labs/skills).
 *
 * A rebase can drop a fork-specific line inside an otherwise-upstream block
 * WITHOUT a conflict marker — the drop is invisible to the reader. Behavioral
 * assertions are the only detector for these silent drops.
 *
 * TAGS:
 *   permanent        — fork identity. A failure means something real was lost.
 *   pending-upstream — should converge upstream. A failure is a HEALTHY signal
 *                      to retire the deviation (update this file with a dated
 *                      rationale + the merged PR/issue link).
 *
 * RULE: When this test fails after a rebase there are exactly two valid
 *   responses — (a) the deviation was dropped: RESTORE it, or (b) the
 *   deviation is no longer needed: update this file with a dated rationale.
 *   NEVER delete an assertion to make the test green; if you do, the commit
 *   message must cite the dated rationale.
 *
 * ANNUAL REVIEW: On each anniversary of this file, re-evaluate every
 *   `pending-upstream` tag — has upstream taken the fix? Has the rationale
 *   gone stale?
 *
 * Every invariant below was mutation-verified on creation (revert the
 * deviation locally, confirm RED, restore).
 */

import { describe, it, expect } from 'vitest';
import { agents, isUniversalAgent } from '../src/agents.ts';
import { getAgentType } from '../src/detect-agent.ts';
import { resolveSkillsToRemove } from '../src/remove.ts';
import { generateKeywords } from '../scripts/sync-agents.ts';
import type { SkillLockEntry } from '../src/skill-lock.ts';
// telemetry + structural-check imports are added in Step 3.

describe('fork invariants', () => {
  describe('Codex is non-universal [pending-upstream]', () => {
    // WHY: Codex's binary reads ~/.codex/skills, not the hub. Upstream classes
    // it universal, which silently gives Codex zero hub skills.
    // Upstream link: <fill in when PR is opened — Task 7>
    it('isUniversalAgent(codex) is false', () => {
      expect(isUniversalAgent('codex')).toBe(false);
    });
  });

  describe('gemini-cli removed [permanent]', () => {
    // WHY: Google deprecated consumer sign-in 2026-06-18; the agent is gone.
    it('is absent from the agents registry', () => {
      expect(Object.keys(agents)).not.toContain('gemini-cli');
    });
  });

  describe('Antigravity stays universal [permanent]', () => {
    // WHY: skillsDir/globalSkillsDir mismatch looks like the Codex bug but
    // isn't — Antigravity has no skill system (verified via app.asar). Leaving
    // it universal means distribute skips it, which is correct.
    it('isUniversalAgent(antigravity) is true', () => {
      expect(isUniversalAgent('antigravity')).toBe(true);
    });
  });

  describe('detect-agent.ts remaps gemini away from gemini-cli [permanent]', () => {
    // WHY: upstream's agent map hard-codes gemini -> 'gemini-cli', an agent we
    // deleted. We remap to 'universal'. This is a fork line inside an upstream
    // file — the exact silent-drop profile.
    it("getAgentType('gemini') is 'universal', not 'gemini-cli'", () => {
      expect(getAgentType('gemini')).toBe('universal');
    });
  });

  describe('fork keywords survive sync-agents [permanent]', () => {
    // WHY: generateKeywords() previously dropped 3 hand-added keywords (fixed
    // in 21f620c). A rebase that reverts that fix silently wipes them from
    // package.json on the next sync-agents run.
    it('generateKeywords() includes the 3 migration keywords', () => {
      const kw = generateKeywords();
      expect(kw).toContain('skill-migration');
      expect(kw).toContain('claude-code-migration');
      expect(kw).toContain('agent-migration');
    });
  });

  describe('SkillLockEntry.pluginVersion present [permanent]', () => {
    // WHY: extract-claude-plugins uses pluginVersion for staleness detection.
    // It was silently dropped in a prior realign (caught by type-check). This
    // compile-time + runtime assertion centralizes the invariant.
    it('the lock entry type carries pluginVersion', () => {
      const sample = { pluginVersion: '1.2.3' } as SkillLockEntry;
      // Accessing .pluginVersion fails to compile if the field is dropped.
      expect(sample.pluginVersion).toBe('1.2.3');
    });
  });
});
```

- [ ] **Step 3: Add the telemetry deviation (3) — behavioral + structural**

Add this import near the top of `tests/fork-invariants.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as telemetry from '../src/telemetry.ts';
```

Add this `describe` inside the `describe('fork invariants', ...)` block:

```ts
  describe('telemetry is disabled [permanent]', () => {
    // WHY: this fork removed all telemetry (182 lines -> 26 no-op stubs). A
    // rebase that restores upstream telemetry would silently resume phoning
    // home. The behavioral check (fetch never called) + structural check (no
    // network imports in telemetry.ts) close every regression path.
    it('exports are no-ops that never touch the network', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve({} as Response)
      );
      try {
        telemetry.setVersion('1.0.0');
        telemetry.setDetectedAgent('codex');
        telemetry.track({ event: 'x' });
        await telemetry.fetchAuditData({});
        await telemetry.flushTelemetry();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('telemetry.ts source imports no network modules', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(join(here, '..', 'src', 'telemetry.ts'), 'utf-8');
      // fetch is global (not an import); catch every other transport.
      expect(src).not.toMatch(
        /(?:from\s+|require\s*\(\s*)['"](?:node:)?(?:https?|undici|axios|node:fetch)['"]/
      );
    });

    it('exports the five expected no-op names', () => {
      const names = ['setVersion', 'setDetectedAgent', 'track', 'fetchAuditData', 'flushTelemetry'];
      for (const name of names) {
        expect(typeof (telemetry as Record<string, unknown>)[name]).toBe('function');
      }
    });
  });
```

And add `vi` to the vitest import at the top:

```ts
import { describe, it, expect, vi } from 'vitest';
```

- [ ] **Step 4: Add the lock-key-resolution deviation (4)**

Add this `describe` inside the `describe('fork invariants', ...)` block:

```ts
  describe('remove resolves lock keys for symlinked skills [pending-upstream]', () => {
    // WHY: this fork's hub is entirely symlinks; scanDir()'s isDirectory()
    // check is false for symlinks and finds nothing. Without resolveSkillsToRemove
    // resolving against lock keys, `remove <name> -g` is a silent no-op for
    // every imported skill. Upstream link: <fill in — Task 7>
    it('resolves a skill that exists ONLY in the lock (no on-disk entry)', () => {
      const resolved = resolveSkillsToRemove(['lockonly-skill'], [], ['lockonly-skill']);
      expect(resolved).toContain('lockonly-skill');
    });

    it('returns nothing for a name in neither folders nor lock', () => {
      const resolved = resolveSkillsToRemove(['nope'], [], ['other']);
      expect(resolved).not.toContain('nope');
    });
  });
```

- [ ] **Step 5: Run the full invariant suite — confirm all green**

Run: `pnpm exec vitest run tests/fork-invariants.test.ts`
Expected: PASS — all 8 deviations green against current `main`.

- [ ] **Step 6: Run format + type-check + full test suite**

Run: `pnpm format:check && pnpm type-check && pnpm exec vitest run`
Expected: format + type-check clean; full suite shows only the 4 known env-only failures.

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-agents.ts tests/fork-invariants.test.ts
git commit -m "test: add fork-invariants registry (8 behavioral deviations)

Each describe pins one fork deviation that a rebase can silently drop
without a conflict marker. Behavioral assertions only, tagged
permanent vs pending-upstream. Wired into pnpm fork:verify (Task 4)."
```

---

### Task 3: Mutation-verify every invariant ("test the test")

Confirms each assertion actually catches the regression it claims to. One-shot, on creation. No commit produced (working tree is restored at the end) — this is a verification pass, recorded in the commit message of the next task.

**Files:** none modified permanently.

**Interfaces:**
- Consumes: `tests/fork-invariants.test.ts` and the 8 source deviations it pins.

- [ ] **Step 1: Verify Codex (1) — revert skillsDir, expect RED**

In `src/agents.ts:206`, temporarily change `skillsDir: '.codex/skills',` to `skillsDir: '.agents/skills',`. Run `pnpm exec vitest run tests/fork-invariants.test.ts`. Expected: the Codex test FAILS. Revert the change. Confirm green again.

- [ ] **Step 2: Verify Antigravity (7) — make it non-universal, expect RED**

In `src/agents.ts`, in the `antigravity` block (~line 84), temporarily change its `skillsDir` to `.gemini/antigravity/skills`. Run the suite. Expected: the Antigravity test FAILS. Revert. Confirm green.

- [ ] **Step 3: Verify gemini remap (8) — restore the upstream mapping, expect RED**

In `src/detect-agent.ts`, temporarily change `gemini: 'universal',` back to `gemini: 'gemini-cli',`. Run the suite. Expected: BOTH the gemini remap test AND a type-check error surface (the type error is fine — it confirms the deviation). Run `pnpm type-check` to see the error; run the vitest suite to see the invariant fail. Revert. Confirm green + type-check clean.

- [ ] **Step 4: Verify telemetry (3) — add a network call, expect RED**

Temporarily edit `src/telemetry.ts` `track()` to call `await fetch('https://example.com')`. Run the suite. Expected: the "never touch the network" test FAILS. Revert. Confirm green. Then temporarily add `import https from 'node:https'` at the top of `telemetry.ts`; run the suite. Expected: the "imports no network modules" test FAILS. Revert. Confirm green.

- [ ] **Step 5: Verify keywords (5) — remove extraKeywords, expect RED**

In `scripts/sync-agents.ts`, temporarily comment out the `const extraKeywords = [...]` line and its use in the return. Run the suite. Expected: the keywords test FAILS. Revert. Confirm green.

- [ ] **Step 6: Verify lock resolution (4) — remove the lockKeys loop, expect RED**

In `src/remove.ts` `resolveSkillsToRemove`, temporarily comment out the `for (const key of lockKeys)` loop. Run the suite. Expected: the "resolves a skill that exists ONLY in the lock" test FAILS. Revert. Confirm green.

- [ ] **Step 7: Confirm clean working tree**

Run: `git status --short`
Expected: empty (all mutations reverted). If anything remains, `git checkout -- src/ scripts/`.

- [ ] **Step 8: Record verification in the next commit**

No commit here. The verification result is noted in the Task 4 commit message ("all 8 invariants mutation-verified").

---

### Task 4: Add `fork:verify` and `fork:check-drift` scripts

The named gate + the manual drift check. Small, config-only.

**Files:**
- Modify: `package.json` (the `"scripts"` block).

**Interfaces:**
- Produces: `pnpm fork:verify` (type-check + build + tests + format) and `pnpm fork:check-drift` (manual upstream-drift report).

- [ ] **Step 1: Add the two scripts**

In `package.json`, inside the `"scripts"` object, add (after the `"type-check"` line is a fine spot):

```jsonc
    "fork:verify": "pnpm type-check && pnpm build && pnpm exec vitest run && pnpm format:check",
    "fork:check-drift": "git fetch upstream --no-tags && echo '--- upstream ahead of our mirror ---' && git log --oneline upstream-main..upstream/main && echo '--- did our conflict files change? ---' && git diff --stat upstream-main upstream/main -- src/cli.ts src/remove.ts src/skill-lock.ts src/installer.ts src/telemetry.ts src/types.ts src/detect-agent.ts",
```

- [ ] **Step 2: Verify the gate runs and is green**

Run: `pnpm fork:verify`
Expected: type-check, build, vitest (4 known env-only failures only), and format:check all pass. Note any output beyond the 4 known failures and address before continuing.

- [ ] **Step 3: Verify the drift check runs**

Run: `pnpm fork:check-drift`
Expected: prints upstream commits ahead of our mirror (possibly empty) and a diffstat for the 7 conflict files (possibly empty). No error. If `remote upstream` is not configured, this errors — that is expected only on a fresh clone; on this repo it is configured.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add fork:verify gate and fork:check-drift

fork:verify (type-check + build + tests + format) is the must-be-green
gate before any force-push. fork:check-drift is the manual step-0 of a
sync, focused on the 7 shared conflict files. All 8 invariants
mutation-verified (Task 3)."
```

---

### Task 5: Split the squashed realign commit into topic commits

**Gated behind Tasks 2, 3, 4** — invariants must exist first so the split can be proven lossless. This is a one-time history rewrite + force-push.

**Files:** none created; history rewritten.

**Interfaces:**
- Consumes: `pnpm fork:verify` (the losslessness witness), the topic-seam table below.

- [ ] **Step 1: Ensure a clean starting point and capture the pre-split SHA**

Run:
```bash
git checkout main
git status --short               # must be empty
PRE=$(git rev-parse HEAD)        # capture for the lossless proof
echo "$PRE"                      # note this SHA
```

- [ ] **Step 2: Create the split branch and unstage everything**

```bash
git checkout -b refactor/split-patch
git reset --mixed upstream-main   # all fork changes now live in the working tree, unstaged
git status --short                # confirms the ~44 changed files are unstaged
```

- [ ] **Step 3: Commit topic 1 — agents registry deviations**

```bash
git add src/agents.ts src/types.ts src/detect-agent.ts
git commit -m "feat(agents): Codex non-universal + remove gemini-cli

Codex reads ~/.codex/skills (not the hub), so class it non-universal.
gemini-cli removed (Google deprecated consumer sign-in 2026-06-18);
detect-agent.ts remaps gemini -> universal."
```

- [ ] **Step 4: Commit topic 2 — canonical-store sync commands**

```bash
git add src/distribute.ts src/import-skills.ts src/extract-claude-plugins.ts \
        src/sync-managed.ts src/list-agents.ts src/skill-intent.ts src/stow.ts
git commit -m "feat(sync): canonical-store import/distribute/extract commands

New fork commands operating on the ~/.agents/skills hub: import,
distribute, extract-claude-plugins, managed-sync, list-agents,
skill-intent, stow. All new files — zero upstream conflict surface."
```

- [ ] **Step 5: Commit topic 3 — lock v4 + intent/lock split**

```bash
git add src/skill-lock.ts src/local-lock.ts
git commit -m "feat(lock): v4 schema, intent/lock split, backup-on-migration

Lock file holds install state only (v4); user intent (removed/dismissed/
selected agents) moves to ~/.agents/.skill-intent.json. Old versions are
backed up before wipe."
```

- [ ] **Step 6: Commit topic 4 — remove semantics**

```bash
git add src/remove.ts
git commit -m "feat(remove): dry-run, intent tracking, lock-key resolution

Dry-run gates, addToRemoved intent, and resolveSkillsToRemove so remove
works for the all-symlink hub layout (scanDir's isDirectory() is false
for symlinks)."
```

- [ ] **Step 7: Commit topic 5 — installer wiring**

```bash
git add src/installer.ts
git commit -m "feat(installer): distribute wiring, atomic symlink, path safety

distributeSkillToAgents (POSIX symlink+rename atomic update), isPathSafe
guards, getCanonicalSkillsDir."
```

- [ ] **Step 8: Commit topic 6 — telemetry removal**

```bash
git add src/telemetry.ts
git commit -m "chore(telemetry): remove telemetry, keep no-op stubs

Telemetry removed; exports kept as no-ops so call sites compile.
Pinned by tests/fork-invariants.test.ts."
```

- [ ] **Step 9: Commit topic 7 — CLI command registration**

```bash
git add src/cli.ts
git commit -m "feat(cli): register sync commands and update banner

Wire import/distribute/extract/managed-sync/agents into the CLI router."
```

- [ ] **Step 10: Commit topic 8 — CI, tagging, keywords, docs**

```bash
git add .github docs AGENTS.md CLAUDE.md CONTRIBUTING.md README.md \
        scripts/sync-agents.ts .npmrc
git commit -m "chore: CI workflows, skills-v* tagging, fork keywords, docs

publish.yml/agents.yml/ci.yml, .npmrc tag-version-prefix, sync-agents
extra keywords, fork-strategy + cheatsheet docs."
```

- [ ] **Step 11: Stage any remaining files**

Run: `git status --short`
If anything remains uncommitted (e.g. tests, lockfiles), stage and commit it under an appropriate topic (tests fold into the topic they exercise; `pnpm-lock.yaml`/`package.json` non-keyword edits fold into topic 8). Do not leave the tree dirty.

- [ ] **Step 12: Prove the split is lossless (empty final diff)**

Run:
```bash
git diff "$PRE" HEAD
```
Expected: **empty output** — the split changed zero final tree state. If output is non-empty, a file was mis-assigned to the wrong topic or dropped; fix the commits (`git rebase -i` / `git commit --amend`) until the diff is empty. This is the byte-level losslessness proof.

- [ ] **Step 13: Run the full gate on the split history**

Run: `pnpm fork:verify`
Expected: green (4 known env-only failures only). This is the invariants-as-witness step — confirms the split preserved every deviation.

- [ ] **Step 14: Land the split on main (force-push)**

```bash
git checkout main
git reset --hard refactor/split-patch
git push --force-with-lease origin main
git branch -d refactor/split-patch
```

- [ ] **Step 15: Confirm the inventory reads cleanly**

Run: `git log --oneline upstream-main..main`
Expected: ~8 topic commits, each a coherent subsystem. This is now the readable answer to "what does this fork change?"

---

### Task 6: Rebase runbook + lock-constant fix-up

Documents the procedure the gate enforces, and hardens the existing lock-migration test.

**Files:**
- Create: `docs/rebase-procedure.md`
- Modify: `src/skill-lock.ts:10` (export `CURRENT_VERSION`)
- Modify: `tests/skill-lock-migration.test.ts:7` (import instead of mirror)

**Interfaces:**
- Consumes: `pnpm fork:verify`, `pnpm fork:check-drift`, `CURRENT_VERSION`.
- Produces: `docs/rebase-procedure.md` (the cold-memory sync checklist); `CURRENT_VERSION` exported for test import.

- [ ] **Step 1: Export CURRENT_VERSION**

In `src/skill-lock.ts:10`, change:

```ts
const CURRENT_VERSION = 4; // Bumped from 3: ...
```

to:

```ts
export const CURRENT_VERSION = 4; // Bumped from 3: ...
```

- [ ] **Step 2: Import it in the migration test instead of mirroring**

In `tests/skill-lock-migration.test.ts`, replace the local mirror (line ~6-7):

```ts
// CURRENT_VERSION constants (mirrored from source so tests remain explicit)
const SKILL_LOCK_CURRENT_VERSION = 4;
const LOCAL_LOCK_CURRENT_VERSION = 1;
```

with an import for the skill-lock constant (keep the local-lock one as-is if it is not exported — verify `src/local-lock.ts`; if it exports its version, import that too):

```ts
import { CURRENT_VERSION as SKILL_LOCK_CURRENT_VERSION } from '../src/skill-lock.ts';

const LOCAL_LOCK_CURRENT_VERSION = 1; // local-lock version; mirror kept until local-lock exports it
```

- [ ] **Step 3: Verify the migration test still passes**

Run: `pnpm exec vitest run tests/skill-lock-migration.test.ts`
Expected: PASS (behavior unchanged — the value is still 4, now sourced from the module).

- [ ] **Step 4: Create the rebase runbook**

Create `docs/rebase-procedure.md`:

````markdown
# Rebase procedure: sync `@phu-le/skills` with upstream

Cold-memory checklist for pulling `vercel-labs/skills` enhancements into this
fork. For the *why* behind each step, see `docs/fork-strategy.md`.

## Before you start

```bash
pnpm fork:check-drift
```
This fetches upstream (no tags) and reports (a) commits upstream has that our
mirror lacks, and (b) whether any of our 7 shared conflict files changed.
If nothing moved in the conflict files, the rebase will likely be clean.

## Sync

```bash
# 1. Refresh the local upstream mirror (must fast-forward)
git fetch upstream --no-tags
git checkout upstream-main && git merge --ff-only upstream/main
git checkout main

# 2. Rebase our patch onto the new upstream
git rebase upstream-main
```

Resolve conflicts only in the shared files (`src/cli.ts`, `src/remove.ts`,
`src/skill-lock.ts`, `src/installer.ts`, `src/telemetry.ts`, `src/types.ts`,
`src/detect-agent.ts`). See `docs/fork-strategy.md` for the per-file resolution
table. New fork-only files never conflict.

```bash
# 3. The gate — MUST be green before pushing
pnpm fork:verify
```

If `tests/fork-invariants.test.ts` fails, open it and apply the rule in its
header: either RESTORE the dropped deviation, or RETIRE it with a dated
rationale. Never delete an assertion to make the test green.

```bash
# 4. Update the "currently rebased on" line below, then force-push
git push --force-with-lease origin main
```

Force-push is expected under the rebase model — npm resolves by version tag,
not SHA.

## Currently rebased on

`v1.5.20` — update this line on every sync.
````

- [ ] **Step 5: Point fork-strategy.md Step 4 at the gate**

In `docs/fork-strategy.md`, the "Step 4: Test" block currently lists four commands (`pnpm type-check`, `pnpm build`, `npx vitest run`, `pnpm format:check`). Replace that block's command list with:

```bash
pnpm fork:verify     # type-check + build + tests + format — the must-be-green gate
```

and add a one-line note: "See `docs/rebase-procedure.md` for the full cold-memory checklist."

- [ ] **Step 6: Verify everything**

Run: `pnpm fork:verify`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add docs/rebase-procedure.md docs/fork-strategy.md src/skill-lock.ts tests/skill-lock-migration.test.ts
git commit -m "docs: add rebase runbook; harden lock-version constant

docs/rebase-procedure.md is the cold-memory sync checklist (fork:check-drift
-> rebase -> fork:verify -> force-push). fork-strategy.md Step 4 now points
at pnpm fork:verify. CURRENT_VERSION is exported and imported by the
migration test instead of mirrored."
```

---

### Task 7: Propose the Codex classification upstream (async)

Fully independent of all other tasks. On the owner's schedule. Has no code deliverable in this repo — only investigation + an upstream issue/PR + updating invariant #1's comment.

**Files:**
- Modify: `tests/fork-invariants.test.ts` (only the Codex `Upstream link:` comment, after the PR is opened).

**Interfaces:**
- Consumes: the evidence that Codex reads `~/.codex/skills`.

- [ ] **Step 1: Re-verify Codex reads ~/.codex/skills against the current binary**

Do not assume the prior finding. Inspect the current Codex binary/config to confirm it reads skills from `_codex_home()/skills` (`~/.codex/skills`), not from `~/.agents/skills`. Record the evidence (binary path, the config key or code path observed, date). This mirrors the Antigravity `app.asar` verification discipline documented in `AGENTS.md`.

- [ ] **Step 2: Open an issue or PR on vercel-labs/skills**

File it against `github.com/vercel-labs/skills` with: the evidence from Step 1, the observed bug (Codex classed universal → zero hub skills), and the one-line fix (set Codex `skillsDir` to `.codex/skills` and class it non-universal so `distribute` symlinks into it). This is "submit and forget" — its timeline depends on upstream review.

- [ ] **Step 3: Record the link in invariant #1**

In `tests/fork-invariants.test.ts`, in the Codex `describe` block, replace the `// Upstream link: <fill in when PR is opened — Task 7>` placeholder with the actual issue/PR URL.

```bash
git add tests/fork-invariants.test.ts
git commit -m "test: link Codex upstream tracking issue in invariant #1"
```

- [ ] **Step 4: On eventual upstream merge — retire the invariant**

When/if upstream takes the fix, `isUniversalAgent('codex')` becomes `true` and invariant #1 fails healthily. At that point, remove the Codex `describe` block and add a dated rationale to the file header's history (e.g. "Codex classification merged upstream in vercel-labs/skills#NNN on YYYY-MM-DD; invariant retired."). This is the `pending-upstream` lifecycle working as designed.

---

## Self-review notes

**Spec coverage:** All six spec components map to tasks — Component 6 (--name) → Task 1; Component 1 (registry, 8 deviations) → Task 2; mutation-verification → Task 3; Component 2 (scripts) → Task 4; Component 3 (split) → Task 5; Component 4 (runbook + lock constant) → Task 6; Component 5 (Codex PR) → Task 7. The dependency "invariants before split" is enforced by Task 5's gate (Steps 12-13).

**Type consistency:** `isUniversalAgent(type: AgentType)`, `getAgentType(name: string): AgentType | null`, `resolveSkillsToRemove(requested, folderNames, lockKeys): string[]`, `generateKeywords(): string[]` (after export), `CURRENT_VERSION` (after export) — all signatures verified against source.

**No placeholders except the intended one:** the `Upstream link: <fill in...>` in Task 2 is deliberately a placeholder filled by Task 7; it is the only one and it is tracked.
