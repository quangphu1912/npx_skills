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
| `src/types.ts` | `gemini-cli` removed from `AgentType` | Keep it removed. Upstream code that references it must be remapped, not revived — see below |
| `src/detect-agent.ts` | none (pure upstream file) | Upstream's agent map hard-codes `gemini: 'gemini-cli'`, an agent we deleted. Remap to `'universal'`, matching the `devin` entry already in that map |

New-feature files (distribute/import/extract/sync-managed/stow/list-agents/skill-intent + docs) don't exist upstream → zero conflict.

### Lines that are easy to lose

A rebase can drop a single added line inside an otherwise-upstream block without any
conflict marker. Both of these were silently lost in the v1.5.20 realign and only
surfaced via `pnpm type-check`:

- `SkillLockEntry.pluginVersion` in `src/skill-lock.ts` — our field, used by
  `extract-claude-plugins` for staleness detection.
- `setDetectedAgent` in `src/telemetry.ts` — the stub upstream's `detect-agent.ts` imports.

**`pnpm type-check` is the detector for this class of loss. Treat it as the gate,
not the test suite** — the tests passed while all four type errors were live.

### Step 4: Test

```bash
pnpm type-check                          # MUST be 0 errors — this is the real gate
pnpm build
npx vitest run                           # 4 known env failures only (see below)
pnpm format:check                        # CI gate too; a rebase can leave long lines unwrapped
```

Do not filter the type-check output to "our" files — the losses described above show up
in files we don't own (`extract-claude-plugins.ts` erroring because `skill-lock.ts` lost a field).

### Step 5: Force-push

```bash
git push --force-with-lease origin main  # rebase rewrote history — force-push is expected here
```

## Releasing & Tagging

### Why our tags are prefixed

Upstream's 39 `v1.x` tags are **ancestors of our history** — rebasing onto `upstream-main`
puts `v1.5.20` on our first-parent chain. So a bare `git describe --tags --abbrev=0`
returns `v1.5.20`, not our version:

```bash
git describe --tags --abbrev=0                      # v1.5.20   ← upstream's, wrong
git describe --tags --abbrev=0 --match 'skills-v*'  # skills-v0.1.3  ← ours
```

That silently broke `publish.yml`, which used the bare form to pick the changelog range
and to scan commits for `[patch]`/`[minor]` markers.

**Our releases are therefore tagged `skills-v<version>`.** `.npmrc` sets
`tag-version-prefix=skills-v` so `npm version` agrees with CI.

### Rules

- **Never run `git push --tags`** — it would push all 39 upstream tags to `origin`.
  Push one tag explicitly: `git push origin skills-v0.2.0`.
- Stop importing new upstream tags: `git config remote.upstream.tagOpt --no-tags`
  (already-imported local `v1.x` tags are harmless once `--match` is used, and stay
  useful for referencing upstream releases).
- Every published npm version must have a `skills-v*` tag. `0.1.3` shipped untagged;
  the tag was backfilled onto the commit that produced it.

### Realigns orphan old release tags — by design

A realign rebases our patch onto a new upstream base, so the previous `main` commits
stop being ancestors. Their `skills-v*` tags still resolve (a tag keeps its commit
alive), but they are no longer on the current history line:

```bash
git merge-base --is-ancestor skills-v0.1.3 HEAD   # non-zero after a realign
git describe --tags --abbrev=0 --match 'skills-v*' # empty on the first post-realign release
```

This is intentional and has two consequences:

1. **Those orphaned tags are the rollback points** for what was actually published.
   `skills-v0.1.3` is the pre-realign `main`; keep it.
2. **`publish.yml` handles the empty-describe case** by generating the changelog from
   `origin/upstream-main..HEAD` — i.e. our patch — instead of walking into upstream's
   history and reporting their commits as ours. Only the first release after a realign
   takes that path; later ones describe from the previous `skills-v*` tag normally.

### Cutting a release

```bash
pnpm type-check && pnpm build && npx vitest run && pnpm format:check  # all gates
npm version minor                        # writes package.json + creates skills-vX.Y.Z
git push --force-with-lease origin main
git push origin skills-vX.Y.Z            # ← this triggers publish.yml → npm publish
```

`publish.yml` fires only on a `skills-v*` tag push or manual `workflow_dispatch`.
There is no branch trigger: under this rebase model `main` is force-pushed routinely,
and a branch trigger would fire on every one.

### Version line

We version **independently of upstream** (`0.x`), because our package is a different
product with a different audience. Our `0.2.0` containing upstream's `v1.5.20` is
expected and not a mistake. Bump *minor* when a rebase pulls in a substantial upstream
range or changes agent behaviour; *patch* for fixes to our own patch.

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
