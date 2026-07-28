# AGENTS.md

This file provides guidance to AI coding agents working on the `skills` CLI codebase.

**Reference docs:**

- [docs/npx-skills-cheatsheet.md](docs/npx-skills-cheatsheet.md) — Native `npx skills` command reference
- [docs/cheatsheet.md](docs/cheatsheet.md) — Multi-agent sync workflow (import, distribute, extract)
- [docs/fork-strategy.md](docs/fork-strategy.md) — Branch model, upstream sync (rebase / patch-on-top), and releasing

## Project Overview

Fork of `vercel-labs/skills` CLI with custom commands for syncing skills across multiple AI agents via a canonical master store pattern.

**Core architecture:** Skills live in `~/.claude/skills/` (Claude Code is the source). The canonical store at `~/.agents/skills/` holds symlinks (custom skills) and copies (plugin extractions). Non-universal agents get per-skill symlinks via `distribute`.

## Commands

| Command                         | Description                                         |
| ------------------------------- | --------------------------------------------------- |
| `skills`                        | Show banner with available commands                 |
| `skills add <pkg>`              | Install skills from git repos, URLs, or local paths |
| `skills use <pkg>@<skill>`      | Use one skill without installing                    |
| `skills experimental_install`   | Restore skills from skills-lock.json                |
| `skills experimental_sync`      | Sync skills from node_modules into agent dirs       |
| `skills list`                   | List installed skills (alias: `ls`)                 |
| `skills update [skills...]`     | Update skills to latest versions                    |
| `skills init [name]`            | Create a new SKILL.md template                      |
| `skills remove [skills]`        | Remove installed skills                             |
| `skills find [query]`           | Search for skills interactively                     |
| `skills import <path>`          | Import local skill(s) to master store (symlink)     |
| `skills distribute`             | Distribute master skills to all agents via symlinks |
| `skills managed-sync`           | Import from watched dirs + distribute in one step   |
| `skills extract-claude-plugins` | Extract Claude plugin skills to master store        |
| `skills agents`                 | List all supported agents and install status        |

All destructive commands support `--dry-run` to preview changes.

## Architecture

```
src/
├── cli.ts                    # Main entry point, command routing, update logic
├── add.ts                    # Core add command logic
├── constants.ts              # Shared constants (AGENTS_DIR, SKILLS_SUBDIR)
├── agents.ts                 # Agent definitions (74 agents), detection, universal/non-universal
├── types.ts                  # TypeScript types (AgentType, Skill, RemoteSkill)
├── installer.ts              # Skill installation, symlink/copy, distributeSkillToAgents(), atomic symlink
├── skills.ts                 # Skill discovery and SKILL.md parsing
├── skill-lock.ts             # Global lock file v4 (~/.agents/.skill-lock.json), install state only
├── skill-intent.ts           # User intent file (~/.agents/.skill-intent.json), removed/dismissed sets
├── local-lock.ts             # Project lock file (skills-lock.json, checked in)
├── import-skills.ts          # Import skills to canonical store via symlink or copy
├── distribute.ts             # Fan out canonical skills to non-universal agents
├── extract-claude-plugins.ts # Extract skills from Claude Code plugin cache, filter by enabled
├── sync-managed.ts           # Combine import + distribute for watched dirs
├── remove.ts                 # Remove skills from canonical + agent dirs
├── list-agents.ts            # List all agents with install status
├── stow.ts                   # GNU Stow detection, git staging, findGitRepo()
├── sync.ts                   # Sync command - crawl node_modules for skills
├── find.ts                   # Find/search command
├── list.ts                   # List installed skills command
├── install.ts                # experimental_install - restore from skills-lock.json
├── update.ts                 # Update command (extracted from cli.ts upstream)
├── detect-agent.ts           # Detect the agent env we're running inside
├── source-parser.ts          # Parse git URLs, GitHub shorthand, local paths
├── github-host.ts            # GH_HOST / GitHub Enterprise resolution
├── git.ts                    # Git clone operations
├── frontmatter.ts            # SKILL.md YAML frontmatter parsing
├── plugin-manifest.ts        # Claude plugin manifest discovery
├── telemetry.ts              # No-op stubs — telemetry removed in this fork
├── sanitize.ts               # Output sanitization
├── update-source.ts          # Build update URLs for re-installation
├── blob.ts                   # GitHub Trees API, blob download
├── prompts/                  # Interactive prompt helpers
│   └── search-multiselect.ts
├── providers/       # Remote skill providers (GitHub, HuggingFace, Mintlify)
│   ├── index.ts
│   ├── registry.ts
│   ├── types.ts
│   ├── huggingface.ts
│   ├── mintlify.ts
│   └── wellknown.ts
├── init.test.ts     # Init command tests
├── use.ts           # Use command - generate a skill prompt or launch an agent
├── use.test.ts      # Use command tests
└── test-utils.ts    # Test utilities

tests/
├── cross-platform-paths.test.ts # Path normalization across platforms
├── full-depth-discovery.test.ts # --full-depth skill discovery tests
├── openclaw-paths.test.ts       # OpenClaw-specific path tests
├── plugin-manifest-discovery.test.ts # Plugin manifest skill discovery
├── sanitize-name.test.ts     # Tests for sanitizeName (path traversal prevention)
├── skill-matching.test.ts    # Tests for filterSkills (multi-word skill name matching)
├── source-parser.test.ts     # Tests for URL/path parsing
├── installer-symlink.test.ts # Tests for symlink installation
├── list-installed.test.ts    # Tests for listing installed skills
├── skill-path.test.ts        # Tests for skill path handling
├── wellknown-provider.test.ts # Tests for well-known provider
├── xdg-config-paths.test.ts   # XDG global path handling tests
└── dist.test.ts               # Tests for built distribution
```

