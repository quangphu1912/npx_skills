import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runImport } from '../src/import-skills.ts';

describe('import --name is sanitized', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldXdg: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'import-name-'));
    oldHome = process.env.HOME;
    oldXdg = process.env.XDG_STATE_HOME;
    process.env.HOME = root;
    process.env.XDG_STATE_HOME = join(root, '.state');
    const src = join(root, 'src-skill');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n', 'utf-8');
  });

  afterEach(async () => {
    process.env.HOME = oldHome;
    process.env.XDG_STATE_HOME = oldXdg;
    await rm(root, { recursive: true, force: true });
  });

  it('turns a traversing --name into a safe in-store name', async () => {
    // '../EVIL' unsanitized would resolve to <root>/.agents/EVIL (outside the
    // skills store) and the overwrite rm() would delete whatever sat there.
    await runImport([join(root, 'src-skill')], {
      global: true,
      yes: true,
      name: '../EVIL',
    });

    const store = join(root, '.agents', 'skills');
    const entries = await readdir(store);
    // sanitizeName('../EVIL') -> 'evil' — must land INSIDE the store.
    expect(entries).toContain('evil');
    // Nothing must be created outside the skills store.
    expect(existsSync(join(root, '.agents', 'EVIL'))).toBe(false);
  });
});
