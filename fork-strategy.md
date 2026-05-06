# Fork Strategy: fork/custom-workflow vs upstream

## Branch Layout

```
upstream/main              ← vercel-labs/skills (read-only)
    │
    ▼
origin/main                ← mirrors upstream/main exactly
    │
    ▼  rebase onto
fork/custom-workflow       ← our work (never merge upstream, always rebase)
```

**Rule:** `main` always tracks upstream. `fork/custom-workflow` rebases onto `main`. Never merge upstream into the fork branch.

## Files: Conflict Risk Assessment

### Fork-only files (zero conflict risk)

These don't exist upstream — rebases will never touch them:

- `src/import-skills.ts`
- `src/distribute.ts`
- `src/extract-claude-plugins.ts`
- `src/sync-managed.ts`
- `src/skill-intent.ts`
- `src/stow.ts`
- `src/list-agents.ts`
- `cheatsheet.md`

### Shared files (conflict risk)

Upstream modifies these regularly. Expect conflicts on every rebase:

| File | Risk | Why |
|------|------|-----|
| `src/cli.ts` | **HIGH** | Both sides add commands, imports, lock code |
| `src/skill-lock.ts` | **HIGH** | Version drift (v3 upstream vs v4 fork), new fields |
| `src/agents.ts` | **MEDIUM** | Upstream adds new agents frequently |
| `src/installer.ts` | **MEDIUM** | Fork added `distributeSkillToAgents`, upstream may refactor |
| `src/remove.ts` | **MEDIUM** | Both sides modify dry-run and agent handling |
| `src/add.ts` | **LOW** | Minor upstream changes |
| `src/types.ts` | **LOW** | New agent type additions |
| `src/telemetry.ts` | **LOW** | Event format changes |

## When to Sync

### Sync when upstream releases:

- New agent support we want (e.g., a new agent we use)
- Bug fixes in shared commands (`add`, `remove`, `list`)
- Security patches

### Don't sync for:

- Agent additions we don't use (low value, conflict churn)
- Features we've already implemented differently (e.g., lock file, dry-run)
- Cosmetic changes (README, help text)

### Recommended cadence

Every 2-4 weeks, or when a specific upstream commit is needed. Not every upstream commit is worth the rebase cost.

## How to Rebase

### Step 1: Fetch upstream

```bash
git fetch upstream
```

### Step 2: Update main to match upstream

```bash
git checkout main
git merge --ff-only upstream/main
git push origin main
```

If fast-forward fails, upstream force-pushed. Inspect `git log main..upstream/main` before proceeding.

### Step 3: Rebase fork branch

```bash
git checkout fork/custom-workflow
git rebase main
```

### Step 4: Resolve conflicts

Expected conflicts and resolution strategy:

**`src/cli.ts`** — Keep our imports, commands, and help text. Pull in any new upstream command additions.

**`src/skill-lock.ts`** — Keep our v4 schema. Pull in upstream helper functions if added.

**`src/agents.ts`** — Accept upstream's agent list (they add new agents). Our changes are minimal here.

**`src/installer.ts`** — Keep `distributeSkillToAgents`, `getAgentBaseDir`. Pull in upstream refactors to `installSkillForAgent` etc.

**`src/remove.ts`** — Keep our `--dry-run` additions and intent integration. Pull in upstream fixes.

**General rule:** For each conflict, read both sides. Keep fork logic, adopt upstream infrastructure.

### Step 5: Test after rebase

```bash
pnpm obuild                           # must pass
skills agents                         # verify agent list loads
skills extract-claude-plugins --dry-run
skills distribute --dry-run -g -y
skills update -g                      # verify lock file reads correctly
```

### Step 6: Force push

```bash
git push origin fork/custom-workflow --force-with-lease
```

`--force-with-lease` is safe — rejects if someone else pushed to the branch.

## What Changed After Last Sync

Last synced: before commit `83ac874` (fork/custom-workflow fork point from main).

Upstream has 4 commits not yet merged:
- `eec87fd` Update-README
- `b3bceb6` respect local folders when doing project level update (#1079)
- `f2c4b42` package-version-bump
- `f406a4f` Add Hermes Agent support

These touch 8 shared files. Low urgency — sync when convenient.

## Merge vs Rebase Decision

| Situation | Action |
|-----------|--------|
| Regular sync | Rebase onto main |
| Long-lived PR from upstream | Cherry-pick specific commits |
| Massive upstream refactor | Create new branch from main, re-apply fork changes |
| Upstream force-push | Reset main to upstream, rebase fork |

## Disaster Recovery

If rebase goes badly:

```bash
git rebase --abort                     # cancel the rebase
git reflog                             # find pre-rebase commit
git reset --hard <ref>                 # restore to before rebase
```

The fork branch is also pushed to `origin` — `git fetch origin && git reset --hard origin/fork/custom-workflow` as a last resort.
