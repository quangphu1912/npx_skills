import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readdir, stat, cp, rm, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getCanonicalSkillsDir } from './installer.ts';
import { addSkillToLock, getAllLockedSkills, removeSkillFromLock } from './skill-lock.ts';
import { detectStow, stageToGit, readStowConfig } from './stow.ts';
import { track } from './telemetry.ts';

export interface ExtractClaudePluginsOptions {
  yes?: boolean;
  dryRun?: boolean;
}

interface PluginSkill {
  pluginName: string;
  marketplace: string;
  version: string;
  skillName: string;
  skillPath: string;
}

export async function runExtractClaudePlugins(options: ExtractClaudePluginsOptions): Promise<void> {
  const cwd = process.cwd();
  const dryRun = options.dryRun ?? false;

  p.intro(pc.bgCyan(pc.black(' skills extract-claude-plugins ')));

  if (dryRun) {
    p.log.warn(pc.yellow('[dry-run] No filesystem changes will be made'));
  }

  const canonicalDir = getCanonicalSkillsDir(true, cwd);
  const pluginsCacheDir = join(homedir(), '.claude', 'plugins', 'cache');
  const lockedSkills = await getAllLockedSkills();

  const enabledPlugins = readEnabledPlugins();
  if (enabledPlugins) {
    const names = [...enabledPlugins].join(', ');
    p.log.info(pc.dim(`Filtering to enabled plugins: ${names}`));
  }

  if (!existsSync(pluginsCacheDir)) {
    p.log.error(pc.red('Plugin cache not found at ~/.claude/plugins/cache/'));
    p.outro(pc.yellow('No plugins to extract.'));
    return;
  }

  const allPluginSkills = await discoverPluginSkills(pluginsCacheDir, enabledPlugins);

  if (allPluginSkills.length === 0) {
    p.log.info(pc.dim('No plugin skills found to extract.'));
    p.outro(pc.green('Done!'));
    return;
  }

  p.log.info(`Found ${pc.cyan(String(allPluginSkills.length))} plugin skill(s) to extract`);

  if (!dryRun) {
    await mkdir(canonicalDir, { recursive: true });
  }

  const results: Array<{ name: string; action: 'copied' | 'updated' | 'skipped'; error?: string }> =
    [];
  const extractedNames = new Set<string>();

  for (const ps of allPluginSkills) {
    const targetName = `${ps.pluginName}-${ps.skillName}`;
    const targetDir = join(canonicalDir, targetName);

    const existing = lockedSkills[targetName];
    if (
      existing &&
      existing.sourceType === 'plugin' &&
      existing.pluginName === ps.pluginName &&
      existing.pluginVersion === ps.version
    ) {
      extractedNames.add(targetName);
      results.push({ name: targetName, action: 'skipped' });
      continue;
    }

    try {
      if (!dryRun) {
        await rm(targetDir, { recursive: true, force: true });
        await cp(ps.skillPath, targetDir, { recursive: true, dereference: true });
        await addSkillToLock(targetName, {
          source: `plugin:${ps.marketplace}/${ps.pluginName}`,
          sourceType: 'plugin',
          sourceUrl: `plugin:${ps.marketplace}/${ps.pluginName}`,
          skillFolderHash: '',
          pluginName: ps.pluginName,
          pluginVersion: ps.version,
        });
      }

      extractedNames.add(targetName);
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
      if (!dryRun) {
        const targetDir = join(canonicalDir, name);
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        await removeSkillFromLock(name);
      }
      staleExtractions.push(name);
    }
  }

  // Stage to git if stow-managed
  if (!dryRun) {
    const stowInfo = await detectStow(canonicalDir);
    const config = readStowConfig();
    if (
      stowInfo.isStow &&
      config.autoGit &&
      stowInfo.repoPath &&
      results.some((r) => r.action !== 'skipped')
    ) {
      const changed = results.filter((r) => r.action !== 'skipped').map((r) => r.name);
      const gitResult = stageToGit(
        stowInfo.repoPath,
        changed.map((n) => join(canonicalDir, n)),
        `feat(skills): extract ${changed.length} plugin skill(s)`
      );
      if (!gitResult.ok) {
        p.log.warn(pc.yellow(`Git commit failed: ${gitResult.error}`));
      }
    }
  }

  // Summary
  const copied = results.filter((r) => r.action === 'copied' && !r.error);
  const updated = results.filter((r) => r.action === 'updated');
  const skipped = results.filter((r) => r.action === 'skipped');
  const failed = results.filter((r) => r.error);
  const prefix = dryRun ? pc.yellow('[dry-run] Would copy') : pc.green('Copied');

  console.log();
  if (copied.length > 0) p.log.success(`${prefix} ${copied.length} new skill(s)`);
  if (updated.length > 0) {
    const updatePrefix = dryRun ? pc.yellow('[dry-run] Would update') : pc.cyan('Updated');
    p.log.info(`${updatePrefix} ${updated.length} skill(s)`);
  }
  if (skipped.length > 0) p.log.info(pc.dim(`Skipped ${skipped.length} unchanged skill(s)`));
  if (staleExtractions.length > 0) {
    const stalePrefix = dryRun ? '[dry-run] Would clean' : 'Cleaned';
    p.log.info(pc.yellow(`${stalePrefix} ${staleExtractions.length} stale extraction(s)`));
  }
  if (failed.length > 0) {
    p.log.error(pc.red(`Failed ${failed.length} skill(s)`));
    for (const r of failed) p.log.message(`  ${pc.red('✗')} ${r.name}: ${r.error}`);
  }

  if (!dryRun) {
    track({ event: 'extract-plugins', skillCount: String(copied.length + updated.length) });
  }

  console.log();
  p.outro(pc.green(dryRun ? 'Dry run complete — no changes made.' : 'Done!'));
}

