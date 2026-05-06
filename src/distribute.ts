import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readdir, lstat, rm, realpath } from 'fs/promises';
import { join } from 'path';
import { getCanonicalSkillsDir, getAgentBaseDir, distributeSkillToAgents } from './installer.ts';
import {
  agents,
  detectInstalledAgents,
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
  dryRun?: boolean;
}

interface DistributeResult {
  skill: string;
  agent: string;
  action: 'created' | 'updated' | 'skipped';
}

export async function runDistribute(options: DistributeOptions): Promise<void> {
  const isGlobal = options.global ?? true;
  const cwd = process.cwd();
  const dryRun = options.dryRun ?? false;

  p.intro(pc.bgCyan(pc.black(' skills distribute ')));

  if (dryRun) {
    p.log.warn(pc.yellow('[dry-run] No filesystem changes will be made'));
  }

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
    if (!options.quiet) p.outro(pc.yellow('Aborted'));
    process.exitCode = 1;
    return;
  }

  if (skillNames.length === 0) {
    p.log.warn(pc.yellow('No skills found in canonical directory'));
    if (!options.quiet) p.outro(pc.yellow('Nothing to distribute'));
    return;
  }

  p.log.info(`Found ${pc.cyan(String(skillNames.length))} skill(s) to distribute`);

  // Determine target agents
  let targetAgents: AgentType[];
  if (options.agent?.includes('*')) {
    // Explicit '*' targets all non-universal agents regardless of install status
    targetAgents = getNonUniversalAgents();
  } else if (options.agent && options.agent.length > 0) {
    targetAgents = options.agent as AgentType[];
  } else {
    // Default: only target installed non-universal agents
    const installed = await detectInstalledAgents();
    targetAgents = installed.filter((a) => !isUniversalAgent(a));
  }

  const nonUniversalTargets = targetAgents.filter(
    (a) => !isUniversalAgent(a) && a !== 'claude-code'
  );
  const universalTargets = targetAgents.filter((a) => isUniversalAgent(a));

  if (nonUniversalTargets.length === 0) {
    p.log.info(pc.dim('All target agents are universal — no symlinks needed'));
    if (!options.quiet) p.outro(pc.green('Done!'));
    return;
  }

  const agentNames = nonUniversalTargets.map((a) => agents[a].displayName);
  p.log.info(pc.dim(`Targeting ${nonUniversalTargets.length} agent(s): ${agentNames.join(', ')}`));
  if (universalTargets.length > 0) {
    const universalNames = universalTargets.map((a) => agents[a].displayName);
    p.log.info(
      pc.dim(
        `Skipped ${universalTargets.length} universal agent(s) (share canonical dir): ${universalNames.join(', ')}`
      )
    );
  }

  if (!options.yes && !dryRun) {
    const confirmed = await p.confirm({
      message: `Distribute ${skillNames.length} skill(s) to ${nonUniversalTargets.length} agent(s)?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Distribution cancelled');
      process.exit(0);
    }
  }

  const spinner = p.spinner();
  spinner.start(dryRun ? 'Calculating distribution...' : 'Distributing skills...');

  const results: DistributeResult[] = [];

  for (const skillName of skillNames) {
    const agentResults = await distributeSkillToAgents(skillName, nonUniversalTargets, {
      isGlobal,
      cwd,
      dryRun,
    });
    for (const r of agentResults) {
      if (r.error) {
        p.log.warn(pc.dim(`Skipped ${skillName} → ${agents[r.agent].displayName}: ${r.error}`));
      }
      results.push({ skill: skillName, agent: agents[r.agent].displayName, action: r.action });
    }
  }

  spinner.stop(dryRun ? 'Calculation complete' : 'Distribution complete');

  // Prune stale symlinks from agent dirs (symlinks pointing into canonical that no longer exist)
  const canonicalRealPath = await realpath(canonicalDir).catch(() => canonicalDir);
  let pruned = 0;
  for (const agentType of nonUniversalTargets) {
    const agentBase = getAgentBaseDir(agentType, isGlobal, cwd);
    let agentEntries: string[];
    try {
      agentEntries = await readdir(agentBase);
    } catch {
      continue;
    }
    for (const entry of agentEntries) {
      const entryPath = join(agentBase, entry);
      const entryStat = await lstat(entryPath).catch(() => null);
      if (!entryStat?.isSymbolicLink()) continue;
      const target = await realpath(entryPath).catch(() => null);
      const isBroken = target === null;
      const isStale =
        target && target.startsWith(canonicalRealPath + '/') && !skillNames.includes(entry);
      if (isBroken || isStale) {
        if (!dryRun) {
          await rm(entryPath, { force: true }).catch(() => {});
        }
        pruned++;
      }
    }
  }

  // Summary
  const created = results.filter((r) => r.action === 'created');
  const updated = results.filter((r) => r.action === 'updated');
  const skipped = results.filter((r) => r.action === 'skipped');
  const prefix = dryRun ? pc.yellow('[dry-run] Would create') : pc.green('Created');
  const updatePrefix = dryRun ? pc.yellow('[dry-run] Would update') : pc.cyan('Updated');

  console.log();
  if (created.length > 0) {
    p.log.success(`${prefix} ${created.length} symlink(s)`);
    for (const r of created) {
      p.log.message(`  ${pc.green('✓')} ${r.skill} → ${r.agent}`);
    }
  }
  if (updated.length > 0) {
    p.log.info(`${updatePrefix} ${updated.length} symlink(s)`);
  }
  if (skipped.length > 0) {
    p.log.info(pc.dim(`${skipped.length} symlink(s) already valid or skipped`));
  }
  if (pruned > 0) {
    const prunePrefix = dryRun ? '[dry-run] Would prune' : 'Pruned';
    p.log.info(pc.yellow(`${prunePrefix} ${pruned} stale symlink(s)`));
  }

  // Git staging for stow-managed paths (skip in dry-run)
  if (!dryRun) {
    const config = readStowConfig();
    const stowInfo = await detectStow(canonicalDir);
    if (stowInfo.isStow && config.autoGit && stowInfo.repoPath && created.length > 0) {
      const uniqueSkills = [...new Set(created.map((r) => r.skill))];
      const gitResult = stageToGit(
        stowInfo.repoPath,
        uniqueSkills.map((n) => join(canonicalDir, n)),
        `feat(skills): distribute ${uniqueSkills.join(', ')}`
      );
      if (gitResult.ok) {
        p.log.info(pc.dim(`Git: committed distribution to ${stowInfo.repoPath}`));
      } else {
        p.log.warn(pc.yellow(`Git commit failed: ${gitResult.error}`));
      }
    }
  }

  if (!dryRun) {
    track({
      event: 'distribute',
      skillCount: String(skillNames.length),
      agentCount: String(nonUniversalTargets.length),
      created: String(created.length),
    });
  }

  if (!options.quiet) {
    console.log();
    p.outro(pc.green(dryRun ? 'Dry run complete — no changes made.' : 'Done!'));
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
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      i++;
      while (i < args.length && args[i] && !args[i]!.startsWith('-')) {
        options.agent.push(args[i]!);
        i++;
      }
      i--;
    }
  }

  return { options };
}
