import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  agents,
  detectInstalledAgents,
  getUniversalAgents,
  getNonUniversalAgents,
} from './agents.ts';
import type { AgentType } from './types.ts';

export async function runListAgents(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' skills agents ')));

  const installed = await detectInstalledAgents();
  const installedSet = new Set(installed);
  const universalTypes = new Set(getUniversalAgents());

  const allTypes = Object.keys(agents) as AgentType[];
  const universalList = allTypes.filter((a) => universalTypes.has(a));
  const nonUniversalList = allTypes.filter((a) => !universalTypes.has(a));

  // Universal section
  console.log();
  p.log.info(pc.bold('Universal agents (share ~/.agents/skills/):'));

  const universalInstalled: string[] = [];

  for (const agentType of universalList) {
    const agent = agents[agentType];
    const isInstalled = installedSet.has(agentType);
    const check = isInstalled ? pc.green('✓') : pc.red('✗');
    const name = agent.displayName.padEnd(18);
    const key = agentType.padEnd(16);
    const status = isInstalled ? pc.green('installed') : pc.dim('not installed');
    console.log(`  ${check} ${pc.cyan(name)}${pc.dim(key)}${status}`);
    if (isInstalled) universalInstalled.push(agentType);
  }

  // Non-universal section
  console.log();
  p.log.info(pc.bold('Non-universal agents (need symlinks via distribute):'));

  const nonUniversalInstalled: string[] = [];

  for (const agentType of nonUniversalList) {
    const agent = agents[agentType];
    const isInstalled = installedSet.has(agentType);
    const check = isInstalled ? pc.green('✓') : pc.red('✗');
    const name = agent.displayName.padEnd(18);
    const key = agentType.padEnd(16);
    const statusText = isInstalled ? 'installed  ' : 'not installed';
    const status = isInstalled ? pc.green(statusText) : pc.dim(statusText);
    const skillPath = agent.globalSkillsDir
      ? agent.globalSkillsDir.replace(process.env.HOME || '', '~')
      : `~/${agent.skillsDir}`;
    console.log(`  ${check} ${pc.cyan(name)}${pc.dim(key)}${status}  ${pc.dim(skillPath)}`);
    if (isInstalled) nonUniversalInstalled.push(agentType);
  }

  // Summary
  console.log();
  p.log.info(
    pc.dim(
      `${universalInstalled.length}/${universalList.length} universal, ${nonUniversalInstalled.length}/${nonUniversalList.length} non-universal installed`
    )
  );

  console.log();
  p.outro(pc.green('Done!'));
}
