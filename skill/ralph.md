---
name: ralph
description: >-
  Autonomous coding loop for building non-trivial features and projects.
  Use this skill whenever the user wants something BUILT that spans multiple
  files or needs iterative implementation — "build me a dashboard",
  "add authentication to the API", "create a REST API for todos",
  "implement the payment flow", "set up a new project for X", "replicate
  the analytics pipeline". If the user describes something they want to
  exist that currently doesn't, and it's more than a single-file tweak,
  this is the skill. Do NOT trigger for debugging, code review, explaining
  code, or simple single-file changes.
keywords: [build, implement, create, scaffold, new project, app, feature, pipeline, service, API, application, module, ralph, coding loop, autonomous]
---

**When this skill guides your response, begin with:** `[Using ralph skill]` on its own line.

You orchestrate the Ralph autonomous coding loop — a system that takes a PRD (product requirements document), then iterates through stories autonomously: coding, verifying (typecheck/tests/build), and retrying until everything passes.

Your role is split in two:
1. **You handle planning** — ask the user questions, understand requirements, write prd.json
2. **Ralph handles coding** — `ralph run` spawns isolated Claude sessions with fresh context per story

This split exists because planning needs conversation with the user (which you're good at), while coding needs fresh-context isolation per iteration (which the Ralph loop provides).

## Prerequisites

Before anything else, verify these two things:

**1. Ralph CLI installed**

```bash
which ralph
```

If not found, tell the user: "Ralph isn't installed. Run `npm install -g ralph-coding-loop` and try again." Then stop.

**2. Git repository**

Ralph tracks progress through git commits — each successful story becomes a commit in the project's repo, and failed attempts get rolled back with `git reset --hard`. This means the project needs a git repo with at least one commit.

```bash
git rev-parse --git-dir 2>/dev/null
```

If not a git repo, initialize one:

```bash
git init && git add -A && git commit -m "initial commit before ralph loop"
```

If there are uncommitted changes, commit them first so Ralph has a clean baseline:

```bash
git add -A && git commit -m "save work before ralph loop"
```

## Step 1 — Understand the Request

Read the user's message. Consider:
- Is this a new project from scratch, or adding to existing code?
- How complex is it?

**If the request is a single small change** (one file, one function, a config tweak), just do it directly yourself — Ralph is overkill. Only use Ralph for multi-file, multi-story work.

## Step 2 — Plan the PRD

This is your job, not Ralph's. You have the conversation with the user and you have the tools to read the codebase. Use both.

### 2a. Read the project

Examine the existing code to understand the tech stack, conventions, and structure. Use Read, Glob, and Grep to get oriented. This context is essential for writing good stories — you need to know what already exists before planning what to build.

### 2b. Ask clarifying questions

Use AskUserQuestion to ask about scope and requirements. Focus on:
- **Product behavior**: What should the user see? What are the inputs and outputs?
- **Scope boundaries**: What's in v1 vs later? Any hard constraints?
- **Integration**: Does it connect to existing APIs, databases, or services?
- **Edge cases**: Any important error handling or special cases?

Do NOT ask about tech stack or framework choices — infer those from the codebase.

Ask one question at a time. Typically 3-6 questions is enough. Stop when you have enough detail to write concrete verification steps for each story.

If the user's request is already very specific, you can skip to fewer questions or go straight to writing the PRD.

### 2c. Write prd.json

Based on what you learned, write `prd.json` to the project root:

```json
{
  "name": "Project Name",
  "description": "What the project does",
  "techStack": "e.g. Node.js/TypeScript",
  "createdAt": "2026-04-13T00:00:00.000Z",
  "phases": [
    {
      "name": "Phase 1: Foundation",
      "stories": [
        {
          "id": "phase1-story1",
          "description": "What to implement",
          "verificationSteps": [
            "TypeScript compiles without errors",
            "GET /health returns 200"
          ],
          "status": "pending",
          "attemptCount": 0
        }
      ]
    }
  ]
}
```

Guidelines for good stories:
- **Small and focused** — one clear deliverable per story
- **Sequential** — each story can build on the previous one's output
- **1-3 verification steps** — short, concrete, automatable assertions ("TypeScript compiles", "tests pass", "endpoint returns 200")
- Story IDs follow `phase{N}-story{M}` format
- If the project already has code, build on it — don't start from scratch

### 2d. Confirm with the user

Show a summary of the plan and ask if they want changes. You can edit prd.json directly based on their feedback. Once confirmed, move to Step 3.

## Step 3 — Run the Loop

```bash
ralph run
```

This runs autonomously. Each iteration:
1. Picks the next pending story from prd.json
2. Spawns a fresh Claude session with full context (PRD, progress, failed approaches, file tree)
3. Claude codes the story and commits
4. Ralph verifies: typecheck → tests → build (all must pass)
5. If passed: story marked done, commit stays
6. If failed: `git reset --hard`, failure recorded, retry with different approach
7. After 3 failures on the same story: circuit breaker skips it

The loop exits when all stories pass, iteration limit is reached, or the circuit breaker fires.

### Options

| Flag | Effect |
|------|--------|
| `--model <model>` | Model for coding iterations (default: claude-opus-4-6) |
| `--no-review` | Skip the independent Sonnet review step (faster, less rigorous) |
| `-n <max>` | Cap the number of iterations |

### Monitoring

The loop prints progress to stdout. If it pauses for a BLOCKED or DECIDE signal, it will prompt the user for input in the terminal.

## Step 4 — Review Results

After the loop completes:

```bash
ralph status
```

This shows each story's pass/fail status. Also read `report.md` for the full summary.

### If stories failed

Common recovery paths:
- **Reset and retry**: `ralph reset phase1-story3` then `ralph run` — useful if the failure was a fluke or you want to try a different model
- **Edit the PRD**: If a story's verification steps were wrong or too ambitious, edit prd.json to fix them, then `ralph reset <storyId>` and `ralph run`
- **Fix manually**: For stubborn failures, read `failed_approaches.md` to understand what was tried, then implement the fix yourself and mark the story as passed in prd.json
- **Reset everything**: `ralph reset` clears all state and starts fresh

## How Ralph Uses Git

Ralph commits directly to the project's current branch. Understanding this is important:

- **Successful stories** become real commits in the project history (e.g., `feat: implement user authentication`)
- **Failed attempts** are rolled back with `git reset --hard` to the pre-iteration state — they leave no trace in history
- **State files** (progress.txt, failed_approaches.md, guardrails.md) are written to the project directory but not committed by Ralph
- The user should be on a **feature branch** if they want to isolate Ralph's work from main
