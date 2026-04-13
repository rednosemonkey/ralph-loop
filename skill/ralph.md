---
name: ralph
description: Autonomous coding loop. Trigger when the user wants to BUILD something non-trivial — a new feature, module, app, or multi-file change. Examples: "build me a dashboard", "add authentication", "create a REST API", "implement the payment flow". Do NOT trigger for debugging, code review, single-file tweaks, or questions about existing code.
keywords: [build, implement, create, scaffold, new project, app, feature, pipeline, service, API, application, module]
---

**When this skill guides your response, begin with:** `[Using ralph skill]` on its own line.

You orchestrate the Ralph autonomous coding loop. Ralph takes a PRD (product requirements document) with user stories and iterates through them — coding, verifying, and retrying until everything passes.

## Prerequisites

Ralph must be installed: `npm install -g ralph-loop`

If not installed, tell the user to install it first and stop.

## Workflow

### Step 1 — Understand the Request

Read the user's message to understand what they want built. Consider:
- Is this a new project or adding to an existing one?
- How complex is it? (Ralph is for multi-story work, not single-file tweaks)

If the request is a single small change (one file, one function), just do it directly — don't invoke Ralph.

### Step 2 — Plan the PRD

Run the interactive planner:

```bash
ralph plan "<user's description>"
```

This spawns a Claude session that:
1. Reads the project codebase
2. Asks the user clarifying questions
3. Generates `prd.json` with phased stories and verification steps

Wait for it to complete, then show the user the generated plan:

```bash
ralph status
```

Ask if they want to adjust anything. If so, they can edit `prd.json` directly or you can edit it for them.

### Step 3 — Run the Loop

Once the PRD is confirmed:

```bash
ralph run
```

This runs autonomously — iterating through stories, coding, verifying (typecheck/test/build), and retrying failures. It will:
- Stop and ask for input if a story is BLOCKED or needs a DECISION
- Pause at phase boundaries for multi-phase projects
- Exit when all stories pass, hit the circuit breaker, or reach the iteration limit

### Step 4 — Review Results

After the loop completes, show the user the results:

```bash
ralph status
cat report.md
```

If any stories failed, discuss options: reset and retry, adjust the PRD, or fix manually.

## Options

| Flag | Description |
|------|-------------|
| `--model <model>` | Model for coding (default: claude-opus-4-6) |
| `--no-review` | Skip independent Sonnet review step |
| `-n <max>` | Limit iterations |

## Key Concepts

- **Fresh context**: Each iteration starts from scratch — no accumulated hallucinations
- **Git-based success**: A story passes only if it produces a commit that passes verification
- **Circuit breaker**: 3 failed attempts per story, then skip
- **Verification**: Typecheck + tests + build must all pass
- **State files**: prd.json, progress.txt, failed_approaches.md, guardrails.md track everything
