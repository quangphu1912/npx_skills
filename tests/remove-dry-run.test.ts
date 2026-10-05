/**
 * `remove --dry-run` must leave the lock and the removed-intent list alone.
 *
 * The filesystem `rm` calls in remove.ts are gated on `!dryRun`, but the lock
 * and intent writes sit in a block upstream also edits. A rebase once resolved
 * that conflict to upstream's `if (!isStillUsed)` and silently dropped the
 * fork's `!dryRun`, so a dry run deleted the lock entry and recorded the skill
 * as removed. This test is the detector for that drop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, lstat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { removeCommand } from '../src/remove.ts';
import { addSkillToLocalLock, readLocalLock } from '../src/local-lock.ts';
import * as agentsModule from '../src/agents.ts';
import * as intentModule from '../src/skill-intent.ts';

vi.mock('../src/agents.ts', async () => {
  const actual = await vi.importActual('../src/agents.ts');
  return { ...actual, detectInstalledAgents: vi.fn() };
});

// The intent file lives under the real home; never let a test write to it.
vi.mock('../src/skill-intent.ts', async () => {
  const actual = await vi.importActual('../src/skill-intent.ts');
  return { ...actual, addToRemoved: vi.fn() };
});

describe('removeCommand --dry-run', () => {
  const skillName = 'dry-run-remove-skill';
  let tempDir: string;
  let oldCwd: string;
  let canonicalPath: string;
  let claudePath: string;

  beforeEach(async () => {
    tempDir = resolve(join(tmpdir(), 'skills-remove-dry-run-' + Date.now()));
    canonicalPath = join(tempDir, '.agents/skills', skillName);
    claudePath = join(tempDir, '.claude/skills', skillName);
    await mkdir(canonicalPath, { recursive: true });
    await mkdir(join(tempDir, '.claude/skills'), { recursive: true });
    await writeFile(join(canonicalPath, 'SKILL.md'), '# Test');
    await symlink(canonicalPath, claudePath, 'junction');
    await addSkillToLocalLock(
      skillName,
      { source: 'local/test', sourceType: 'local', computedHash: 'test' },
      tempDir
    );

    oldCwd = process.cwd();
    process.chdir(tempDir);
    vi.mocked(agentsModule.detectInstalledAgents).mockResolvedValue(['claude-code']);
    vi.mocked(intentModule.addToRemoved).mockClear();
  });

  afterEach(async () => {
    process.chdir(oldCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('leaves files, the lock entry and the removed-intent list untouched', async () => {
    // Full remove (no --agent): the path that deletes the canonical copy for real.
    await removeCommand([skillName], { yes: true, dryRun: true });

    expect((await lstat(canonicalPath)).isDirectory()).toBe(true);
    expect(await lstat(claudePath).catch(() => null)).not.toBeNull();
    expect((await readLocalLock(tempDir)).skills[skillName]).toBeDefined();
    expect(intentModule.addToRemoved).not.toHaveBeenCalled();
  });

  it('does all three for real without --dry-run (proves the setup)', async () => {
    await removeCommand([skillName], { yes: true });

    expect(await lstat(canonicalPath).catch(() => null)).toBeNull();
    expect((await readLocalLock(tempDir)).skills[skillName]).toBeUndefined();
    expect(intentModule.addToRemoved).toHaveBeenCalledWith(skillName, expect.any(String));
  });
});
