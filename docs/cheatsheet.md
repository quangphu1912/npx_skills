# Skills CLI Cheatsheet

All skills start in Claude Code's `~/.claude/skills/`. The canonical store at `~/.agents/skills/` is the master copy that all agents read from.

## Data Flow

```
~/.claude/skills/          ← SOURCE (custom skills live here)
~/.claude/plugins/cache/   ← SOURCE (plugin skills cached here)
       │
       │  skills import / extract-claude-plugins
       ▼
~/.agents/skills/          ← CANONICAL (master store, symlinked or copied)
       │
       │  skills distribute
       ▼
~/.qwen/skills/            ← TARGET (symlinks back to canonical)
~/.kilocode/skills/
~/.kiro/skills/
~/.codeium/windsurf/skills/
```

Universal agents (Codex, Cursor, Gemini CLI, OpenCode, Antigravity) read `~/.agents/skills/` directly — no symlinks needed.

Claude Code is excluded from distribute — it IS the source.

## Commands

### Add a new custom skill

```bash
# Create the skill in Claude Code first
skills init my-skill                  # or write SKILL.md manually

# Import to canonical store
skills import ~/.claude/skills/my-skill -g -y

# Fan out to all agents
skills distribute -g -y
```

### Bulk import all Claude Code skills

```bash
for s in ~/.claude/skills/*/; do skills import "$s" -g -y; done
```

### Extract plugin skills

```bash
# After installing/updating a Claude Code plugin:
skills extract-claude-plugins -y      # copies plugin skills to canonical
skills distribute -g -y               # fan out to agents
```

Filters to only enabled plugins (from `~/.claude/settings.json` `enabledPlugins`).

### One-step sync (import + distribute)

```bash
# Requires watchedDirs in ~/.agents/.skill-config.json
skills managed-sync -g -y
```

### Remove a skill

```bash
skills remove <name> -g -y            # removes from canonical + all agents
                                        # source in ~/.claude/skills/ stays safe
skills distribute -g -y               # prune any dangling symlinks
```

### Preview before running

Every destructive command supports `--dry-run`:

```bash
skills import <path> -g --dry-run
skills distribute --dry-run -g -y
skills extract-claude-plugins --dry-run
skills remove <name> -g --dry-run -y
skills managed-sync --dry-run -g -y
```

### Inspect state

```bash
skills agents                         # list all agents and install status
skills list -g                        # list all skills in canonical store
skills distribute --dry-run -g -y     # preview: shows all skills and symlink state
```

## Key Paths

| What | Path | Type |
|------|------|------|
| Custom skills source | `~/.claude/skills/<name>/` | real dir |
| Plugin cache | `~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/skills/` | real dir |
| Canonical store | `~/.agents/skills/<name>` | symlink → claude source |
| Plugin extractions | `~/.agents/skills/<plugin>-<skill>` | copy from plugin cache |
| Agent skills | `~/.<agent>/skills/<name>` | symlink → canonical |
| Lock file | `~/.agents/.skill-lock.json` | v4, install state only |
| Intent file | `~/.agents/.skill-intent.json` | removed/dismissed sets |
| Config | `~/.agents/.skill-config.json` | stow, watchedDirs, autoGit |

## Common Scenarios

| Scenario | Commands |
|----------|----------|
| New skill in Claude Code | `skills import ~/.claude/skills/<name> -g -y && skills distribute -g -y` |
| Updated a plugin | `skills extract-claude-plugins -y && skills distribute -g -y` |
| New machine setup | Bulk import + extract + distribute |
| Remove everywhere | `skills remove <name> -g -y` |
| Check what changed | `skills distribute --dry-run -g -y` |
| Re-sync everything | `skills managed-sync -g -y` |
