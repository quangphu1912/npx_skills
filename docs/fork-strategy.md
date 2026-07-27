# Branch Strategy: patch-on-top of `upstream-main`

## Model

`@phu-le/skills` is a **published fork** of [vercel-labs/skills](https://github.com/vercel-labs/skills). Our customizations are kept as a **thin patch on top** of the latest upstream. Syncing upstream = rebase our patch forward.

```
vercel-labs/skills   (remote: `upstream`)
        │  fetch + ff-only
        ▼
  upstream-main      ← LOCAL mirror, exact copy of vercel-labs/skills (read-only)
        │  our patch rebased on top
        ▼
   main              ← upstream-main + our patch → publishes @phu-le/skills → origin/main
```

`main` = `upstream-main` + our patch (currently one squashed commit; may be split into a few logical commits later). New-feature files (distribute/import/extract/sync-managed/stow) apply with zero conflict; modifications to ~5 shared files (cli/remove/skill-lock/installer/telemetry) are the only resolution surface.

**Why rebase, not merge:** our patch is small and our package is solo — npm resolves by **version tag** (`0.1.3`), not git SHA, so force-pushing `main` never touches a published tarball. Rebasing keeps our customizations as a clean, reviewable delta on top and makes each upstream sync a single resolution pass (vs. resolving per-commit when cherry-picking upstream onto us).

**Force-push is expected here:** `git push --force-with-lease origin main` after every rebase. Safe because no external consumer pins `main` by SHA.

## Remotes & Branches

| Remote | URL | Role |
|--------|-----|------|
| `origin` | `github.com/quangphu1912/npx_skills` | Our fork (push `main` here) |
| `upstream` | `github.com/vercel-labs/skills` | The original (read-only source of enhancements) |

| Branch | Tracks | Purpose |
|--------|--------|---------|
| `main` | `origin/main` | `upstream-main` + our patch. `npm publish` runs from here. |
| `upstream-main` | `upstream/main` | Exact mirror of vercel-labs/skills. Refresh with ff-only pull. |

## Daily: See How We Differ

```bash
git fetch upstream                                   # refresh remote-tracking refs
git checkout upstream-main && git pull --ff-only     # update the local mirror

git log main..upstream-main                          # ← upstream enhancements we DON'T have yet
git log upstream-main..main                          # ← our patch (should be 1–few commits)
git diff upstream-main...main                        # ← net change (our product vs original)
```

## Sync: Rebase Our Patch Onto New Upstream

### Step 1: Refresh the mirror

```bash
git fetch upstream
git checkout upstream-main
git merge --ff-only upstream/main        # mirror must fast-forward; never commit onto it
git push origin upstream-main            # keep the mirror on origin too (optional)
git checkout main
```

If ff-only fails, upstream force-pushed. Inspect `git log upstream-main..upstream/main` first.

### Step 2: Rebase our patch onto the new upstream

```bash
git rebase upstream-main
```

Git replays our patch commits on top of the new `upstream-main`. Conflicts arise only where upstream touched our ~5 shared files (see table below). Resolve each, `git add`, `git rebase --continue`.

### Step 3: Resolve conflicts (shared files only)

| File | Our change | Resolution |
|------|-----------|------------|
| `src/cli.ts` | 5 sync commands + imports | Keep our command registrations; adopt upstream's refactors (e.g. update→update.ts). Watch for duplicate function defs from "moved out" vs "kept inline" |
| `src/remove.ts` | dry-run + intent (`addToRemoved`) | Graft our `!dryRun` gates + intent onto upstream's structure |
| `src/skill-lock.ts` | v4 schema + backup-on-migration | Keep `CURRENT_VERSION=4` + backup; adopt upstream's gh-token warning |
| `src/installer.ts` | distribute wiring | Keep `distributeSkillToAgents`/`getAgentBaseDir`; adopt upstream refactors |
| `src/telemetry.ts` | no-op stubs | Keep no-ops; add stubs for any new exports upstream calls (e.g. `setDetectedAgent`) |

New-feature files (distribute/import/extract/sync-managed/stow/list-agents/skill-intent + docs) don't exist upstream → zero conflict.

### Step 4: Test

```bash
npx vitest run                           # target: all green (see "known env failures" below)
npx tsc --noEmit 2>&1 | grep -E 'src/(cli|remove|skill-lock|installer|telemetry)\.ts'  # no new errors in our files
```

### Step 5: Force-push

```bash
git push --force-with-lease origin main  # rebase rewrote history — force-push is expected here
```

## Known environment-only test failures (not our regression)

These fail on pure `upstream-main` too — they are machine/env, not caused by our patch:

- `src/detect-agent.test.ts` (3) — Cursor detection, machine-specific.
- `tests/git-lfs-clone.test.ts` (1) — fixture `git commit` / LFS config.

If a real regression appears, verify it passes on `upstream-main` first:
`git worktree add /tmp/uc upstream-main && ln -s $PWD/node_modules /tmp/uc && (cd /tmp/uc && npx vitest run <test>)`.

## Disaster Recovery

```bash
git rebase --abort                       # cancel a rebase in progress
git reflog                               # find a pre-rebase state
git reset --hard <ref>                   # restore main
```

`origin/main` is the offsite backup — `git fetch origin && git reset --hard origin/main` as a last resort.
