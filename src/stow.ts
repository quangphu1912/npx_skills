import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { lstat, readdir } from 'fs/promises';
import { execFileSync } from 'child_process';
import { homedir } from 'os';

export interface StowInfo {
  isStow: boolean;
  repoPath: string | null;
  hasUncommittedChanges: boolean;
}

/**
 * Walk up from `path` to detect if it's under a stow-managed symlink.
 * Stow creates symlinks like: ~/.agents → ~/dotfiles/agents/.agents
 * If the path is a symlink, resolve it and check if it points into a git repo.
 */
export async function detectStow(targetPath: string): Promise<StowInfo> {
  try {
    const resolved = resolve(targetPath);
    const parentDir = dirname(resolved);

    // Check if the parent directory is a symlink (stow pattern)
    const parentStat = await lstat(parentDir);
    if (!parentStat.isSymbolicLink()) {
      // Check if target itself is inside a known stow-managed location
      return detectStowByConfig(targetPath);
    }

    // Resolve the symlink
    const { realpath } = await import('fs/promises');
    const realParent = await realpath(parentDir);

    // Check if the real path is inside a git repo
    const repoPath = findGitRepo(realParent);
    if (repoPath) {
      return {
        isStow: true,
        repoPath,
        hasUncommittedChanges: hasUncommittedChanges(repoPath),
      };
    }

    return detectStowByConfig(targetPath);
  } catch {
    return detectStowByConfig(targetPath);
  }
}

/**
 * Fallback: check ~/.agents/.skill-config.json for stow configuration.
 */
function detectStowByConfig(targetPath: string): StowInfo {
  const config = readStowConfig();
  if (!config.stowManaged) {
    return { isStow: false, repoPath: null, hasUncommittedChanges: false };
  }

  const repoPath = config.stowRepoPath
    ? config.stowRepoPath.replace(/^~/, homedir())
    : null;

  return {
    isStow: true,
    repoPath,
    hasUncommittedChanges: repoPath ? hasUncommittedChanges(repoPath) : false,
  };
}

/**
 * Walk up from a directory to find the nearest .git.
 */
function findGitRepo(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Check if a git repo has uncommitted changes.
 */
function hasUncommittedChanges(repoPath: string): boolean {
  try {
    const result = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Stage files to git in the stow repo.
 */
export function stageToGit(repoPath: string, paths: string[], message: string): boolean {
  try {
    for (const p of paths) {
      execFileSync('git', ['add', p], {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    execFileSync('git', ['commit', '-m', message], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export interface StowConfig {
  stowManaged: boolean;
  stowRepoPath: string | null;
  watchedDirs: string[];
  autoGit: boolean;
}

const DEFAULT_CONFIG: StowConfig = {
  stowManaged: false,
  stowRepoPath: null,
  watchedDirs: [],
  autoGit: false,
};

/**
 * Read ~/.agents/.skill-config.json for stow configuration.
 */
export function readStowConfig(): StowConfig {
  const configPath = join(homedir(), '.agents', '.skill-config.json');
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      stowManaged: parsed.stowManaged ?? DEFAULT_CONFIG.stowManaged,
      stowRepoPath: parsed.stowRepoPath ?? DEFAULT_CONFIG.stowRepoPath,
      watchedDirs: (parsed.watchedDirs ?? []).map((d: string) =>
        d.replace(/^~/, homedir())
      ),
      autoGit: parsed.autoGit ?? DEFAULT_CONFIG.autoGit,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
