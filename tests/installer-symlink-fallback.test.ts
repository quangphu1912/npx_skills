/**
 * Tests the symlink→copy fallback path in installSkillForAgent.
 *
 * When symlink creation fails (e.g. EPERM on a filesystem that doesn't support
 * symlinks), the installer must:
 *   1. Fall back to copy mode (files land on disk at the agent path)
 *   2. Return symlinkFailed: true
 *   3. Still return success: true
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Partial mock: pass through all fs/promises functions except `symlink`,
// which we replace with an EPERM-throwing stub.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    symlink: vi.fn(),
  };
});

// Also mock the non-namespaced 'fs/promises' import used by installer.ts
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    symlink: vi.fn(),
  };
});

import { installSkillForAgent } from '../src/installer.ts';

const mockedSymlink = vi.mocked(fsp.symlink);

async function makeSkillSource(root: string, name: string): Promise<string> {
  const dir = join(root, 'source-skill');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`, 'utf-8');
  return dir;
}

describe('installer symlink→copy fallback', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(join(tmpdir(), 'add-skill-fallback-'));
    const epermError = Object.assign(new Error('EPERM: operation not permitted, symlink'), {
      code: 'EPERM',
    });
    mockedSymlink.mockRejectedValue(epermError);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('falls back to copy when symlink throws EPERM', async () => {
    const projectDir = join(root, 'project');
    await fsp.mkdir(projectDir, { recursive: true });

    const skillName = 'fallback-skill';
    const skillDir = await makeSkillSource(root, skillName);

    // claude-code has skillsDir '.claude/skills' which differs from the canonical
    // '.agents/skills', so createSymlink is actually invoked (unlike universal agents
    // such as 'amp' whose canonical and agent dirs are the same path).
    const result = await installSkillForAgent(
      { name: skillName, description: 'test', path: skillDir },
      'claude-code',
      { cwd: projectDir, mode: 'symlink', global: false }
    );

    // 1. Install must succeed overall
    expect(result.success).toBe(true);

    // 2. symlinkFailed flag must be set
    expect(result.symlinkFailed).toBe(true);

    // 3. Files must actually be on disk at the agent path (copy happened)
    const agentSkillPath = join(projectDir, '.claude/skills', skillName);
    const contents = await fsp.readFile(join(agentSkillPath, 'SKILL.md'), 'utf-8');
    expect(contents).toContain(`name: ${skillName}`);

    // Verify symlink was attempted (not silently skipped)
    expect(mockedSymlink).toHaveBeenCalled();
  });

  it('copied directory is a real directory, not a symlink', async () => {
    const projectDir = join(root, 'project');
    await fsp.mkdir(projectDir, { recursive: true });

    const skillName = 'fallback-dir-skill';
    const skillDir = await makeSkillSource(root, skillName);

    const result = await installSkillForAgent(
      { name: skillName, description: 'test', path: skillDir },
      'claude-code',
      { cwd: projectDir, mode: 'symlink', global: false }
    );

    expect(result.success).toBe(true);
    expect(result.symlinkFailed).toBe(true);

    const agentSkillPath = join(projectDir, '.claude/skills', skillName);
    const stats = await fsp.lstat(agentSkillPath);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
  });
});
