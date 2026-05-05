import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readdir, lstat, symlink, rm, mkdir, realpath } from 'fs/promises';
import { join, resolve, relative, dirname } from 'path';
import { homedir } from 'os';
import {
  getCanonicalSkillsDir,
  getAgentBaseDir,
  sanitizeName,
} from './installer.ts';
import {
  detectInstalledAgents,
  agents,
  getNonUniversalAgents,
  isUniversalAgent,
} from './agents.ts';
import { readStowConfig, detectStow, stageToGit } from './stow.ts';
import { track } from './telemetry.ts';
import type { AgentType } from './types.ts';

export interface DistributeOptions {
  global?: boolean;
  yes?: boolean;
  agent?: string[];
  quiet?: boolean;
}

interface DistributeResult {
  skill: string;
  agent: string;
  action: 'created' | 'updated' | 'skipped';
}

export async function runDistribute(options: DistributeOptions): Promise<void> {
  const isGlobal = options.global ?? true;
  const cwd = process.cwd();

  p.intro(pc.bgCyan(pc.black(' skills distribute ')));

  const canonicalDir = getCanonicalSkillsDir(isGlobal, cwd);

  // Scan canonical dir for skills
  const skillNames: string[] = [];
  try {
    const entries = await readdir(canonicalDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        skillNames.push(entry.name);
      }
    }
  } catch {
    p.log.error(pc.red(`No canonical skills directory found at ${canonicalDir}`));
    p.log.info(pc.dim('Import skills first: skills import <path> -g'));
    return;
  }

  if (skillNames.length === 0) {
    p.log.warn(pc.yellow('No skills found in canonical directory'));
    return;
  }

  p.log.info(`Found ${pc.cyan(String(skillNames.length))} skill(s) to distribute`);

  // Determine target agents
  let targetAgents: AgentType[];
  if (options.agent?.includes('*')) {
    targetAgents = Object.keys(agents) as AgentType[];
  } else if (options.agent && options.agent.length > 0) {
    targetAgents = options.agent as AgentType[];
  } else {
    // Only distribute to non-universal agents (universal agents share canonical dir)
    targetAgents = getNonUniversalAgents();
  }

  // Filter out universal agents — they already have access to canonical dir
  const nonUniversalTargets = targetAgents.filter((a) => !isUniversalAgent(a));

  if (nonUniversalTargets.length === 0) {
    p.log.info(pc.dim('All target agents are universal — no symlinks needed'));
    return;
  }

  // Show what we're about to do
  const agentNames = nonUniversalTargets.map((a) => agents[a].displayName);
  p.log.info(pc.dim(`Targeting ${nonUniversalTargets.length} agent(s): ${agentNames.join(', ')}`));

  if (!options.yes) {
    const confirmed = await p.confirm({
      message: `Distribute ${skillNames.length} skill(s) to ${nonUniversalTargets.length} agent(s)?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Distribution cancelled');
      process.exit(0);
    }
  }

  const spinner = p.spinner();
  spinner.start('Distributing skills...');

  const results: DistributeResult[] = [];

  for (const skillName of skillNames) {
    const canonicalSkillPath = join(canonicalDir, skillName);

    for (const agentType of nonUniversalTargets) {
      const agent = agents[agentType];
      const agentBase = getAgentBaseDir(agentType, isGlobal, cwd);
      const agentSkillPath = join(agentBase, skillName);

      try {
        // Ensure agent skills directory exists
        await mkdir(agentBase, { recursive: true });

        // Check existing
        const existing = await lstat(agentSkillPath).catch(() => null);
        if (existing?.isSymbolicLink()) {
          const resolvedExisting = await realpath(agentSkillPath).catch(() => '');
          const resolvedCanonical = await realpath(canonicalSkillPath).catch(() => canonicalSkillPath);
          if (resolvedExisting === resolvedCanonical) {
            results.push({ skill: skillName, agent: agent.displayName, action: 'skipped' });
            continue;
          }
          // Stale symlink — remove and recreate
          await rm(agentSkillPath);
        } else if (existing?.isDirectory()) {
          // Real directory exists — skip unless forced
          results.push({ skill: skillName, agent: agent.displayName, action: 'skipped' });
          continue;
        }

        // Create symlink
        const relativePath = relative(agentBase, canonicalSkillPath);
        const symlinkType = process.platform === 'win32' ? 'junction' : undefined;
        await symlink(relativePath, agentSkillPath, symlinkType);
        results.push({ skill: skillName, agent: agent.displayName, action: 'created' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(pc.dim(`Skipped ${skillName} → ${agent.displayName}: ${msg}`));
        results.push({ skill: skillName, agent: agent.displayName, action: 'skipped' });
      }
    }
  }

  spinner.stop('Distribution complete');

  // Summary
  const created = results.filter((r) => r.action === 'created');
  const skipped = results.filter((r) => r.action === 'skipped');

  console.log();
  if (created.length > 0) {
    p.log.success(pc.green(`Created ${created.length} symlink(s)`));
    for (const r of created) {
      p.log.message(`  ${pc.green('✓')} ${r.skill} → ${r.agent}`);
    }
  }
  if (skipped.length > 0) {
    const alreadyValid = skipped.length;
    p.log.info(pc.dim(`${alreadyValid} symlink(s) already valid or skipped`));
  }

  // Git staging for stow-managed paths
  const config = readStowConfig();
  const stowInfo = await detectStow(canonicalDir);
  if (stowInfo.isStow && config.autoGit && stowInfo.repoPath && created.length > 0) {
    const uniqueSkills = [...new Set(created.map((r) => r.skill))];
    stageToGit(
      stowInfo.repoPath,
      uniqueSkills.map((n) => join(canonicalDir, n)),
      `feat(skills): distribute ${uniqueSkills.join(', ')}`
    );
    p.log.info(pc.dim(`Git: committed distribution to ${stowInfo.repoPath}`));
  }

  track({
    event: 'distribute',
    skillCount: String(skillNames.length),
    agentCount: String(nonUniversalTargets.length),
    created: String(created.length),
  });

  if (!options.quiet) {
    console.log();
    p.outro(pc.green('Done!'));
  }
}

export function parseDistributeOptions(args: string[]): {
  options: DistributeOptions;
} {
  const options: DistributeOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      i++;
      while (i < args.length && args[i] && !args[i].startsWith('-')) {
        options.agent.push(args[i]!);
        i++;
      }
      i--;
    }
  }

  return { options };
}
