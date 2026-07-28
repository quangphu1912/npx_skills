import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// CURRENT_VERSION constants (mirrored from source so tests remain explicit)
const SKILL_LOCK_CURRENT_VERSION = 4;
const LOCAL_LOCK_CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeSkillLockContent(version: number): string {
  return JSON.stringify({
    version,
    skills: {
      'my-skill': {
        source: 'owner/repo',
        sourceType: 'github',
        sourceUrl: 'https://github.com/owner/repo',
        skillFolderHash: 'abc123',
        installedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    },
  });
}

function makeLocalLockContent(version: number): string {
  return JSON.stringify({
    version,
    skills: {
      'my-skill': {
        source: 'owner/repo',
        sourceType: 'github',
        computedHash: 'abc123',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Global lock (skill-lock.ts) migration tests
// ---------------------------------------------------------------------------

describe('skill-lock migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XDG_STATE_HOME;
  });

  it('backs up old file and returns empty lock when version < CURRENT_VERSION', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'skill-lock-migration-'));
    try {
      // Point getSkillLockPath() at our temp dir via XDG_STATE_HOME.
      // getSkillLockPath() resolves to: join(XDG_STATE_HOME, 'skills', '.skill-lock.json')
      const skillsDir = join(tmpDir, 'skills');
      await mkdir(skillsDir, { recursive: true });
      const lockPath = join(skillsDir, '.skill-lock.json');

      const oldVersion = SKILL_LOCK_CURRENT_VERSION - 1;
      const content = makeSkillLockContent(oldVersion);
      await writeFile(lockPath, content, 'utf-8');

      process.env.XDG_STATE_HOME = tmpDir;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Dynamic import after env var is set so the module re-resolves the path
      const { readSkillLock } = await import('../src/skill-lock.ts');
      const lock = await readSkillLock();

      // Returns empty lock (skills wiped)
      expect(lock.skills).toEqual({});
      expect(lock.version).toBe(SKILL_LOCK_CURRENT_VERSION);

      // Backup file exists with original content
      const backupPath = `${lockPath}.v${oldVersion}.bak`;
      expect(await fileExists(backupPath)).toBe(true);
      const backedUp = await readFile(backupPath, 'utf-8');
      expect(backedUp).toBe(content);

      // console.warn called with "upgraded"
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain('upgraded');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty lock and warns "Backup failed" when backup write throws', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'skill-lock-migration-'));
    const skillsDir = join(tmpDir, 'skills');
    try {
      await mkdir(skillsDir, { recursive: true });
      const lockPath = join(skillsDir, '.skill-lock.json');

      const oldVersion = SKILL_LOCK_CURRENT_VERSION - 1;
      await writeFile(lockPath, makeSkillLockContent(oldVersion), 'utf-8');

      // Force the backup write to fail by occupying its exact path with a
      // directory — writeFile then fails with EISDIR. Deliberately not chmod:
      // chmod on a directory is a no-op on Windows, so the backup would succeed
      // there and this test would assert against the success message instead.
      await mkdir(`${lockPath}.v${oldVersion}.bak`, { recursive: true });

      process.env.XDG_STATE_HOME = tmpDir;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { readSkillLock } = await import('../src/skill-lock.ts');
      const lock = await readSkillLock();

      // Still returns empty lock
      expect(lock.skills).toEqual({});
      expect(lock.version).toBe(SKILL_LOCK_CURRENT_VERSION);

      // console.warn called with "Backup failed"
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain('Backup failed');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns lock unchanged and skips backup when version === CURRENT_VERSION', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'skill-lock-migration-'));
    try {
      const skillsDir = join(tmpDir, 'skills');
      await mkdir(skillsDir, { recursive: true });
      const lockPath = join(skillsDir, '.skill-lock.json');

      await writeFile(lockPath, makeSkillLockContent(SKILL_LOCK_CURRENT_VERSION), 'utf-8');

      process.env.XDG_STATE_HOME = tmpDir;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { readSkillLock } = await import('../src/skill-lock.ts');
      const lock = await readSkillLock();

      // Skills are preserved — no wipe
      expect(lock.skills['my-skill']).toBeDefined();
      expect(lock.version).toBe(SKILL_LOCK_CURRENT_VERSION);

      // No backup file created
      const backupPath = `${lockPath}.v${SKILL_LOCK_CURRENT_VERSION}.bak`;
      expect(await fileExists(backupPath)).toBe(false);

      // No console.warn
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Local lock (local-lock.ts) migration tests
// ---------------------------------------------------------------------------

describe('local-lock migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs up old file and returns empty lock when version < CURRENT_VERSION', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'local-lock-migration-'));
    try {
      const lockPath = join(tmpDir, 'skills-lock.json');
      const oldVersion = LOCAL_LOCK_CURRENT_VERSION - 1;
      const content = makeLocalLockContent(oldVersion);
      await writeFile(lockPath, content, 'utf-8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { readLocalLock } = await import('../src/local-lock.ts');
      const lock = await readLocalLock(tmpDir);

      // Returns empty lock
      expect(lock.skills).toEqual({});
      expect(lock.version).toBe(LOCAL_LOCK_CURRENT_VERSION);

      // Backup file exists with original content
      const backupPath = `${lockPath}.v${oldVersion}.bak`;
      expect(await fileExists(backupPath)).toBe(true);
      const backedUp = await readFile(backupPath, 'utf-8');
      expect(backedUp).toBe(content);

      // console.warn called with "upgraded"
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain('upgraded');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
