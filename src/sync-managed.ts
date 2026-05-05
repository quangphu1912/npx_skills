import * as p from '@clack/prompts';
import pc from 'picocolors';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { readStowConfig } from './stow.ts';
import { getAllLockedSkills, getRemovedSkills } from './skill-lock.ts';
import { runImport } from './import-skills.ts';
import { runDistribute } from './distribute.ts';
import { track } from './telemetry.ts';

export interface SyncManagedOptions {
  global?: boolean;
  yes?: boolean;
}

export async function runSyncManaged(options: SyncManagedOptions): Promise<void> {
  const isGlobal = options.global ?? true;
  const cwd = process.cwd();

  p.intro(pc.bgCyan(pc.black(' skills sync ')));

  const config = readStowConfig();

  // Step 1: Import new skills from watched directories
  if (config.watchedDirs.length > 0) {
    p.log.info(pc.dim(`Scanning ${config.watchedDirs.length} watched director(ies)...`));

    const lockedSkills = await getAllLockedSkills();
    const lockedNames = new Set(Object.keys(lockedSkills));
    const removedNames = await getRemovedSkills();

    for (const watchedDir of config.watchedDirs) {
      let entries;
      try {
        entries = await readdir(watchedDir, { withFileTypes: true });
      } catch {
        p.log.warn(pc.dim(`Watched dir not found: ${watchedDir}`));
        continue;
      }

      const newSkills: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillName = entry.name;
        const skillMdPath = join(watchedDir, skillName, 'SKILL.md');

        // Check if it has SKILL.md
        try {
          await stat(skillMdPath);
        } catch {
          continue;
        }

        // Check if not already tracked and not explicitly removed
        if (!lockedNames.has(skillName) && !removedNames.has(skillName)) {
          newSkills.push(join(watchedDir, skillName));
        }
      }

      if (newSkills.length > 0) {
        p.log.info(
          `Found ${pc.cyan(String(newSkills.length))} new skill(s) in ${watchedDir}`
        );
        await runImport(newSkills, { global: isGlobal, yes: options.yes, quiet: true });
      } else {
        p.log.info(pc.dim(`No new skills in ${watchedDir}`));
      }
    }
  } else {
    p.log.info(pc.dim('No watched directories configured'));
    p.log.info(pc.dim('Add watchedDirs to ~/.agents/.skill-config.json'));
  }

  // Step 2: Distribute to all agents
  p.log.info(pc.dim('Running distribute...'));
  await runDistribute({ global: isGlobal, yes: options.yes, quiet: true });

  track({
    event: 'sync-managed',
    watchedDirs: String(config.watchedDirs.length),
  });

  console.log();
  p.outro(pc.green('Sync complete!'));
}

export function parseSyncManagedOptions(args: string[]): {
  options: SyncManagedOptions;
} {
  const options: SyncManagedOptions = {};

  for (const arg of args) {
    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    }
  }

  return { options };
}
