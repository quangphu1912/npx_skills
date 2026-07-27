# Branch Strategy: `main` (ours) + `upstream-main` (mirror)

## Model

`@phu-le/skills` is a **published fork** of [vercel-labs/skills](https://github.com/vercel-labs/skills). We publish our own scoped package, so `main` IS our product — not a pristine copy of upstream. Upstream is a remote we periodically **merge** enhancements from.

```
vercel-labs/skills   (remote: `upstream`)
        │  fetch + ff-only
        ▼
  upstream-main      ← LOCAL mirror, exact copy of vercel-labs/skills (read-only)
        │  merge (when we want an enhancement)
        ▼
   main              ← OUR release line → publishes @phu-le/skills → origin/main
```

**Why merge, not rebase:** rebasing a published package rewrites history and forces `--force-with-lease` pushes that break `npm install` for anyone depending on a commit. Merge commits preserve history; no force-push, no rewrite. Rebase is the right tool for a private patch-set nobody else tracks — not a published package.

## Remotes & Branches

| Remote | URL | Role |
|--------|-----|------|
| `origin` | `github.com/quangphu1912/npx_skills` | Our fork (push `main` here) |
| `upstream` | `github.com/vercel-labs/skills` | The original (read-only source of enhancements) |

| Branch | Tracks | Purpose |
|--------|--------|---------|
| `main` | `origin/main` | Our custom release line. `npm publish` runs from here. |
| `upstream-main` | `upstream/main` | Exact mirror of vercel-labs/skills. Refresh with ff-only pull. |
| `release` | — | Stale `v0.1.2` snapshot. Kept for history; not actively used. |

## Daily: See How We Differ

```bash
git fetch upstream                                   # refresh remote-tracking refs
git checkout upstream-main && git pull --ff-only     # update the local mirror

git log main..upstream-main                          # ← upstream enhancements we DON'T have yet
git log upstream-main..main                          # ← our customizations over upstream
git diff upstream-main...main                        # ← net change (our product vs original)
```

Review `main..upstream-main` to decide which upstream commits are worth merging (new agents we use, bug fixes in shared commands). Skip agent additions we don't use and features we've implemented differently — they're conflict churn for no value.

## Sync: Pull Upstream Enhancements Into `main`

### Step 1: Refresh the mirror

```bash
git fetch upstream
git checkout upstream-main
git merge --ff-only upstream/main        # mirror must fast-forward; never commit onto it
git push origin upstream-main            # keep the mirror on origin too (optional)
```

If ff-only fails, upstream force-pushed. Inspect `git log upstream-main..upstream/main` before proceeding.

### Step 2: Merge into main

```bash
git checkout main
git merge upstream-main
```

### Step 3: Resolve conflicts

Shared files (high conflict risk):

| File | Risk | Resolution |
|------|------|------------|
| `src/cli.ts` | **HIGH** | Keep our imports/commands/help; adopt new upstream commands and their imports |
| `src/skill-lock.ts` | **HIGH** | Keep our schema; adopt upstream helper additions |
| `src/agents.ts` | **MEDIUM** | Accept upstream's new agents; re-apply our removals (gemini-cli) and reclassifications (codex non-universal) |
| `src/installer.ts` | **MEDIUM** | Keep our `distributeSkillToAgents`/`getAgentBaseDir`; adopt upstream refactors. **Watch for semantic conflicts** — main added a project-level skip-optimization (skips symlinking when the agent's config dir is absent); tests that assume symlink always runs (e.g. `installer-symlink-fallback.test.ts`) must pre-create the agent dir |
| `src/remove.ts` | **MEDIUM** | Keep our `--dry-run`/intent integration; adopt upstream fixes |
| `src/types.ts` | **LOW** | Merge new agent types into the `AgentType` union |
| `src/telemetry.ts` | **LOW** | Event format drift |

Fork-only files (`import-skills.ts`, `distribute.ts`, `extract-claude-plugins.ts`, `sync-managed.ts`, `skill-intent.ts`, `stow.ts`, `list-agents.ts`, `docs/*`) don't exist upstream — zero conflict risk.

**General rule:** for each conflict, read both sides. Keep fork logic, adopt upstream infrastructure. Text-clean auto-merges can still be **semantic conflicts** — always run the full test suite after merging, not just `tsc`.

### Step 4: Test

```bash
npx vitest run                           # must be 456/456 green (the real gate)
npx prettier --check <files-you-edited>  # format only what you touched
```

### Step 5: Push

```bash
git push origin main                     # normal push — no force needed (merge, not rebase)
```

## Sync Cadence

Every 2–4 weeks, or when a specific upstream commit is needed. Not every upstream commit is worth the merge cost. Currently `main` is **153 commits behind** `upstream-main` — sync selectively when an enhancement is worth integrating.

## Disaster Recovery

```bash
git merge --abort                        # cancel a merge in progress
git reflog                               # find a pre-merge state
git reset --hard <ref>                   # restore main to before the merge
```

`origin/main` is the offsite backup — `git fetch origin && git reset --hard origin/main` as a last resort.
