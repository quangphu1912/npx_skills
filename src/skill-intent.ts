import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

const INTENT_FILE = '.skill-intent.json';
const INTENT_VERSION = 1;

export interface SkillIntentFile {
  version: number;
  /** Skills explicitly removed by user — managed-sync will not re-import them. */
  removed: Record<string, string>;
  /** Tracks dismissed UI prompts so they are not shown again. */
  dismissed: Record<string, boolean>;
  /** Last agents selected during interactive install, for pre-filling the next prompt. */
  lastSelectedAgents?: string[];
}

export function getSkillIntentPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) {
    return join(xdgStateHome, 'skills', INTENT_FILE);
  }
  return join(homedir(), '.agents', INTENT_FILE);
}

function createEmptyIntentFile(): SkillIntentFile {
  return { version: INTENT_VERSION, removed: {}, dismissed: {} };
}

/**
 * Read the skill intent file. If it does not exist, attempt a one-time migration
 * from any intent fields that may be present in the legacy lock file, then return
 * a fresh empty intent.
 */
export async function readSkillIntent(): Promise<SkillIntentFile> {
  const intentPath = getSkillIntentPath();
  try {
    const content = await readFile(intentPath, 'utf-8');
    const parsed = JSON.parse(content) as SkillIntentFile;
    if (typeof parsed.version !== 'number') return createEmptyIntentFile();
    return {
      version: parsed.version,
      removed: parsed.removed ?? {},
      dismissed: parsed.dismissed ?? {},
      lastSelectedAgents: parsed.lastSelectedAgents,
    };
  } catch {
    // File missing — try to migrate from legacy lock file
    return migrateIntentFromLock();
  }
}

/**
 * One-time migration: pull intent fields out of the legacy lock file and write
 * them to the new intent file. Safe to run multiple times — idempotent.
 */
async function migrateIntentFromLock(): Promise<SkillIntentFile> {
  const intent = createEmptyIntentFile();
  try {
    // Read lock file directly (avoid circular import with skill-lock.ts)
    const xdgStateHome = process.env.XDG_STATE_HOME;
    const lockPath = xdgStateHome
      ? join(xdgStateHome, 'skills', '.skill-lock.json')
      : join(homedir(), '.agents', '.skill-lock.json');
    const raw = await readFile(lockPath, 'utf-8');
    const lock = JSON.parse(raw) as Record<string, unknown>;
    if (lock.removed && typeof lock.removed === 'object') {
      intent.removed = lock.removed as Record<string, string>;
    }
    if (lock.dismissed && typeof lock.dismissed === 'object') {
      intent.dismissed = lock.dismissed as Record<string, boolean>;
    }
    if (Array.isArray(lock.lastSelectedAgents)) {
      intent.lastSelectedAgents = lock.lastSelectedAgents as string[];
    }
  } catch {
    // Lock file missing or unreadable — start fresh
  }
  await writeSkillIntent(intent);
  return intent;
}

export async function writeSkillIntent(intent: SkillIntentFile): Promise<void> {
  const intentPath = getSkillIntentPath();
  await mkdir(dirname(intentPath), { recursive: true });
  await writeFile(intentPath, JSON.stringify(intent, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Removed-skills helpers
// ---------------------------------------------------------------------------

export async function addToRemoved(skillName: string, source: string): Promise<void> {
  const intent = await readSkillIntent();
  intent.removed[skillName] = source;
  await writeSkillIntent(intent);
}

export async function getRemovedSkills(): Promise<Set<string>> {
  const intent = await readSkillIntent();
  return new Set(Object.keys(intent.removed));
}

export async function removeFromRemoved(skillName: string): Promise<void> {
  const intent = await readSkillIntent();
  if (!(skillName in intent.removed)) return;
  delete intent.removed[skillName];
  await writeSkillIntent(intent);
}

// ---------------------------------------------------------------------------
// Dismissed-prompt helpers
// ---------------------------------------------------------------------------

export async function isPromptDismissed(promptKey: string): Promise<boolean> {
  const intent = await readSkillIntent();
  return intent.dismissed[promptKey] === true;
}

export async function dismissPrompt(promptKey: string): Promise<void> {
  const intent = await readSkillIntent();
  intent.dismissed[promptKey] = true;
  await writeSkillIntent(intent);
}

// ---------------------------------------------------------------------------
// Agent-selection memory helpers
// ---------------------------------------------------------------------------

export async function getLastSelectedAgents(): Promise<string[] | undefined> {
  const intent = await readSkillIntent();
  return intent.lastSelectedAgents;
}

export async function saveSelectedAgents(agents: string[]): Promise<void> {
  const intent = await readSkillIntent();
  intent.lastSelectedAgents = agents;
  await writeSkillIntent(intent);
}
