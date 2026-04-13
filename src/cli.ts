/**
 * Ralph Loop CLI — autonomous coding loop powered by Claude.
 *
 * Commands:
 *   ralph init              Create a template prd.json
 *   ralph plan <desc>       Generate prd.json from a description using Claude
 *   ralph run               Run the coding loop
 *   ralph status            Show current PRD progress
 *   ralph reset [storyId]   Reset a story (or all) to pending
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js';
import { readPrd, writePrd } from './state.js';
import { runRalphLoop } from './ralph.js';
import { PLANNER_SYSTEM_PROMPT } from './prompt.js';

const program = new Command();

program
  .name('ralph')
  .description('Autonomous coding loop powered by Claude')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// ralph init
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Create a template prd.json in the current directory')
  .action(() => {
    const prdPath = path.join(process.cwd(), 'prd.json');
    if (fs.existsSync(prdPath)) {
      console.error('prd.json already exists. Delete it first or use "ralph plan" to regenerate.');
      process.exit(1);
    }

    const template = {
      name: 'My Project',
      description: 'Describe what this project does',
      techStack: 'Node.js/TypeScript',
      createdAt: new Date().toISOString(),
      phases: [
        {
          name: 'Phase 1: Foundation',
          stories: [
            {
              id: 'phase1-story1',
              description: 'Describe what to implement',
              verificationSteps: ['TypeScript compiles without errors', 'Tests pass'],
              status: 'pending',
              attemptCount: 0,
            },
          ],
        },
      ],
    };

    fs.writeFileSync(prdPath, JSON.stringify(template, null, 2), 'utf-8');
    console.log('Created prd.json — edit it with your stories and run "ralph run"');
  });

// ---------------------------------------------------------------------------
// ralph plan
// ---------------------------------------------------------------------------

program
  .command('plan')
  .description('Generate prd.json from a description using Claude')
  .argument('<description>', 'What you want to build')
  .option('-m, --model <model>', 'Model to use for planning', 'claude-opus-4-6')
  .action(async (description: string, opts: { model: string }) => {
    const projectDir = process.cwd();
    const prdPath = path.join(projectDir, 'prd.json');

    if (fs.existsSync(prdPath)) {
      console.error('prd.json already exists. Delete it first to regenerate.');
      process.exit(1);
    }

    console.log(`Planning: "${description}"`);
    console.log('Reading project and generating PRD...\n');

    const planPrompt = [
      `Generate a prd.json for this project.`,
      '',
      `## User Request`,
      description,
      '',
      `## Instructions`,
      `1. Read the project directory to understand existing code, structure, and tech stack.`,
      `2. Ask the user clarifying questions about scope and requirements using AskUserQuestion.`,
      `3. Design a phased implementation plan with concrete, verifiable stories.`,
      `4. Write prd.json to the project root using the Write tool.`,
      `5. Output a brief summary of the plan.`,
    ].join('\n');

    try {
      const response = query({
        prompt: planPrompt,
        options: {
          model: opts.model,
          systemPrompt: PLANNER_SYSTEM_PROMPT,
          tools: { type: 'preset' as const, preset: 'claude_code' as const },
          cwd: projectDir,
          permissionMode: 'acceptEdits' as const,
          allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep', 'AskUserQuestion'],
          disallowedTools: ['CronCreate', 'CronDelete', 'CronList'],
        },
      });

      let resultText = '';
      for await (const msg of response) {
        if (msg.type === 'result' && (msg as SDKResultMessage).subtype === 'success') {
          resultText = (msg as Extract<SDKResultMessage, { subtype: 'success' }>).result;
        }
      }

      // Verify prd.json was created
      if (fs.existsSync(prdPath)) {
        const prd = readPrd(projectDir);
        const totalStories = prd.phases.reduce((sum, p) => sum + p.stories.length, 0);
        console.log(`\nPRD created: ${prd.name}`);
        console.log(`${prd.phases.length} phase(s), ${totalStories} story/stories`);
        console.log('\nRun "ralph run" to start the coding loop.');
      } else {
        console.log('\nPlanning output:');
        console.log(resultText);
        console.error('\nWarning: prd.json was not created. Check the output above.');
      }
    } catch (err) {
      console.error('Planning failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// ralph run
// ---------------------------------------------------------------------------

program
  .command('run')
  .description('Run the autonomous coding loop')
  .option('-m, --model <model>', 'Model for coding iterations', 'claude-opus-4-6')
  .option('-n, --max-iterations <n>', 'Maximum iterations', parseInt)
  .option('--no-review', 'Disable independent review step')
  .action(async (opts: { model: string; maxIterations?: number; review: boolean }) => {
    const projectDir = process.cwd();

    if (!fs.existsSync(path.join(projectDir, 'prd.json'))) {
      console.error('No prd.json found. Run "ralph init" or "ralph plan <description>" first.');
      process.exit(1);
    }

    if (!fs.existsSync(path.join(projectDir, '.git'))) {
      console.error('Not a git repository. Initialize git first: git init && git add -A && git commit -m "initial"');
      process.exit(1);
    }

    const prd = readPrd(projectDir);
    const totalStories = prd.phases.reduce((sum, p) => sum + p.stories.length, 0);
    const pending = prd.phases.reduce((sum, p) => sum + p.stories.filter(s => s.status === 'pending').length, 0);

    console.log(`Ralph Loop: ${prd.name}`);
    console.log(`Stories: ${totalStories} total, ${pending} pending`);
    console.log(`Model: ${opts.model} | Review: ${opts.review ? 'on' : 'off'}`);
    console.log('Press Ctrl+C to stop gracefully.\n');

    try {
      const report = await runRalphLoop({
        projectDir,
        model: opts.model,
        maxIterations: opts.maxIterations,
        review: opts.review,
      });

      process.exit(report.exitReason === 'all_passed' ? 0 : 1);
    } catch (err) {
      console.error('Ralph loop failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// ralph status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show current PRD progress')
  .action(() => {
    const projectDir = process.cwd();
    if (!fs.existsSync(path.join(projectDir, 'prd.json'))) {
      console.error('No prd.json found.');
      process.exit(1);
    }

    const prd = readPrd(projectDir);
    console.log(`Project: ${prd.name}`);
    console.log(`Tech: ${prd.techStack}\n`);

    for (const phase of prd.phases) {
      const passed = phase.stories.filter(s => s.status === 'passed').length;
      console.log(`${phase.name} (${passed}/${phase.stories.length})`);

      for (const story of phase.stories) {
        const icon = story.status === 'passed' ? '\u2713' : story.status === 'failed' ? '\u2717' : '\u25CB';
        const attempt = story.attemptCount > 0 ? ` [${story.attemptCount}/3]` : '';
        console.log(`  ${icon} ${story.id}: ${story.description}${attempt}`);
        if (story.lastError) {
          console.log(`    Error: ${story.lastError.slice(0, 100)}`);
        }
      }
      console.log();
    }
  });

// ---------------------------------------------------------------------------
// ralph reset
// ---------------------------------------------------------------------------

program
  .command('reset')
  .description('Reset a story (or all stories) to pending')
  .argument('[storyId]', 'Story ID to reset (omit to reset all)')
  .action((storyId?: string) => {
    const projectDir = process.cwd();
    if (!fs.existsSync(path.join(projectDir, 'prd.json'))) {
      console.error('No prd.json found.');
      process.exit(1);
    }

    const prd = readPrd(projectDir);
    let count = 0;

    for (const phase of prd.phases) {
      for (const story of phase.stories) {
        if (!storyId || story.id === storyId) {
          story.status = 'pending';
          story.attemptCount = 0;
          story.lastError = undefined;
          count++;
        }
      }
    }

    if (storyId && count === 0) {
      console.error(`Story "${storyId}" not found.`);
      process.exit(1);
    }

    writePrd(projectDir, prd);

    // Clean state files
    for (const f of ['progress.txt', 'failed_approaches.md', 'guardrails.md', 'responses.json', 'report.md']) {
      try { fs.unlinkSync(path.join(projectDir, f)); } catch { /* doesn't exist */ }
    }

    console.log(`Reset ${count} story/stories to pending. State files cleaned.`);
  });