function readEnabledPlugins(): Set<string> | null {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const enabled: Record<string, boolean> = raw.enabledPlugins ?? {};
    const names = Object.entries(enabled)
      .filter(([, v]) => v === true)
      .map(([k]) => k.split('@')[0]);
    return names.length > 0 ? new Set(names) : null;
  } catch {
    return null;
  }
}

async function discoverPluginSkills(
  pluginsCacheDir: string,
  enabledPlugins: Set<string> | null
): Promise<PluginSkill[]> {
  const skills: PluginSkill[] = [];

  const marketplaces = await readdirSafe(pluginsCacheDir);
  for (const marketplace of marketplaces) {
    const marketplaceDir = join(pluginsCacheDir, marketplace);
    if (!(await isDir(marketplaceDir))) continue;

    const plugins = await readdirSafe(marketplaceDir);
    for (const pluginName of plugins) {
      if (enabledPlugins && !enabledPlugins.has(pluginName)) continue;
      const pluginDir = join(marketplaceDir, pluginName);
      if (!(await isDir(pluginDir))) continue;

      const versions = await readdirSafe(pluginDir);
      if (versions.length === 0) continue;

      const semverRe = /^(\d+)\.(\d+)\.(\d+)/;
      const sorted = [...versions].sort((a, b) => {
        const ma = semverRe.exec(a);
        const mb = semverRe.exec(b);
        if (ma && mb) {
          for (let i = 1; i <= 3; i++) {
            const diff = Number(mb[i]) - Number(ma[i]);
            if (diff !== 0) return diff;
          }
          const aStable = a.length === ma[0].length;
          const bStable = b.length === mb[0].length;
          if (aStable && !bStable) return -1;
          if (!aStable && bStable) return 1;
          return 0;
        }
        if (ma) return -1;
        if (mb) return 1;
        return 0;
      });
      const latestVersion = sorted[0];
      if (!latestVersion) continue;

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

export function parseExtractClaudePluginsOptions(args: string[]): {
  options: ExtractClaudePluginsOptions;
} {
  const options: ExtractClaudePluginsOptions = {};

  for (const arg of args) {
    if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return { options };
}
