/**
 * File-based state management for the Ralph loop.
 *
 * PRD schema validation (Zod), atomic file I/O, progress tracking,
 * PID-based lock files, and response state for BLOCKED/DECIDE signals.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const StoryStatusSchema = z.enum(['pending', 'passed', 'failed']);

export const StorySchema = z.object({
  id: z.string(),
  description: z.string(),
  verificationSteps: z.array(z.string()),
  status: StoryStatusSchema.default('pending'),
  attemptCount: z.number().default(0),
  lastError: z.string().optional(),
});

export const PhaseSchema = z.object({
  name: z.string(),
  stories: z.array(StorySchema),
});

export const PrdSchema = z.object({
  name: z.string(),
  description: z.string(),
  techStack: z.string(),
  createdAt: z.string(),
  phases: z.array(PhaseSchema),
});

// ---------------------------------------------------------------------------
// Inferred Types
// ---------------------------------------------------------------------------

export type StoryStatus = z.infer<typeof StoryStatusSchema>;
export type Story = z.infer<typeof StorySchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type Prd = z.infer<typeof PrdSchema>;

// ---------------------------------------------------------------------------
// Atomic File Operations
// ---------------------------------------------------------------------------

/** Write JSON atomically using write-rename pattern to prevent corruption. */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// PRD Read / Write
// ---------------------------------------------------------------------------

export function readPrd(projectDir: string): Prd {
  const raw = fs.readFileSync(path.join(projectDir, 'prd.json'), 'utf-8');
  return PrdSchema.parse(JSON.parse(raw));
}

export function writePrd(projectDir: string, prd: Prd): void {
  PrdSchema.parse(prd);
  atomicWriteJson(path.join(projectDir, 'prd.json'), prd);
}

// ---------------------------------------------------------------------------
// Progress Tracking
// ---------------------------------------------------------------------------

/** Append a timestamped entry to progress.txt. */
export function appendProgress(projectDir: string, entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  fs.appendFileSync(path.join(projectDir, 'progress.txt'), line, 'utf-8');
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/** Append a structured guardrail entry to guardrails.md. */
export function appendGuardrail(
  projectDir: string,
  title: string,
  trigger: string,
  instruction: string,
  sourceStoryId: string,
): void {
  const entry = [
    `### ${title}`,
    `**Trigger:** ${trigger}`,
    `**Instruction:** ${instruction}`,
    `**Source:** ${sourceStoryId}`,
    '',
  ].join('\n');
  fs.appendFileSync(path.join(projectDir, 'guardrails.md'), entry + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Lock File Management
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the Ralph loop lock. Returns false if already held by a live process. */
export function acquireRalphLock(projectDir: string): boolean {
  const lock = path.join(projectDir, '.ralph.lock');

  if (fs.existsSync(lock)) {
    try {
      const existingPid = parseInt(fs.readFileSync(lock, 'utf-8').trim(), 10);
      if (!isNaN(existingPid) && isProcessAlive(existingPid)) return false;
      fs.unlinkSync(lock);
    } catch {
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Release the Ralph loop lock. Safe to call even if no lock exists. */
export function releaseRalphLock(projectDir: string): void {
  try {
    fs.unlinkSync(path.join(projectDir, '.ralph.lock'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ---------------------------------------------------------------------------
// Response State (BLOCKED/DECIDE signaling)
// ---------------------------------------------------------------------------

/** Append a user response for a story to responses.json. */
export function appendResponse(projectDir: string, storyId: string, response: string): void {
  const filePath = path.join(projectDir, 'responses.json');
  let data: Record<string, string[]> = {};
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* start fresh */ }
  if (!data[storyId]) data[storyId] = [];
  data[storyId].push(response);
  atomicWriteJson(filePath, data);
}

/** Read all user responses for a story. Returns [] on any error. */
export function readResponses(projectDir: string, storyId: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(projectDir, 'responses.json'), 'utf-8'));
    return data[storyId] || [];
  } catch {
    return [];
  }
}
