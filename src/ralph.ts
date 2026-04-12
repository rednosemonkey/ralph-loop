/**
 * Ralph Loop — autonomous coding loop orchestrator.
 *
 * Drives iterative Agent SDK calls with fresh context injection per iteration.
 * Tracks success/failure via git commit detection, manages state files,
 * enforces exit conditions (all passed, iteration limit, circuit breaker).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js';
import {
  readPrd, writePrd, appendProgress, appendGuardrail,
  acquireRalphLock, releaseRalphLock, appendResponse,
} from './state.js';
import type { Prd } from './state.js';
import { runVerification } from './verify.js';
import { buildIterationPrompt, CODER_SYSTEM_PROMPT } from './prompt.js';
import type { StoryTarget } from './prompt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RalphOptions {
  projectDir: string;
  model?: string;
  maxIterations?: number;
  review?: boolean;
  onIterationComplete?: (data: IterationResult) => void;
  onPhaseCheckpoint?: (data: PhaseCheckpointData) => Promise<void>;
  onBlocked?: (storyId: string, reason: string) => Promise<string>;
  onDecide?: (storyId: string, question: string) => Promise<string>;
  cancelRequested?: () => boolean;
}

export interface RalphReport {
  totalIterations: number;
  storiesPassed: number;
  storiesFailed: number;
  storiesSkipped: number;
  elapsedMs: number;
  exitReason: 'all_passed' | 'iteration_limit' | 'circuit_breaker' | 'cancelled';
  failedStories: Array<{ id: string; lastError: string; attemptCount: number }>;
}

export interface IterationResult {
  storyId: string;
  storyTitle: string;
  storyIndex: number;
  totalStories: number;
  phaseName: string;
  phaseIndex: number;
  result: 'passed' | 'failed' | 'circuit_broken' | 'blocked';
  attemptCount: number;
  maxAttempts: number;
  iteration: number;
  lastError?: string;
}

export interface PhaseCheckpointData {
  phaseName: string;
  phaseIndex: number;
  storiesPassed: number;
  storiesTotal: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findNextPendingStory(prd: Prd): StoryTarget | null {
  for (let pi = 0; pi < prd.phases.length; pi++) {
    for (let si = 0; si < prd.phases[pi].stories.length; si++) {
      const story = prd.phases[pi].stories[si];
      if (story.status === 'pending' && story.attemptCount < 3) {
        return { phaseIndex: pi, storyIndex: si, story };
      }
    }
  }
  return null;
}

export function calculateMaxIterations(prd: Prd): number {
  const total = prd.phases.reduce((sum, p) => sum + p.stories.length, 0);
  return Math.min(50, Math.max(5, total * 3));
}

function shouldPauseAtPhaseBoundary(prd: Prd, target: StoryTarget, prevPhaseIdx: number): boolean {
  if (prd.phases.length < 2 || prevPhaseIdx === -1) return false;
  return target.phaseIndex !== prevPhaseIdx;
}

function computeStoryNumber(prd: Prd, phaseIndex: number, storyIndex: number): number {
  let count = 0;
  for (let pi = 0; pi < phaseIndex; pi++) count += prd.phases[pi].stories.length;
  return count + storyIndex + 1;
}

function computeTotalStories(prd: Prd): number {
  return prd.phases.reduce((sum, p) => sum + p.stories.length, 0);
}

// ---------------------------------------------------------------------------
// Git Operations
// ---------------------------------------------------------------------------

function getGitHead(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

function getCommitMessage(dir: string, sha: string): string {
  return execFileSync('git', ['log', '-1', '--format=%s', sha], { cwd: dir, encoding: 'utf-8' }).trim();
}

function getChangedFiles(dir: string, beforeSha: string): string[] {
  return execFileSync('git', ['diff', '--name-only', beforeSha, 'HEAD'], { cwd: dir, encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);
}

function getCommitDiff(dir: string, beforeSha: string): string {
  try {
    const diff = execFileSync('git', ['diff', beforeSha, 'HEAD'], {
      cwd: dir, encoding: 'utf-8', maxBuffer: 50 * 1024,
    });
    return diff.length > 10_000 ? diff.slice(0, 10_000) + '\n... (truncated)' : diff;
  } catch { return '(diff unavailable)'; }
}

function resetToCommit(dir: string, sha: string): void {
  execFileSync('git', ['reset', '--hard', sha], { cwd: dir });
}

function readFileOrEmpty(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Failed Approach Tracking
// ---------------------------------------------------------------------------

export function appendFailedApproach(
  projectDir: string, storyId: string, attemptNum: number,
  whatWasTried: string, whyItFailed: string, diffSummary: string,
): void {
  const entry = [
    `## ${storyId} (Attempt ${attemptNum})`,
    `**What was tried:** ${whatWasTried}`,
    `**Why it failed:** ${whyItFailed}`,
    `**Diff summary:** ${diffSummary}`,
    '',
  ].join('\n');
  fs.appendFileSync(path.join(projectDir, 'failed_approaches.md'), entry + '\n', 'utf-8');
}

function filterFailedApproachesForStory(content: string, storyId: string): string {
  if (!content) return '';
  return content.split(/(?=^## )/m).filter(s => s.startsWith(`## ${storyId} `)).join('\n');
}

// ---------------------------------------------------------------------------
// Signal Tag Parsing
// ---------------------------------------------------------------------------

export function parseSignalTags(text: string): { type: 'blocked' | 'decide'; content: string } | null {
  const blocked = text.match(/<blocked>([\s\S]*?)<\/blocked>/);
  if (blocked) return { type: 'blocked', content: blocked[1].trim() };
  const decide = text.match(/<decide>([\s\S]*?)<\/decide>/);
  if (decide) return { type: 'decide', content: decide[1].trim() };
  return null;
}

// ---------------------------------------------------------------------------
// Review (Sonnet)
// ---------------------------------------------------------------------------

function parseReviewVerdict(text: string): { passed: boolean; reason?: string } {
  const match = text.match(/<verdict>([\s\S]*?)<\/verdict>/);
  if (!match) return { passed: true };
  const content = match[1].trim();
  if (content === 'pass') return { passed: true };
  const fail = content.match(/^fail:\s*(.+)/s);
  if (fail) return { passed: false, reason: fail[1].trim() };
  return { passed: true };
}

async function runReview(
  projectDir: string, storyId: string,
  verificationSteps: string[], headBefore: string,
): Promise<{ passed: boolean; reason?: string }> {
  try {
    const diff = getCommitDiff(projectDir, headBefore);
    const changedFiles = getChangedFiles(projectDir, headBefore);

    const reviewPrompt = [
      'Review these code changes against the verification steps. Only check correctness.',
      '', '## Verification Steps',
      ...verificationSteps.map((s, i) => `${i + 1}. ${s}`),
      '', '## Changed Files', ...changedFiles.map(f => `- ${f}`),
      '', '## Diff', '```diff', diff, '```',
      '', 'Emit exactly one verdict:',
      '- `<verdict>pass</verdict>` if ALL steps are satisfied',
      '- `<verdict>fail: [reason]</verdict>` if any step is NOT satisfied',
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = query({
        prompt: reviewPrompt,
        options: {
          model: 'claude-sonnet-4-6',
          systemPrompt: `Code reviewer for story ${storyId}. Emit a verdict tag only.`,
          permissionMode: 'plan',
          tools: [],
          abortController: controller,
        },
      });

      let text = '';
      for await (const msg of response) {
        if (controller.signal.aborted) break;
        if (msg.type === 'result' && (msg as SDKResultMessage).subtype === 'success') {
          text = (msg as Extract<SDKResultMessage, { subtype: 'success' }>).result;
        }
      }
      return parseReviewVerdict(text);
    } finally { clearTimeout(timer); }
  } catch {
    return { passed: true }; // fail-open
  }
}

// ---------------------------------------------------------------------------
// Guardrail Extraction (Sonnet)
// ---------------------------------------------------------------------------

function parseExtractedGuardrail(
  text: string, fallbackStoryId: string,
): { title: string; trigger: string; instruction: string; source: string } | null {
  const title = text.match(/^###\s+(.+)$/m);
  const trigger = text.match(/\*\*Trigger:\*\*\s+(.+)$/m);
  const instruction = text.match(/\*\*Instruction:\*\*\s+(.+)$/m);
  const source = text.match(/\*\*Source:\*\*\s+(.+)$/m);
  if (!title || !trigger || !instruction) return null;
  return {
    title: title[1].trim(), trigger: trigger[1].trim(),
    instruction: instruction[1].trim(), source: source?.[1].trim() || fallbackStoryId,
  };
}

async function extractGuardrail(projectDir: string, storyId: string, beforeSha: string): Promise<void> {
  const diff = getCommitDiff(projectDir, beforeSha);
  const failedContent = readFileOrEmpty(path.join(projectDir, 'failed_approaches.md'));
  const storyFailures = filterFailedApproachesForStory(failedContent, storyId);
  if (!storyFailures) return;

  const prompt = [
    'A coding task failed before succeeding. Extract one generalizable guardrail rule.',
    '', '## What Failed', storyFailures,
    '', '## What Succeeded (diff)', '```diff', diff, '```',
    '', 'Output EXACTLY this format:',
    '', '### [Short Rule Title]',
    '**Trigger:** [When this applies]',
    '**Instruction:** [What to do differently]',
    `**Source:** ${storyId}`,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = query({
      prompt,
      options: {
        model: 'claude-sonnet-4-6',
        systemPrompt: 'Extract a coding guardrail from iteration failures. Output the structured entry only.',
        permissionMode: 'plan',
        tools: [],
        abortController: controller,
      },
    });

    let text = '';
    for await (const msg of response) {
      if (controller.signal.aborted) break;
      if (msg.type === 'result' && (msg as SDKResultMessage).subtype === 'success') {
        text = (msg as Extract<SDKResultMessage, { subtype: 'success' }>).result;
      }
    }

    const parsed = parseExtractedGuardrail(text, storyId);
    if (parsed) {
      appendGuardrail(projectDir, parsed.title, parsed.trigger, parsed.instruction, parsed.source);
      console.log(`  Guardrail extracted: ${parsed.title}`);
    }
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// Coding Iteration
// ---------------------------------------------------------------------------

async function runCodingIteration(
  projectDir: string,
  prompt: string,
  model: string,
): Promise<string> {
  const response = query({
    prompt,
    options: {
      model,
      systemPrompt: CODER_SYSTEM_PROMPT,
      tools: { type: 'preset' as const, preset: 'claude_code' as const },
      cwd: projectDir,
      permissionMode: 'acceptEdits' as const,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      disallowedTools: ['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList'],
    },
  });

  let resultText = '';
  for await (const msg of response) {
    if (msg.type === 'result' && (msg as SDKResultMessage).subtype === 'success') {
      resultText = (msg as Extract<SDKResultMessage, { subtype: 'success' }>).result;
    }
  }
  return resultText;
}

// ---------------------------------------------------------------------------
// Default Callbacks
// ---------------------------------------------------------------------------

async function defaultPhaseCheckpoint(data: PhaseCheckpointData): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nPhase "${data.phaseName}" complete (${data.storiesPassed}/${data.storiesTotal} passed).`);
    let answer = '';
    while (answer !== 'continue' && answer !== 'stop') {
      answer = (await rl.question('Type "continue" or "stop": ')).trim().toLowerCase();
    }
    if (answer === 'stop') throw new Error('User stopped at phase checkpoint');
  } finally { rl.close(); }
}

async function defaultBlockedHandler(storyId: string, reason: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nStory ${storyId} is BLOCKED: ${reason}`);
    return await rl.question('Your response: ');
  } finally { rl.close(); }
}

async function defaultDecideHandler(storyId: string, question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nStory ${storyId} needs a DECISION: ${question}`);
    return await rl.question('Your choice: ');
  } finally { rl.close(); }
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------

export async function runRalphLoop(options: RalphOptions): Promise<RalphReport> {
  const {
    projectDir,
    model = 'claude-opus-4-6',
    review: reviewEnabled = true,
    onIterationComplete,
    onPhaseCheckpoint = defaultPhaseCheckpoint,
    onBlocked = defaultBlockedHandler,
    onDecide = defaultDecideHandler,
    cancelRequested,
  } = options;

  if (!acquireRalphLock(projectDir)) {
    throw new Error('Ralph loop already running for this project (lock file exists)');
  }

  const startTime = Date.now();
  let iteration = 0;
  let cancelled = false;
  let exitReason: RalphReport['exitReason'] = 'all_passed';
  let previousPhaseIndex = -1;

  const prdForLimit = readPrd(projectDir);
  const maxIterations = options.maxIterations ?? calculateMaxIterations(prdForLimit);
  const totalStories = computeTotalStories(prdForLimit);

  // Initialize previousPhaseIndex from already-completed work
  for (let pi = 0; pi < prdForLimit.phases.length; pi++) {
    if (prdForLimit.phases[pi].stories.some(s => s.status === 'passed' || s.attemptCount > 0)) {
      previousPhaseIndex = pi;
    }
  }

  const onSigint = () => { cancelled = true; };
  process.on('SIGINT', onSigint);

  try {
    while (iteration < maxIterations) {
      if (cancelled || cancelRequested?.()) { exitReason = 'cancelled'; break; }

      const prd = readPrd(projectDir);
      const target = findNextPendingStory(prd);

      if (!target) {
        const hasStuck = prd.phases.some(p => p.stories.some(s => s.status === 'pending' && s.attemptCount >= 3));
        exitReason = hasStuck ? 'circuit_breaker' : 'all_passed';
        break;
      }

      // Phase boundary checkpoint
      if (shouldPauseAtPhaseBoundary(prd, target, previousPhaseIndex)) {
        const prev = prd.phases[previousPhaseIndex];
        await onPhaseCheckpoint({
          phaseName: prev.name, phaseIndex: previousPhaseIndex,
          storiesPassed: prev.stories.filter(s => s.status === 'passed').length,
          storiesTotal: prev.stories.length,
        });
      }
      previousPhaseIndex = target.phaseIndex;
      iteration++;

      const storyNum = computeStoryNumber(prd, target.phaseIndex, target.storyIndex);
      console.log(`\n[${'='.repeat(60)}]`);
      console.log(`Iteration ${iteration}/${maxIterations} | Story ${storyNum}/${totalStories}: ${target.story.id}`);
      console.log(`Phase: ${prd.phases[target.phaseIndex].name} | Attempt: ${target.story.attemptCount + 1}/3`);
      console.log(`[${'='.repeat(60)}]\n`);

      const headBefore = getGitHead(projectDir);
      const prompt = buildIterationPrompt(projectDir, prd, target);

      let resultText: string;
      try {
        resultText = await runCodingIteration(projectDir, prompt, model);
      } catch (err) {
        resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Check for signal tags
      const signal = parseSignalTags(resultText);
      if (signal) {
        resetToCommit(projectDir, headBefore);
        const handler = signal.type === 'blocked' ? onBlocked : onDecide;
        const response = await handler(target.story.id, signal.content);
        appendResponse(projectDir, target.story.id, response);
        appendProgress(projectDir, `Iteration ${iteration}: ${target.story.id} ${signal.type.toUpperCase()} — awaited user response`);

        onIterationComplete?.({
          storyId: target.story.id, storyTitle: target.story.description,
          storyIndex: storyNum, totalStories,
          phaseName: prd.phases[target.phaseIndex].name, phaseIndex: target.phaseIndex,
          result: 'blocked', attemptCount: target.story.attemptCount, maxAttempts: 3, iteration,
        });
        continue;
      }

      const headAfter = getGitHead(projectDir);

      if (headAfter !== headBefore) {
        // New commit — run verification
        const commitMessage = getCommitMessage(projectDir, headAfter);
        const changedFiles = getChangedFiles(projectDir, headBefore);
        const vResult = runVerification(projectDir, headBefore, changedFiles);

        if (vResult.passed) {
          // Run review if enabled
          if (reviewEnabled) {
            try {
              const reviewResult = await runReview(
                projectDir, target.story.id,
                target.story.verificationSteps || [], headBefore,
              );
              if (!reviewResult.passed) {
                resetToCommit(projectDir, headBefore);
                const fresh = readPrd(projectDir);
                const s = fresh.phases[target.phaseIndex].stories[target.storyIndex];
                s.attemptCount += 1;
                s.lastError = `Review failed: ${reviewResult.reason || 'unknown'}`;
                writePrd(projectDir, fresh);
                appendFailedApproach(projectDir, target.story.id, s.attemptCount,
                  'Review rejected changes', reviewResult.reason || 'fail', changedFiles.join(', '));
                appendProgress(projectDir, `Iteration ${iteration}: ${target.story.id} failed review (attempt ${s.attemptCount})`);
                console.log(`  REVIEW FAILED: ${reviewResult.reason}`);
                onIterationComplete?.({
                  storyId: target.story.id, storyTitle: target.story.description,
                  storyIndex: storyNum, totalStories,
                  phaseName: prd.phases[target.phaseIndex].name, phaseIndex: target.phaseIndex,
                  result: 'failed', attemptCount: s.attemptCount, maxAttempts: 3, iteration,
                  lastError: reviewResult.reason,
                });
                continue;
              }
            } catch {
              // Review failed to run — pass by default (fail-open)
            }
          }

          // PASSED
          const fresh = readPrd(projectDir);
          fresh.phases[target.phaseIndex].stories[target.storyIndex].status = 'passed';
          writePrd(projectDir, fresh);

          if (target.story.attemptCount > 0) {
            try { await extractGuardrail(projectDir, target.story.id, headBefore); } catch { /* skip */ }
          }

          appendProgress(projectDir, `Iteration ${iteration}: ${target.story.id} passed (${commitMessage})`);
          console.log(`  PASSED: ${commitMessage}`);

          onIterationComplete?.({
            storyId: target.story.id, storyTitle: target.story.description,
            storyIndex: storyNum, totalStories,
            phaseName: prd.phases[target.phaseIndex].name, phaseIndex: target.phaseIndex,
            result: 'passed', attemptCount: target.story.attemptCount + 1, maxAttempts: 3, iteration,
          });
        } else {
          // Verification failed
          resetToCommit(projectDir, headBefore);
          const fresh = readPrd(projectDir);
          const s = fresh.phases[target.phaseIndex].stories[target.storyIndex];
          s.attemptCount += 1;
          s.lastError = vResult.output;
          writePrd(projectDir, fresh);
          appendFailedApproach(projectDir, target.story.id, s.attemptCount,
            `Verification failed at ${vResult.step}`, vResult.output, changedFiles.join(', '));
          appendProgress(projectDir, `Iteration ${iteration}: ${target.story.id} failed at ${vResult.step} (attempt ${s.attemptCount})`);
          console.log(`  FAILED (${vResult.step}): ${vResult.output.slice(0, 200)}`);

          onIterationComplete?.({
            storyId: target.story.id, storyTitle: target.story.description,
            storyIndex: storyNum, totalStories,
            phaseName: prd.phases[target.phaseIndex].name, phaseIndex: target.phaseIndex,
            result: 'failed', attemptCount: s.attemptCount, maxAttempts: 3, iteration, lastError: vResult.output,
          });
        }
      } else {
        // No commit
        const fresh = readPrd(projectDir);
        const s = fresh.phases[target.phaseIndex].stories[target.storyIndex];
        s.attemptCount += 1;
        s.lastError = resultText.slice(0, 500) || 'No commit produced';
        writePrd(projectDir, fresh);
        resetToCommit(projectDir, headBefore);
        appendFailedApproach(projectDir, target.story.id, s.attemptCount,
          resultText.slice(0, 500), 'No commit produced', 'No changes committed');
        appendProgress(projectDir, `Iteration ${iteration}: ${target.story.id} failed — no commit (attempt ${s.attemptCount})`);
        console.log(`  FAILED: No commit produced`);

        onIterationComplete?.({
          storyId: target.story.id, storyTitle: target.story.description,
          storyIndex: storyNum, totalStories,
          phaseName: prd.phases[target.phaseIndex].name, phaseIndex: target.phaseIndex,
          result: 'failed', attemptCount: s.attemptCount, maxAttempts: 3, iteration,
          lastError: 'No commit produced',
        });
      }
    }

    if (iteration >= maxIterations && exitReason === 'all_passed') {
      const final = readPrd(projectDir);
      if (findNextPendingStory(final)) exitReason = 'iteration_limit';
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    releaseRalphLock(projectDir);
  }

  const finalPrd = readPrd(projectDir);
  const report = buildReport(finalPrd, iteration, startTime, exitReason);
  writeReportFile(projectDir, report, finalPrd.name);
  return report;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport(prd: Prd, totalIterations: number, startTime: number, exitReason: RalphReport['exitReason']): RalphReport {
  let storiesPassed = 0, storiesFailed = 0, storiesSkipped = 0;
  const failedStories: RalphReport['failedStories'] = [];

  for (const phase of prd.phases) {
    for (const story of phase.stories) {
      if (story.status === 'passed') { storiesPassed++; }
      else if (story.status === 'failed' || story.attemptCount > 0) {
        storiesFailed++;
        failedStories.push({ id: story.id, lastError: story.lastError ?? '', attemptCount: story.attemptCount });
      } else { storiesSkipped++; }
    }
  }

  return { totalIterations, storiesPassed, storiesFailed, storiesSkipped, elapsedMs: Date.now() - startTime, exitReason, failedStories };
}

