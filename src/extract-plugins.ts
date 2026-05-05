import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readdir, stat, cp, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getCanonicalSkillsDir } from './installer.ts';
import { addSkillToLock, getAllLockedSkills } from './skill-lock.ts';
import { detectStow, stageToGit, readStowConfig } from './stow.ts';
import { track } from './telemetry.ts';

export interface ExtractPluginsOptions {
  global?: boolean;
  yes?: boolean;
}

interface PluginSkill {
  pluginName: string;
  marketplace: string;
  version: string;
  skillName: string;
  skillPath: string;
}

export async function runExtractPlugins(options: ExtractPluginsOptions): Promise<void> {
  const isGlobal = options.global ?? true;
  const cwd = process.cwd();

  p.intro(pc.bgCyan(pc.black(' skills extract-plugins ')));

  const canonicalDir = getCanonicalSkillsDir(isGlobal, cwd);
  const pluginsCacheDir = join(homedir(), '.claude', 'plugins', 'cache');
  const lockedSkills = await getAllLockedSkills();

  if (!existsSync(pluginsCacheDir)) {
    p.log.error(pc.red('Plugin cache not found at ~/.claude/plugins/cache/'));
    p.outro(pc.yellow('No plugins to extract.'));
    return;
  }

  const allPluginSkills = await discoverPluginSkills(pluginsCacheDir);

  if (allPluginSkills.length === 0) {
    p.log.info(pc.dim('No plugin skills found to extract.'));
    p.outro(pc.green('Done!'));
    return;
  }

  p.log.info(`Found ${pc.cyan(String(allPluginSkills.length))} plugin skill(s) to extract`);

  await mkdir(canonicalDir, { recursive: true });

  const results: Array<{ name: string; action: 'copied' | 'updated' | 'skipped'; error?: string }> = [];
  const extractedNames = new Set<string>();

  for (const ps of allPluginSkills) {
    const targetName = `${ps.pluginName}-${ps.skillName}`;
    extractedNames.add(targetName);
    const targetDir = join(canonicalDir, targetName);

    // Skip if already extracted with same version
    const existing = lockedSkills[targetName];
    if (
      existing &&
      existing.sourceType === 'plugin' &&
      existing.pluginName === ps.pluginName &&
      existing.pluginVersion === ps.version
    ) {
      results.push({ name: targetName, action: 'skipped' });
      continue;
    }

    try {
      // Remove old extraction if exists
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      await cp(ps.skillPath, targetDir, { recursive: true });

      await addSkillToLock(targetName, {
        source: `plugin:${ps.marketplace}/${ps.pluginName}`,
        sourceType: 'plugin',
        sourceUrl: `plugin:${ps.marketplace}/${ps.pluginName}`,
        skillFolderHash: '',
        pluginName: ps.pluginName,
        pluginVersion: ps.version,
      });

      const action = existing ? 'updated' : 'copied';
      results.push({ name: targetName, action });
    } catch (err) {
      results.push({
        name: targetName,
        action: 'copied',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Clean up stale extractions (plugin was removed)
  const staleExtractions: string[] = [];
  for (const [name, entry] of Object.entries(lockedSkills)) {
    if (entry.sourceType === 'plugin' && !extractedNames.has(name)) {
      const targetDir = join(canonicalDir, name);
      if (existsSync(targetDir)) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        staleExtractions.push(name);
      }
    }
  }

  // Stage to git if stow-managed
  const stowInfo = await detectStow(canonicalDir);
  const config = readStowConfig();
  if (stowInfo.isStow && config.autoGit && stowInfo.repoPath && results.some((r) => r.action !== 'skipped')) {
    const changed = results.filter((r) => r.action !== 'skipped').map((r) => r.name);
    stageToGit(
      stowInfo.repoPath,
      changed.map((n) => join(canonicalDir, n)),
      `feat(skills): extract ${changed.length} plugin skill(s)`
    );
  }

  // Summary
  const copied = results.filter((r) => r.action === 'copied' && !r.error);
  const updated = results.filter((r) => r.action === 'updated');
  const skipped = results.filter((r) => r.action === 'skipped');
  const failed = results.filter((r) => r.error);

  console.log();
  if (copied.length > 0) p.log.success(pc.green(`Copied ${copied.length} new skill(s)`));
  if (updated.length > 0) p.log.info(pc.cyan(`Updated ${updated.length} skill(s)`));
  if (skipped.length > 0) p.log.info(pc.dim(`Skipped ${skipped.length} unchanged skill(s)`));
  if (staleExtractions.length > 0) p.log.info(pc.yellow(`Cleaned ${staleExtractions.length} stale extraction(s)`));
  if (failed.length > 0) {
    p.log.error(pc.red(`Failed ${failed.length} skill(s)`));
    for (const r of failed) p.log.message(`  ${pc.red('✗')} ${r.name}: ${r.error}`);
  }

  track({ event: 'extract-plugins', skillCount: String(copied.length + updated.length) });

  console.log();
  p.outro(pc.green('Done!'));
}

async function discoverPluginSkills(pluginsCacheDir: string): Promise<PluginSkill[]> {
  const skills: PluginSkill[] = [];

  const marketplaces = await readdirSafe(pluginsCacheDir);
  for (const marketplace of marketplaces) {
    const marketplaceDir = join(pluginsCacheDir, marketplace);
    if (!(await isDir(marketplaceDir))) continue;

    const plugins = await readdirSafe(marketplaceDir);
    for (const pluginName of plugins) {
      const pluginDir = join(marketplaceDir, pluginName);
      if (!(await isDir(pluginDir))) continue;

      // Pick latest version by mtime
      const versions = await readdirSafe(pluginDir);
      if (versions.length === 0) continue;

      let latestVersion = versions[0];
      let latestMtime = 0;
      for (const v of versions) {
        const vPath = join(pluginDir, v);
        try {
          const s = await stat(vPath);
          if (s.isDirectory() && s.mtimeMs > latestMtime) {
            latestMtime = s.mtimeMs;
            latestVersion = v;
          }
        } catch { continue; }
      }

      const versionDir = join(pluginDir, latestVersion);
      const skillsDir = join(versionDir, 'skills');
      if (!existsSync(skillsDir)) continue;

      const skillEntries = await readdirSafe(skillsDir);
      for (const skillName of skillEntries) {
        const skillPath = join(skillsDir, skillName);
        if (!existsSync(join(skillPath, 'SKILL.md'))) continue;
        if (!(await isDir(skillPath))) continue;

        skills.push({
          pluginName,
          marketplace,
          version: latestVersion,
          skillName,
          skillPath,
        });
      }
    }
  }

  return skills;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export function parseExtractPluginsOptions(args: string[]): {
  options: ExtractPluginsOptions;
} {
  const options: ExtractPluginsOptions = {};

  for (const arg of args) {
    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    }
  }

  return { options };
}
