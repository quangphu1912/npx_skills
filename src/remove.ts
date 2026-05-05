import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readdir, rm, lstat } from 'fs/promises';
import { join } from 'path';
import { agents, detectInstalledAgents } from './agents.ts';
import { track } from './telemetry.ts';
import { removeSkillFromLock, getSkillFromLock, addToRemoved } from './skill-lock.ts';
import type { AgentType } from './types.ts';
import {
  getInstallPath,
  getCanonicalPath,
  getCanonicalSkillsDir,
  sanitizeName,
} from './installer.ts';

export interface RemoveOptions {
  global?: boolean;
  agent?: string[];
  yes?: boolean;
  all?: boolean;
}

export async function removeCommand(skillNames: string[], options: RemoveOptions) {
  const isGlobal = options.global ?? false;
  const cwd = process.cwd();

  const spinner = p.spinner();

  spinner.start('Scanning for installed skills...');
  const skillNamesSet = new Set<string>();

  const scanDir = async (dir: string) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          skillNamesSet.add(entry.name);
        }
      }
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code !== 'ENOENT') {
        p.log.warn(`Could not scan directory ${dir}: ${err.message}`);
      }
    }
  };

  if (isGlobal) {
    // Only scan the canonical dir — never scan agent-specific globalSkillsDirs.
    // Agent-specific dirs may contain stow-managed or tool-native skills
    // that were NOT installed by this CLI. Scanning them causes destructive
    // collateral damage (see: npx skills remove --all -g -y incident).
    await scanDir(getCanonicalSkillsDir(true, cwd));
  } else {
    await scanDir(getCanonicalSkillsDir(false, cwd));
    for (const agent of Object.values(agents)) {
      await scanDir(join(cwd, agent.skillsDir));
    }
  }

  const installedSkills = Array.from(skillNamesSet).sort();
  spinner.stop(`Found ${installedSkills.length} unique installed skill(s)`);

  if (installedSkills.length === 0) {
    p.outro(pc.yellow('No skills found to remove.'));
    return;
  }

  // Validate agent options BEFORE prompting for skill selection
  if (options.agent && options.agent.length > 0) {
    const validAgents = Object.keys(agents);
    const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));

    if (invalidAgents.length > 0) {
      p.log.error(`Invalid agents: ${invalidAgents.join(', ')}`);
      p.log.info(`Valid agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }
  }

  let selectedSkills: string[] = [];

  if (options.all) {
    selectedSkills = installedSkills;
  } else if (skillNames.length > 0) {
    selectedSkills = installedSkills.filter((s) =>
      skillNames.some((name) => name.toLowerCase() === s.toLowerCase())
    );

    if (selectedSkills.length === 0) {
      p.log.error(`No matching skills found for: ${skillNames.join(', ')}`);
      return;
    }
  } else {
    const choices = installedSkills.map((s) => ({
      value: s,
      label: s,
    }));

    const selected = await p.multiselect({
      message: `Select skills to remove ${pc.dim('(space to toggle)')}`,
      options: choices,
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel('Removal cancelled');
      process.exit(0);
    }

    selectedSkills = selected as string[];
  }

  let targetAgents: AgentType[];
  if (options.agent && options.agent.length > 0) {
    targetAgents = options.agent as AgentType[];
  } else {
    // When removing, we should target all known agents to ensure
    // ghost symlinks are cleaned up, even if the agent is not detected.
    targetAgents = Object.keys(agents) as AgentType[];
    spinner.stop(`Targeting ${targetAgents.length} potential agent(s)`);
  }

  if (!options.yes) {
    console.log();
    p.log.info('Skills to remove:');
    for (const skill of selectedSkills) {
      p.log.message(`  ${pc.red('•')} ${skill}`);
    }
    console.log();

    const confirmed = await p.confirm({
      message: `Are you sure you want to uninstall ${selectedSkills.length} skill(s)?`,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Removal cancelled');
      process.exit(0);
    }
  }

  spinner.start('Removing skills...');

  const results: {
    skill: string;
    success: boolean;
    source?: string;
    sourceType?: string;
    error?: string;
  }[] = [];

  for (const skillName of selectedSkills) {
    try {
      const canonicalPath = getCanonicalPath(skillName, { global: isGlobal, cwd });

      for (const agentKey of targetAgents) {
        const agent = agents[agentKey];
        const skillPath = getInstallPath(skillName, agentKey, { global: isGlobal, cwd });

        // For global removes, only clean up agent-specific symlinks — never
        // follow stow symlinks into agent globalSkillsDirs (e.g. ~/.claude/skills
        // is a stow symlink to dotfiles; rm -rf through it destroys real files).
        if (!isGlobal) {
          const pathsToCleanup = new Set([skillPath]);
          const sanitizedName = sanitizeName(skillName);
          pathsToCleanup.add(join(cwd, agent.skillsDir, sanitizedName));

          for (const pathToCleanup of pathsToCleanup) {
            if (pathToCleanup === canonicalPath) {
              continue;
            }

            try {
              const stats = await lstat(pathToCleanup).catch(() => null);
              if (stats) {
                await rm(pathToCleanup, { recursive: true, force: true });
              }
            } catch (err) {
              p.log.warn(
                `Could not remove skill from ${agent.displayName}: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          }
        } else {
          // Global: only remove symlinks from agent globalSkillsDirs, not real content.
          // Agent-specific dirs may contain stow-managed or tool-native skills that
          // were NOT installed by this CLI.
          const sanitizedName = sanitizeName(skillName);
          if (agent.globalSkillsDir) {
            const agentSkillPath = join(agent.globalSkillsDir, sanitizedName);
            if (agentSkillPath !== canonicalPath) {
              try {
                const stats = await lstat(agentSkillPath).catch(() => null);
                // Only remove symlinks, never real directories in agent-specific dirs.
                if (stats?.isSymbolicLink()) {
                  await rm(agentSkillPath, { force: true });
                }
              } catch (err) {
                p.log.warn(
                  `Could not remove symlink from ${agent.displayName}: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                );
              }
            }
          }
        }
      }

      // Agent-scoped removes (--agent foo) only clean per-agent symlinks.
      // Canonical is only removed for full global removes (no --agent scope).
      const isFullRemove = !options.agent || options.agent.length === 0;

      let canonicalDeleted = false;
      if (isFullRemove) {
        // Check if any remaining agent still has the skill before removing canonical.
        const installedAgents = await detectInstalledAgents();
        const remainingAgents = installedAgents.filter((a) => !targetAgents.includes(a));

        let isStillUsed = false;
        for (const agentKey of remainingAgents) {
          const path = getInstallPath(skillName, agentKey, { global: isGlobal, cwd });
          const exists = await lstat(path).catch(() => null);
          if (exists) {
            isStillUsed = true;
            break;
          }
        }

        if (!isStillUsed) {
          const canonicalStat = await lstat(canonicalPath).catch(() => null);
          if (canonicalStat?.isSymbolicLink()) {
            // Imported skill — unlink the symlink only; never follow into the source
            await rm(canonicalPath, { force: true });
            canonicalDeleted = true;
          } else if (canonicalStat?.isDirectory()) {
            // Plugin extraction or GitHub install — remove the actual directory
            await rm(canonicalPath, { recursive: true, force: true });
            canonicalDeleted = true;
          }
        }
      }

      const lockEntry = isGlobal ? await getSkillFromLock(skillName) : null;
      const effectiveSource = lockEntry?.source || 'local';
      const effectiveSourceType = lockEntry?.sourceType || 'local';

      if (isGlobal) {
        await removeSkillFromLock(skillName);
        // Only track as removed when canonical was fully deleted (full global remove, not agent-scoped).
        if (canonicalDeleted) {
          await addToRemoved(skillName, effectiveSource);
        }
      }

      results.push({
        skill: skillName,
        success: true,
        source: effectiveSource,
        sourceType: effectiveSourceType,
      });
    } catch (err) {
      results.push({
        skill: skillName,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  spinner.stop('Removal process complete');

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  // Track removal (grouped by source)
  if (successful.length > 0) {
    const bySource = new Map<string, { skills: string[]; sourceType?: string }>();

    for (const r of successful) {
      const source = r.source || 'local';
      const existing = bySource.get(source) || { skills: [] };
      existing.skills.push(r.skill);
      existing.sourceType = r.sourceType;
      bySource.set(source, existing);
    }

    for (const [source, data] of bySource) {
      track({
        event: 'remove',
        source,
        skills: data.skills.join(','),
        agents: targetAgents.join(','),
        ...(isGlobal && { global: '1' }),
        sourceType: data.sourceType,
      });
    }
  }

  if (successful.length > 0) {
    p.log.success(pc.green(`Successfully removed ${successful.length} skill(s)`));
  }

  if (failed.length > 0) {
    p.log.error(pc.red(`Failed to remove ${failed.length} skill(s)`));
    for (const r of failed) {
      p.log.message(`  ${pc.red('✗')} ${r.skill}: ${r.error}`);
    }
  }

  console.log();
  p.outro(pc.green('Done!'));
}

/**
 * Parse command line options for the remove command.
 * Separates skill names from options flags.
 */
export function parseRemoveOptions(args: string[]): { skills: string[]; options: RemoveOptions } {
  const options: RemoveOptions = {};
  const skills: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      i++;
      let nextArg = args[i];
      while (i < args.length && nextArg && !nextArg.startsWith('-')) {
        options.agent.push(nextArg);
        i++;
        nextArg = args[i];
      }
      i--; // Back up one since the loop will increment
    } else if (arg && !arg.startsWith('-')) {
      skills.push(arg);
    }
  }

  return { skills, options };
}
