import * as p from '@clack/prompts';
import pc from 'picocolors';
import { symlink, mkdir, lstat, cp, rm, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join, resolve, relative } from 'path';
import { homedir } from 'os';
import { getCanonicalSkillsDir, sanitizeName } from './installer.ts';
import { addSkillToLock } from './skill-lock.ts';
import { removeFromRemoved } from './skill-intent.ts';
import { detectStow, stageToGit, readStowConfig } from './stow.ts';
import { track } from './telemetry.ts';

function toHomeRelative(abs: string): string {
  const home = homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + '/')) return '~' + abs.slice(home.length);
  return abs;
}

export interface ImportOptions {
  global?: boolean;
  yes?: boolean;
  copy?: boolean;
  force?: boolean;
  name?: string;
  quiet?: boolean;
  dryRun?: boolean;
}

export async function runImport(paths: string[], options: ImportOptions): Promise<void> {
  const isGlobal = options.global ?? true;
  const cwd = process.cwd();
  const dryRun = options.dryRun ?? false;

  p.intro(pc.bgCyan(pc.black(' skills import ')));

  if (dryRun) {
    p.log.warn(pc.yellow('[dry-run] No filesystem changes will be made'));
  }

  const canonicalDir = getCanonicalSkillsDir(isGlobal, cwd);

  // Expand paths (handle glob patterns from shell)
  const expandedPaths = paths.length > 0 ? paths : ['.'];

  const stowInfo = await detectStow(canonicalDir);
  const config = readStowConfig();

  if (stowInfo.isStow && stowInfo.hasUncommittedChanges && !options.yes) {
    p.log.warn(
      pc.yellow('Stow-managed path has uncommitted git changes. Files will be added on top.')
    );
  }

  const results: Array<{ name: string; success: boolean; error?: string }> = [];

  for (const inputPath of expandedPaths) {
    const resolvedPath = inputPath.replace(/^~(?=\/|$)/, homedir());
    const absolutePath = resolve(cwd, resolvedPath);

    // Check source exists
    if (!existsSync(absolutePath)) {
      results.push({ name: basename(absolutePath), success: false, error: 'Path not found' });
      continue;
    }

    // Check for SKILL.md
    const skillMdPath = join(absolutePath, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      results.push({
        name: basename(absolutePath),
        success: false,
        error: 'No SKILL.md found in directory',
      });
      continue;
    }

    // --name only makes sense for single-path imports; warn and ignore for multi-path
    if (options.name && expandedPaths.length > 1) {
      p.log.warn(pc.yellow('--name is ignored when importing multiple paths'));
    }
    const skillName =
      options.name && expandedPaths.length === 1
        ? sanitizeName(options.name)
        : sanitizeName(basename(absolutePath));
    const targetDir = join(canonicalDir, skillName);

    // Check if already exists
    if (existsSync(targetDir)) {
      const existingStat = await lstat(targetDir);
      if (existingStat.isSymbolicLink()) {
        const existingReal = await realpath(targetDir).catch(() => null);
        const sourceReal = await realpath(absolutePath).catch(() => absolutePath);
        if (existingReal === sourceReal) {
          p.log.info(pc.dim(`Already imported: ${skillName}`));
          results.push({ name: skillName, success: true });
          continue;
        }
      } else if (existingStat.isDirectory()) {
        // Real directory — require explicit --force to overwrite.
        if (!options.force) {
          p.log.error(
            `${skillName} exists as a real directory (not a symlink). Use --force to overwrite.`
          );
          results.push({
            name: skillName,
            success: false,
            error: 'Exists as real directory (use --force)',
          });
          continue;
        }
      }
      if (!options.yes && !options.force && !dryRun) {
        const overwrite = await p.confirm({
          message: `${skillName} already exists. Overwrite?`,
        });
        if (p.isCancel(overwrite) || !overwrite) {
          results.push({ name: skillName, success: false, error: 'Skipped (already exists)' });
          continue;
        }
      }
    }

    try {
      if (!dryRun) {
        await mkdir(canonicalDir, { recursive: true });
      }

      // Guard against importing from within the canonical dir itself (self-referential symlink)
      const resolvedCanonical = await realpath(canonicalDir).catch(() => canonicalDir);
      const resolvedSource = await realpath(absolutePath).catch(() => absolutePath);
      if (
        resolvedSource === resolvedCanonical ||
        resolvedSource.startsWith(resolvedCanonical + '/')
      ) {
        p.log.error(`Cannot import from inside the canonical skills directory`);
        results.push({
          name: skillName,
          success: false,
          error: 'Source is inside canonical dir (would create self-referential symlink)',
        });
        continue;
      }

      if (options.copy) {
        // Copy mode
        if (!dryRun) {
          await rm(targetDir, { recursive: true, force: true }).catch(() => {});
          await cp(absolutePath, targetDir, { recursive: true });
        }
        p.log.success(
          `${dryRun ? pc.yellow('[dry-run] Would copy') : pc.green(skillName)} ${dryRun ? skillName + ' to' : 'copied to'} ${pc.dim(targetDir)}`
        );
      } else {
        // Symlink mode (default)
        if (!dryRun) {
          await rm(targetDir, { recursive: true, force: true }).catch(() => {});
          const relativePath = relative(resolvedCanonical, resolvedSource);
          const symlinkType = process.platform === 'win32' ? 'junction' : undefined;
          await symlink(relativePath, targetDir, symlinkType);
        }
        p.log.success(
          `${dryRun ? pc.yellow('[dry-run] Would symlink') : pc.green(skillName)} ${dryRun ? skillName + ' to' : 'symlinked to'} ${pc.dim(absolutePath)}`
        );
      }

      // Update lock file
      if (!dryRun) {
        const homeRelative = toHomeRelative(absolutePath);
        await addSkillToLock(skillName, {
          source: homeRelative,
          sourceType: 'local',
          sourceUrl: homeRelative,
          skillFolderHash: '',
        });

        // Clear from removed list (user is re-importing)
        await removeFromRemoved(skillName);
      }

      results.push({ name: skillName, success: true });
    } catch (err) {
      results.push({
        name: skillName,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Stage to git if stow-managed and autoGit enabled
  if (
    !dryRun &&
    stowInfo.isStow &&
    config.autoGit &&
    stowInfo.repoPath &&
    results.some((r) => r.success)
  ) {
    const successfulNames = results.filter((r) => r.success).map((r) => r.name);
    const message = `feat(skills): import ${successfulNames.join(', ')}`;
    const gitResult = stageToGit(
      stowInfo.repoPath,
      successfulNames.map((n) => join(canonicalDir, n)),
      message
    );
    if (gitResult.ok) {
      p.log.info(pc.dim(`Git: committed import to ${stowInfo.repoPath}`));
    } else {
      p.log.warn(pc.yellow(`Git commit failed: ${gitResult.error}`));
    }
  }

  // Summary
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log();
  if (successful.length > 0) {
    const prefix = dryRun ? pc.yellow(`[dry-run] Would import`) : pc.green(`Imported`);
    p.log.success(`${prefix} ${successful.length} skill(s)`);
  }
  if (failed.length > 0) {
    p.log.error(pc.red(`Failed to import ${failed.length} skill(s)`));
    for (const r of failed) {
      p.log.message(`  ${pc.red('✗')} ${r.name}: ${r.error}`);
    }
  }

  if (!dryRun) {
    track({
      event: 'import',
      skillCount: String(successful.length),
      mode: options.copy ? 'copy' : 'symlink',
    });
  }

  if (!options.quiet) {
    console.log();
    p.outro(pc.green(dryRun ? 'Dry run complete — no changes made.' : 'Done!'));
  }
}

export function parseImportOptions(args: string[]): {
  paths: string[];
  options: ImportOptions;
} {
  const options: ImportOptions = {};
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '--copy') {
      options.copy = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--name') {
      i++;
      options.name = args[i];
    } else if (arg && !arg.startsWith('-')) {
      paths.push(arg);
    }
  }

  return { paths, options };
}
