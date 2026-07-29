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