## Key Concepts

### Universal vs Non-Universal Agents

Universal agents (17 of 74 — Cursor, OpenCode, Antigravity, Zed, GitHub Copilot, Warp, Amp, Cline, …) have `skillsDir === '.agents/skills'` — they read the canonical store directly, no symlinks needed.

Non-universal agents (Codex, Qwen, Kiro, KiloCode, Windsurf, etc.) get per-skill symlinks from their skills dir back to `~/.agents/skills/<name>` via `distribute`.

Two fork-specific deviations from upstream's registry — keep these through rebases:

- **Codex is non-universal here.** Its binary reads `_codex_home()/skills` (`~/.codex/skills`), not the hub, so `skillsDir` is `.codex/skills` and `distribute` must symlink into it. Upstream classes it universal, which silently gave Codex zero hub skills.
- **`gemini-cli` is removed.** Google deprecated consumer sign-in on 2026-06-18. It is gone from `AgentType`, so any upstream code referencing it (e.g. `detect-agent.ts`'s agent map) must be remapped to `universal` on rebase.

### Intent/Lock Split

- **Lock file** (`~/.agents/.skill-lock.json`, v4): Installation state only — what's installed, source, version
- **Intent file** (`~/.agents/.skill-intent.json`): User decisions — removed skills, dismissed prompts, last selected agents

Lock file wipes on version mismatch (v3 → v4 loses upstream `skills add` tracking). Accepted tradeoff.

### Removal Semantics — `remove` deletes the master, on purpose

`remove` deletes the skill from the Claude master (`~/.claude/skills/<name>`, typically
a stow symlink into a dotfiles repo) in addition to the hub and every agent symlink.

**This is intended, not a bug.** The master is the authoring source, and `managed-sync`
imports *from* it — so a removal that spared the master would be undone by the very next
sync. Deleting it is the only removal that sticks. It is git-recoverable
(`git checkout -- .claude/skills/`) precisely because the master is version-controlled.

Do not "fix" this by making `remove` preserve `~/.claude/skills/<name>`. That reintroduces
skills on the next `managed-sync` and leaves the hub fighting the master.

One consequence worth knowing: `scanDir()` in `remove.ts` counts only `entry.isDirectory()`,
which is **false for symlinks** — and this fork's hub and agent dirs are entirely symlinks.
Disk scanning alone therefore finds nothing here; removal works because requests are also
resolved against lock keys (`resolveSkillsToRemove`). Before that resolution existed,
`remove <name> -g` was a silent no-op for every imported skill.

`remove` fans out to all agents itself, so no separate `distribute` is needed afterwards.

### Atomic Symlink Replacement

`distributeSkillToAgents()` uses `symlink(tmp)` + `rename()` on POSIX for atomic symlink updates. Windows falls back to non-atomic rm + symlink.

### Plugin Filtering

`extract-claude-plugins` reads `enabledPlugins` from `~/.claude/settings.json` and only extracts skills from enabled plugins. Disabled plugins are skipped.

## Development

```bash
pnpm install           # Install dependencies
pnpm build             # Build (obuild)
pnpm test              # Run all tests (vitest)
pnpm format            # Format with Prettier
pnpm format:check      # Verify formatting (CI gate)
pnpm type-check        # TypeScript type checking (CI gate)
pnpm dev <command>     # Run locally from source
```

CI gates both `type-check` and `format:check`, so run them before pushing.

Four test failures are expected locally and are environment-only — they also fail
on a pristine `upstream-main` checkout:

- `src/detect-agent.test.ts` (3) — Cursor detection, depends on the host agent env
- `tests/git-lfs-clone.test.ts` (1) — LFS fixture git config

A fifth failure means a real regression.

## Releasing

Releases are cut from tags named **`skills-v<version>`** — never bare `v<version>`,
which collides with the 39 upstream tags in this repo's history. Never run
`git push --tags`. Full procedure and rationale:
[docs/fork-strategy.md](docs/fork-strategy.md#releasing--tagging).

## Adding a New Agent

1. Add the agent definition to `src/agents.ts`
2. Run `pnpm run -C scripts validate-agents.ts` to validate
3. Run `pnpm run -C scripts sync-agents.ts` to update README.md and package keywords
