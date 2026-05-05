import * as p from '@clack/prompts';
import pc from 'picocolors';
import { symlink, mkdir, lstat, readlink, cp, readdir, rm, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join, resolve, relative, dirname } from 'path';
import { homedir } from 'os';
import { getCanonicalSkillsDir, sanitizeName } from './installer.ts';
import { addSkillToLock, removeFromRemoved } from './skill-lock.ts';
import { detectStow, stageToGit, readStowConfig } from './stow.ts';
import { track } from './telemetry.ts';

export interface ImportOptions {
  global?: boolean;
  yes?: boolean;
  copy?: boolean;
  force?: boolean;
  name?: string;
  quiet?: boolean;
}

export async function runImport(paths: string[], options: ImportOptions): Promise<void> {
  const isGlobal = options.global ?? true;
  const cwd = process.cwd();

  p.intro(pc.bgCyan(pc.black(' skills import ')));

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
    const resolvedPath = inputPath.replace(/^~/, homedir());
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

    const skillName = options.name ?? sanitizeName(basename(absolutePath));
    const targetDir = join(canonicalDir, skillName);

    // Check if already exists
    if (existsSync(targetDir)) {
      const existingStat = await lstat(targetDir);
      if (existingStat.isSymbolicLink()) {
        const existingTarget = await readlink(targetDir);
        if (resolve(dirname(targetDir), existingTarget) === absolutePath) {
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
          results.push({ name: skillName, success: false, error: 'Exists as real directory (use --force)' });
          continue;
        }
      }
      if (!options.yes) {
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
      await mkdir(canonicalDir, { recursive: true });

      if (options.copy) {
        // Copy mode
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        await cp(absolutePath, targetDir, { recursive: true });
        p.log.success(`${pc.green(skillName)} copied to ${pc.dim(targetDir)}`);
      } else {
        // Symlink mode (default)
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});

        const resolvedCanonical = await realpath(canonicalDir).catch(() => canonicalDir);
        const resolvedSource = await realpath(absolutePath).catch(() => absolutePath);
        const relativePath = relative(resolvedCanonical, resolvedSource);
        const symlinkType = process.platform === 'win32' ? 'junction' : undefined;
        await symlink(relativePath, targetDir, symlinkType);
        p.log.success(`${pc.green(skillName)} symlinked to ${pc.dim(absolutePath)}`);
      }

      // Update lock file
      const homeRelative = absolutePath.replace(homedir(), '~');
      await addSkillToLock(skillName, {
        source: homeRelative,
        sourceType: 'local',
        sourceUrl: homeRelative,
        skillFolderHash: '',
      });

      // Clear from removed list (user is re-importing)
      await removeFromRemoved(skillName);

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
  if (stowInfo.isStow && config.autoGit && stowInfo.repoPath && results.some((r) => r.success)) {
    const successfulNames = results.filter((r) => r.success).map((r) => r.name);
    const message = `feat(skills): import ${successfulNames.join(', ')}`;
    if (stageToGit(stowInfo.repoPath, successfulNames.map((n) => join(canonicalDir, n)), message)) {
      p.log.info(pc.dim(`Git: committed import to ${stowInfo.repoPath}`));
    }
  }

  // Summary
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log();
  if (successful.length > 0) {
    p.log.success(pc.green(`Imported ${successful.length} skill(s)`));
  }
  if (failed.length > 0) {
    p.log.error(pc.red(`Failed to import ${failed.length} skill(s)`));
    for (const r of failed) {
      p.log.message(`  ${pc.red('✗')} ${r.name}: ${r.error}`);
    }
  }

  track({
    event: 'import',
    skillCount: String(successful.length),
    mode: options.copy ? 'copy' : 'symlink',
  });

  if (!options.quiet) {
    console.log();
    p.outro(pc.green('Done!'));
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
    } else if (arg === '--name') {
      i++;
      options.name = args[i];
    } else if (arg && !arg.startsWith('-')) {
      paths.push(arg);
    }
  }

  return { paths, options };
}
