import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  agents,
  detectInstalledAgents,
  getUniversalAgents,
  getNonUniversalAgents,
} from './agents.ts';
import { getAgentBaseDir } from './installer.ts';
import type { AgentType } from './types.ts';

export async function runListAgents(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' skills agents ')));

  const installed = await detectInstalledAgents();
  const installedSet = new Set(installed);
  const universalTypes = new Set(getUniversalAgents());
  const nonUniversalTypes = getNonUniversalAgents();

  const allTypes = Object.keys(agents) as AgentType[];

  const universalAgents = allTypes.filter((a) => universalTypes.has(a));
  const nonUniversalAgents = allTypes.filter((a) => !universalTypes.has(a));

  // Universal section
  console.log();
  p.log.info(pc.bold(`Universal agents (share ~/.agents/skills/):`));

  const universalInstalled: string[] = [];
  const universalNotInstalled: string[] = [];

  for (const agentType of universalAgents) {
    const agent = agents[agentType];
    const isInstalled = installedSet.has(agentType);
    const check = isInstalled ? pc.green('✓') : pc.red('✗');
    const status = isInstalled ? pc.green('installed') : pc.dim('not installed');
    const line = `  ${check} ${pc.cyan(agent.displayName.padEnd(18))}${pc.dim(agentType.padEnd(16))}${status}`;
    console.log(line);
    if (isInstalled) {
      universalInstalled.push(agentType);
    } else {
      universalNotInstalled.push(agentType);
    }
  }

  console.log();
  p.log.info(pc.bold(`Non-universal agents (need symlinks via distribute):`));

  const nonUniversalInstalled: string[] = [];

  for (const agentType of nonUniversalAgents) {
    const agent = agents[agentType];
    const isInstalled = installedSet.has(agentType);
    const check = isInstalled ? pc.green('✓') : pc.red('✗');
    const skillPath = agent.globalSkillsDir
      ? agent.globalSkillsDir.replace(process.env.HOME || '', '~')
      : `~/${agent.skillsDir}`;
    const status = isInstalled ? pc.green('installed') : pc.dim('not installed');
    const line = `  ${check} ${pc.cyan(agent.displayName.padEnd(18))}${pc.dim(agentType.padEnd(16))}${status.padEnd(16)}${pc.dim(skillPath)}`;
    console.log(line);
    if (isInstalled) {
      nonUniversalInstalled.push(agentType);
    }
  }

  // Summary
  console.log();
  p.log.info(
    pc.dim(
      `${universalInstalled.length}/${universalAgents.length} universal, ${nonUniversalInstalled.length}/${nonUniversalAgents.length} non-universal installed`
    )
  );

  console.log();
  p.outro(pc.green('Done!'));
}
