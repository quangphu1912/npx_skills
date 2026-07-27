/**
 * Tests that --dry-run is a true filesystem no-op in distributeSkillToAgents.
 *
 * Strategy:
 *  - Use a non-universal agent (claude-code, skillsDir: '.claude/skills') so
 *    distributeSkillToAgents actually attempts to write into the agent dir.
 *  - Canonical dir: <projectDir>/.agents/skills/<skillName>
 *  - Agent dir:     <projectDir>/.claude/skills/<skillName>  (the symlink target)
 *
 * With dryRun: true  → agent dir must not contain the skill
 * With dryRun: false → agent dir must contain the skill (proves setup is correct)
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { distributeSkillToAgents } from '../src/installer.ts';

async function createCanonicalSkill(projectDir: string, skillName: string): Promise<void> {
  const canonicalSkillDir = join(projectDir, '.agents', 'skills', skillName);
  await mkdir(canonicalSkillDir, { recursive: true });
  await writeFile(
    join(canonicalSkillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: test\n---\n`,
    'utf-8'
  );
}

describe('dry-run is a filesystem no-op', () => {
  it('does not write to agent dir when dryRun: true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    const skillName = 'dry-run-test-skill';
    await createCanonicalSkill(projectDir, skillName);

    try {
      const results = await distributeSkillToAgents(skillName, ['claude-code'], {
        isGlobal: false,
        cwd: projectDir,
        dryRun: true,
      });

      // Function should report 'created' intent without touching the filesystem
      expect(results).toHaveLength(1);
      expect(results[0].agent).toBe('claude-code');
      expect(results[0].action).toBe('created');
      expect(results[0].error).toBeUndefined();

      // The agent skills dir must not exist — no mkdir, no symlink
      const agentSkillPath = join(projectDir, '.claude', 'skills', skillName);
      const stat = await lstat(agentSkillPath).catch(() => null);
      expect(stat).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does write to agent dir when dryRun: false (proves setup is correct)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });

    const skillName = 'dry-run-test-skill';
    await createCanonicalSkill(projectDir, skillName);

    try {
      const results = await distributeSkillToAgents(skillName, ['claude-code'], {
        isGlobal: false,
        cwd: projectDir,
        dryRun: false,
      });

      expect(results).toHaveLength(1);
      expect(results[0].agent).toBe('claude-code');
      expect(results[0].action).toBe('created');
      expect(results[0].error).toBeUndefined();

      // The symlink must exist in the agent dir
      const agentSkillPath = join(projectDir, '.claude', 'skills', skillName);
      const stat = await lstat(agentSkillPath);
      expect(stat.isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
