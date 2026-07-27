import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { lstat, realpath } from 'fs/promises';
import { execFileSync } from 'child_process';
import { homedir } from 'os';

export interface StowInfo {
  isStow: boolean;
  repoPath: string | null;
  hasUncommittedChanges: boolean;
}

/**
 * Walk up from `path` to detect if it's under a stow-managed symlink.
 * Handles two common stow patterns:
 *   1. targetPath itself is the symlink:  ~/.agents/skills → dotfiles
 *   2. targetPath's parent is the symlink: ~/.agents → dotfiles (more common)
 */
export async function detectStow(targetPath: string): Promise<StowInfo> {
  try {
    const resolved = resolve(targetPath);

    // Pattern 1: targetPath itself is a stow-managed symlink
    const targetStat = await lstat(resolved).catch(() => null);
    if (targetStat?.isSymbolicLink()) {
      const realTarget = await realpath(resolved);
      const repoPath = findGitRepo(dirname(realTarget));
      if (repoPath) {
        return { isStow: true, repoPath, hasUncommittedChanges: hasUncommittedChanges(repoPath) };
      }
    }

    // Pattern 2: parent directory is a stow-managed symlink
    const parentDir = dirname(resolved);
    const parentStat = await lstat(parentDir);
    if (!parentStat.isSymbolicLink()) {
      return detectStowByConfig(targetPath);
    }

    const realParent = await realpath(parentDir);
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
    ? config.stowRepoPath.replace(/^~(?=\/|$)/, homedir())
    : null;

  return {
    isStow: true,
    repoPath,
    hasUncommittedChanges: repoPath ? hasUncommittedChanges(repoPath) : false,
  };
}

/**
 * Walk up from a directory to find the nearest .git, then verify startDir is
 * actually inside that worktree. This prevents matching an unrelated repo
 * (e.g. a home-directory backup repo at ~/.git) and committing to the wrong tree.
 */
function findGitRepo(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.git'))) {
      try {
        const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: startDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const resolvedTop = resolve(toplevel);
        const resolvedStart = resolve(startDir);
        if (resolvedStart === resolvedTop || resolvedStart.startsWith(resolvedTop + sep)) {
          return dir;
        }
        return null; // startDir not inside this worktree
      } catch {
        return null; // git unavailable or not a valid repo
      }
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
    const result = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
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
 * Resolves symlinks to real paths before git add so that paths through stow
 * symlinks are correctly resolved within the git worktree.
 * Uses `git commit -- <paths>` to scope the commit to only our files,
 * leaving any unrelated staged content untouched.
 * Returns { ok: true } on success, or { ok: false, error } with the git error message.
 */
export function stageToGit(
  repoPath: string,
  paths: string[],
  message: string
): { ok: boolean; error?: string } {
  try {
    const realPaths = paths.map((p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    });
    for (const p of realPaths) {
      execFileSync('git', ['add', p], {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    execFileSync('git', ['commit', '-m', message, '--', ...realPaths], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch {
    return DEFAULT_CONFIG; // file doesn't exist — stow features disabled
  }
  try {
    const parsed = JSON.parse(content);
    // Catch common typo: watchedDir (singular) instead of watchedDirs (plural)
    if (parsed.watchedDir !== undefined && parsed.watchedDirs === undefined) {
      process.stderr.write(
        `Warning: .skill-config.json has "watchedDir" (singular) — did you mean "watchedDirs"?\n`
      );
    }
    return {
      stowManaged: parsed.stowManaged ?? DEFAULT_CONFIG.stowManaged,
      stowRepoPath: parsed.stowRepoPath ?? DEFAULT_CONFIG.stowRepoPath,
      watchedDirs: (parsed.watchedDirs ?? []).map((d: string) =>
        d.replace(/^~(?=\/|$)/, homedir())
      ),
      autoGit: parsed.autoGit ?? DEFAULT_CONFIG.autoGit,
    };
  } catch {
    process.stderr.write(
      `Warning: ~/.agents/.skill-config.json is not valid JSON — stow features disabled\n`
    );
    return DEFAULT_CONFIG;
  }
}
