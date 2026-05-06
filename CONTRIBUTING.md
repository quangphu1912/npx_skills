# Contributing to @phu_le/skills

Thanks for your interest! Here's how to get started.

## Setup

```bash
git clone https://github.com/quangphu1912/npx_skills.git
cd npx_skills
pnpm install
```

Requires Node.js >= 18 and pnpm.

## Development

```bash
pnpm build          # Build the CLI (uses obuild)
pnpm dev <command>  # Run locally via tsx (e.g., pnpm dev list -g)
pnpm test           # Run all tests (vitest)
pnpm type-check     # TypeScript type checking
pnpm format         # Format with Prettier
pnpm format:check   # Check formatting without writing
```

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation changes
- `refactor:` code restructuring
- `test:` adding or updating tests
- `chore:` maintenance tasks

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure tests pass: `pnpm test`
4. Ensure types check: `pnpm type-check`
5. Ensure formatting: `pnpm format:check`
6. Open a PR with a clear description

## Adding a New Agent

1. Add the agent definition to `src/agents.ts`
2. Run `pnpm run -C scripts validate-agents.ts` to validate
3. Run `pnpm run -C scripts sync-agents.ts` to update README.md and package keywords
4. Add tests for the new agent

## Project Structure

See [AGENTS.md](AGENTS.md) for the full architecture overview.

Key files:

- `src/cli.ts` — Main entry point and command routing
- `src/agents.ts` — Agent definitions (50+ agents)
- `src/installer.ts` — Skill installation, symlink/copy logic
- `src/add.ts` — Core add command logic

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