// ---------------------------------------------------------------------------
// ralph install-skill
// ---------------------------------------------------------------------------

program
  .command('install-skill')
  .description('Install the Ralph skill for Claude Code')
  .option('--project', 'Install to current project (.claude/skills/) instead of user-level')
  .action((opts: { project?: boolean }) => {
    const skillSource = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..', 'skill', 'ralph.md',
    );

    // Check if the bundled skill file exists (handles both dist/ and src/ layouts)
    let source = skillSource;
    if (!fs.existsSync(source)) {
      // Try one more level up (when running from dist/)
      source = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'skill', 'ralph.md');
    }
    if (!fs.existsSync(source)) {
      console.error('Could not find bundled skill file. Try reinstalling: npm install -g ralph-loop');
      process.exit(1);
    }

    const home = process.env.HOME || process.env.USERPROFILE || '';
    const targetDir = opts.project
      ? path.join(process.cwd(), '.claude', 'skills')
      : path.join(home, '.claude', 'skills');

    const targetFile = path.join(targetDir, 'ralph.md');

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, targetFile);

    if (opts.project) {
      console.log(`Skill installed to ${targetFile}`);
      console.log('Ralph will trigger in this project when you ask Claude Code to build something.');
    } else {
      console.log(`Skill installed to ${targetFile}`);
      console.log('Ralph will trigger in ALL Claude Code projects when you ask to build something.');
    }
  });

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------

program.parse();
