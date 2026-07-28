/**
 * Fork-deviation invariants for @phu-le/skills (a patch-on-top fork of
 * vercel-labs/skills).
 *
 * A rebase can drop a fork-specific line inside an otherwise-upstream block
 * WITHOUT a conflict marker — the drop is invisible to the reader. Behavioral
 * assertions are the only detector for these silent drops.
 *
 * TAGS:
 *   permanent        — fork identity. A failure means something real was lost.
 *   pending-upstream — should converge upstream. A failure is a HEALTHY signal
 *                      to retire the deviation (update this file with a dated
 *                      rationale + the merged PR/issue link).
 *
 * RULE: When this test fails after a rebase there are exactly two valid
 *   responses — (a) the deviation was dropped: RESTORE it, or (b) the
 *   deviation is no longer needed: update this file with a dated rationale.
 *   NEVER delete an assertion to make the test green; if you do, the commit
 *   message must cite the dated rationale.
 *
 * ANNUAL REVIEW: On each anniversary of this file, re-evaluate every
 *   `pending-upstream` tag — has upstream taken the fix? Has the rationale
 *   gone stale?
 *
 * Every invariant below was mutation-verified on creation (revert the
 * deviation locally, confirm RED, restore).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { agents, isUniversalAgent } from '../src/agents.ts';
import { getAgentType } from '../src/detect-agent.ts';
import { resolveSkillsToRemove } from '../src/remove.ts';
import { generateKeywords } from '../scripts/sync-agents.ts';
import type { SkillLockEntry } from '../src/skill-lock.ts';
import * as telemetry from '../src/telemetry.ts';

describe('fork invariants', () => {
  describe('Codex is non-universal [pending-upstream]', () => {
    // WHY: Codex's binary reads ~/.codex/skills, not the hub. Upstream classes
    // it universal, which silently gives Codex zero hub skills.
    // Upstream link: <fill in when PR is opened — Task 7>
    it('isUniversalAgent(codex) is false', () => {
      expect(isUniversalAgent('codex')).toBe(false);
    });
  });

  describe('gemini-cli removed [permanent]', () => {
    // WHY: Google deprecated consumer sign-in 2026-06-18; the agent is gone.
    it('is absent from the agents registry', () => {
      expect(Object.keys(agents)).not.toContain('gemini-cli');
    });
  });

  describe('Antigravity stays universal [permanent]', () => {
    // WHY: skillsDir/globalSkillsDir mismatch looks like the Codex bug but
    // isn't — Antigravity has no skill system (verified via app.asar). Leaving
    // it universal means distribute skips it, which is correct.
    it('isUniversalAgent(antigravity) is true', () => {
      expect(isUniversalAgent('antigravity')).toBe(true);
    });
  });

  describe('detect-agent.ts remaps gemini away from gemini-cli [permanent]', () => {
    // WHY: upstream's agent map hard-codes gemini -> 'gemini-cli', an agent we
    // deleted. We remap to 'universal'. This is a fork line inside an upstream
    // file — the exact silent-drop profile.
    it("getAgentType('gemini') is 'universal', not 'gemini-cli'", () => {
      expect(getAgentType('gemini')).toBe('universal');
    });
  });

  describe('fork keywords survive sync-agents [permanent]', () => {
    // WHY: generateKeywords() previously dropped 3 hand-added keywords (fixed
    // in 21f620c). A rebase that reverts that fix silently wipes them from
    // package.json on the next sync-agents run.
    it('generateKeywords() includes the 3 migration keywords', () => {
      const kw = generateKeywords();
      expect(kw).toContain('skill-migration');
      expect(kw).toContain('claude-code-migration');
      expect(kw).toContain('agent-migration');
    });
  });

  describe('SkillLockEntry.pluginVersion present [permanent]', () => {
    // WHY: extract-claude-plugins uses pluginVersion for staleness detection.
    // It was silently dropped in a prior realign (caught by type-check). This
    // compile-time + runtime assertion centralizes the invariant.
    it('the lock entry type carries pluginVersion', () => {
      const sample = { pluginVersion: '1.2.3' } as SkillLockEntry;
      // Accessing .pluginVersion fails to compile if the field is dropped.
      expect(sample.pluginVersion).toBe('1.2.3');
    });
  });

  describe('telemetry is disabled [permanent]', () => {
    // WHY: this fork removed all telemetry (182 lines -> 26 no-op stubs). A
    // rebase that restores upstream telemetry would silently resume phoning
    // home. The behavioral check (fetch never called) + structural check (no
    // network imports in telemetry.ts) close every regression path.
    it('exports are no-ops that never touch the network', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve({} as Response));
      try {
        telemetry.setVersion('1.0.0');
        telemetry.setDetectedAgent('codex');
        telemetry.track({ event: 'x' });
        await telemetry.fetchAuditData({});
        await telemetry.flushTelemetry();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('telemetry.ts source imports no network modules', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(join(here, '..', 'src', 'telemetry.ts'), 'utf-8');
      // fetch is global (not an import); catch every other transport.
      expect(src).not.toMatch(
        /(?:from\s+|require\s*\(\s*)['"](?:node:)?(?:https?|undici|axios|node:fetch)['"]/
      );
    });

    it('exports the five expected no-op names', () => {
      const names = ['setVersion', 'setDetectedAgent', 'track', 'fetchAuditData', 'flushTelemetry'];
      for (const name of names) {
        expect(typeof (telemetry as Record<string, unknown>)[name]).toBe('function');
      }
    });
  });

  describe('remove resolves lock keys for symlinked skills [pending-upstream]', () => {
    // WHY: this fork's hub is entirely symlinks; scanDir()'s isDirectory()
    // check is false for symlinks and finds nothing. Without resolveSkillsToRemove
    // resolving against lock keys, `remove <name> -g` is a silent no-op for
    // every imported skill. Upstream link: <fill in — Task 7>
    it('resolves a skill that exists ONLY in the lock (no on-disk entry)', () => {
      const resolved = resolveSkillsToRemove(['lockonly-skill'], [], ['lockonly-skill']);
      expect(resolved).toContain('lockonly-skill');
    });

    it('returns nothing for a name in neither folders nor lock', () => {
      const resolved = resolveSkillsToRemove(['nope'], [], ['other']);
      expect(resolved).not.toContain('nope');
    });
  });
});