function writeReportFile(projectDir: string, report: RalphReport, prdName: string): void {
  const dur = (report.elapsedMs / 1000).toFixed(1);
  const lines = [
    `# Ralph Report: ${prdName}`, '',
    '| Metric | Value |', '|--------|-------|',
    `| Duration | ${dur}s |`, `| Iterations | ${report.totalIterations} |`,
    `| Exit Reason | ${report.exitReason} |`,
    `| Passed | ${report.storiesPassed} |`, `| Failed | ${report.storiesFailed} |`,
    `| Skipped | ${report.storiesSkipped} |`, '',
  ];

  if (report.failedStories.length > 0) {
    lines.push('## Failed Stories', '');
    for (const s of report.failedStories) {
      lines.push(`### ${s.id} (${s.attemptCount} attempts)`, '```', s.lastError || '(no error)', '```', '');
    }
  }

  fs.writeFileSync(path.join(projectDir, 'report.md'), lines.join('\n'), 'utf-8');

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Ralph Report: ${prdName}`);
  console.log(`Duration: ${dur}s | Iterations: ${report.totalIterations} | Exit: ${report.exitReason}`);
  console.log(`Passed: ${report.storiesPassed} | Failed: ${report.storiesFailed} | Skipped: ${report.storiesSkipped}`);
  if (report.failedStories.length > 0) {
    console.log('\nFailed:');
    for (const s of report.failedStories) console.log(`  ${s.id} (${s.attemptCount}x): ${s.lastError.slice(0, 100)}`);
  }
  console.log('─'.repeat(50));
}
