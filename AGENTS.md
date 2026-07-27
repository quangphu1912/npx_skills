# AGENTS.md

This file provides guidance to AI coding agents working on the `skills` CLI codebase.

**Reference docs:**

- [docs/npx-skills-cheatsheet.md](docs/npx-skills-cheatsheet.md) — Native `npx skills` command reference
- [docs/cheatsheet.md](docs/cheatsheet.md) — Multi-agent sync workflow (import, distribute, extract)
- [docs/fork-strategy.md](docs/fork-strategy.md) — Branch model and upstream sync (merge-based)

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
├── agents.ts                 # Agent definitions (55 agents), detection, universal/non-universal
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
├── source-parser.ts          # Parse git URLs, GitHub shorthand, local paths
├── git.ts                    # Git clone operations
├── telemetry.ts              # Anonymous usage tracking
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

Universal agents (Codex, Cursor, Gemini CLI, OpenCode, Antigravity) have `skillsDir === '.agents/skills'` — they read the canonical store directly, no symlinks needed.

Non-universal agents (Qwen, Kiro, KiloCode, Windsurf, etc.) get per-skill symlinks from their skills dir back to `~/.agents/skills/<name>` via `distribute`.

### Intent/Lock Split

- **Lock file** (`~/.agents/.skill-lock.json`, v4): Installation state only — what's installed, source, version
- **Intent file** (`~/.agents/.skill-intent.json`): User decisions — removed skills, dismissed prompts, last selected agents

Lock file wipes on version mismatch (v3 → v4 loses upstream `skills add` tracking). Accepted tradeoff.

### Atomic Symlink Replacement

`distributeSkillToAgents()` uses `symlink(tmp)` + `rename()` on POSIX for atomic symlink updates. Windows falls back to non-atomic rm + symlink.

### Plugin Filtering

`extract-claude-plugins` reads `enabledPlugins` from `~/.claude/settings.json` and only extracts skills from enabled plugins. Disabled plugins are skipped.

## Development

```bash
pnpm install           # Install dependencies
pnpm obuild            # Build (fast, uses obuild)
pnpm test              # Run all tests
pnpm format            # Format with Prettier
pnpm type-check        # TypeScript type checking
pnpm dev <command>     # Run locally via tsx
```

## Publishing

```bash
# 1. Bump version in package.json
# 2. Build
pnpm obuild
# 3. Publish
npm publish
```

## Adding a New Agent

1. Add the agent definition to `src/agents.ts`
2. Run `pnpm run -C scripts validate-agents.ts` to validate
3. Run `pnpm run -C scripts sync-agents.ts` to update README.md and package keywords
