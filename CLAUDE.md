# CLAUDE.md

See @AGENTS.md for architecture, commands, and development guidance for this repo.

Two things worth knowing before you change anything here:

- This is a **fork** of `vercel-labs/skills`, published as `@phu-le/skills`. Our
  customizations are a thin patch rebased on top of upstream. Read
  [docs/fork-strategy.md](docs/fork-strategy.md) before touching a file that also
  exists upstream — some of our changes are easy to lose in a rebase.
- Releases are tagged **`skills-v<version>`**, not `v<version>`. Upstream's `v1.x`
  tags are ancestors of our history and will hijack a bare `git describe`.
