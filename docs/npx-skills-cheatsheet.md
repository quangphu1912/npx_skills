# npx skills Cheatsheet

Native upstream commands for discovering, installing, and managing agent skills.

> For multi-agent sync commands (`import`, `distribute`, `extract-claude-plugins`, `managed-sync`), see [cheatsheet.md](cheatsheet.md).

## Discover Skills

```bash
npx skills find                          # interactive fzf-style search
npx skills find typescript               # search by keyword
npx skills find pr review                # multi-word search
```

Browse the full directory at **https://skills.sh**

## Install Skills

```bash
# GitHub shorthand
npx skills add vercel-labs/agent-skills

# Install specific skills from a repo
npx skills add vercel-labs/agent-skills --skill frontend-design
npx skills add vercel-labs/agent-skills --skill frontend-design --skill skill-creator

# List available skills before installing
npx skills add vercel-labs/agent-skills --list

# Global install (available across all projects)
npx skills add vercel-labs/agent-skills -g

# Install to specific agent(s)
npx skills add vercel-labs/agent-skills -a claude-code
npx skills add vercel-labs/agent-skills -a claude-code -a opencode

# Non-interactive (CI-friendly)
npx skills add vercel-labs/agent-skills --skill frontend-design -g -a claude-code -y

# Install all skills from a repo
npx skills add vercel-labs/agent-skills --all
```

### Source formats

```bash
npx skills add vercel-labs/agent-skills                              # GitHub shorthand
npx skills add https://github.com/vercel-labs/agent-skills          # full URL
npx skills add git@github.com:vercel-labs/agent-skills.git          # SSH
npx skills add ./my-local-skill                                      # local path
```

## List Installed Skills

```bash
npx skills list                          # all installed (project + global)
npx skills ls -g                         # global only
npx skills ls -a claude-code             # filter by agent
npx skills ls -a claude-code -a cursor   # multiple agents
```

## Update Skills

```bash
npx skills update                        # all skills (prompts for scope)
npx skills update -g                     # global skills only
npx skills update my-skill              # specific skill by name
npx skills update frontend-design web-design-guidelines   # multiple
npx skills update -y                     # skip scope prompt (auto-detect)
```

## Remove Skills

```bash
npx skills remove                        # interactive picker
npx skills remove my-skill              # by name
npx skills remove my-skill -g           # from global scope
npx skills remove my-skill -a claude-code  # from specific agent
npx skills remove --all                  # remove everything
npx skills rm my-skill                   # alias
```

## Create a Skill

```bash
npx skills init                          # SKILL.md in current dir
npx skills init my-skill                 # create in new subdirectory
```

Minimal `SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does and when to activate it
---

# My Skill

Instructions for the agent to follow.
```

## Installation Scope

| Scope | Flag | Location |
|---|---|---|
| Project | (default) | `./<agent>/skills/` — committed with repo |
| Global | `-g` | `~/<agent>/skills/` — all projects |

## Common Workflows

| Task | Command |
|---|---|
| Find a skill | `npx skills find <query>` |
| Install globally | `npx skills add <repo> -g -y` |
| Install specific skill | `npx skills add <repo> --skill <name> -g -y` |
| See what's installed | `npx skills ls -g` |
| Keep skills fresh | `npx skills update -g -y` |
| Remove a skill | `npx skills remove <name> -g -y` |
| Scaffold a new skill | `npx skills init <name>` |
