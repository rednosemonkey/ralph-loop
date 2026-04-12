# Ralph Loop

Autonomous coding loop powered by Claude. Give it a PRD (product requirements document) with user stories, and it iterates through them — coding, verifying, and retrying until everything passes.

## How it works

```
prd.json → pick next story → Claude codes it → verify (typecheck/test/build)
                ↑                                          |
                |         passed? → commit, next story     |
                |         failed? → record failure, retry  |
                └──────────────────────────────────────────┘
```

Key features:
- **Fresh context each iteration** — no accumulated hallucinations
- **Git commit detection** — success = new commit, failure = reset
- **Verification pipeline** — typecheck, tests, build (fail-fast)
- **Circuit breaker** — 3 attempts per story, then skip
- **Independent review** — Sonnet reviews each commit against acceptance criteria
- **Guardrail learning** — extracts patterns from retry successes
- **BLOCKED/DECIDE signals** — agent can pause for human input

## Install

```bash
npm install -g ralph-loop
# or use directly
npx ralph-loop
```

Requires Node.js 22+ and either:
- `ANTHROPIC_API_KEY` environment variable, or
- Claude Code configured (`claude login`)

## Quick Start

```bash
cd your-project

# Option A: Generate a PRD from a description
ralph plan "Build a REST API with CRUD endpoints for managing todos"

# Option B: Create a template and edit manually
ralph init
# Edit prd.json with your stories

# Make sure you have a git repo
git init && git add -A && git commit -m "initial"

# Run the loop
ralph run
```

## Commands

### `ralph init`

Creates a template `prd.json` in the current directory that you can edit.

### `ralph plan <description>`

Uses Claude to analyze your project and generate a `prd.json` based on your description.

```bash
ralph plan "Add authentication with JWT tokens and a /login endpoint"
ralph plan --model claude-sonnet-4-6 "Simple CLI tool for converting CSV to JSON"
```

### `ralph run`

Runs the autonomous coding loop. Iterates through pending stories, spawning Claude to implement each one.

```bash
ralph run                          # defaults to Opus
ralph run --model claude-sonnet-4-6  # use Sonnet (faster, cheaper)
ralph run --no-review              # skip independent review step
ralph run -n 10                    # limit to 10 iterations
```

Press `Ctrl+C` to stop gracefully after the current iteration.

### `ralph status`

Shows current progress of all stories in the PRD.

### `ralph reset [storyId]`

Resets a specific story (or all stories) back to pending, clearing attempt counts and state files.

```bash
ralph reset                 # reset everything
ralph reset phase1-story3   # reset one story
```

## PRD Format

```json
{
  "name": "My Project",
  "description": "What the project does",
  "techStack": "Node.js/TypeScript",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "phases": [
    {
      "name": "Phase 1: Foundation",
      "stories": [
        {
          "id": "phase1-story1",
          "description": "Set up Express server with health endpoint",
          "verificationSteps": [
            "TypeScript compiles without errors",
            "GET /health returns 200 with {status: 'ok'}"
          ],
          "status": "pending",
          "attemptCount": 0
        }
      ]
    }
  ]
}
```

## State Files

Ralph creates these files in your project directory during execution:

| File | Purpose |
|------|---------|
| `prd.json` | Source of truth for stories and their status |
| `progress.txt` | Append-only log of iteration outcomes |
| `failed_approaches.md` | What was tried and why it failed |
| `guardrails.md` | Learned patterns from retry successes |
| `responses.json` | User responses to BLOCKED/DECIDE signals |
| `report.md` | Final summary after loop completes |
| `.ralph.lock` | PID lock file (auto-cleaned) |

Add these to `.gitignore` if you don't want them committed:
```
progress.txt
failed_approaches.md
guardrails.md
responses.json
report.md
.ralph.lock
```

## Architecture

Ralph is extracted from [Ziggy](https://github.com/rednosemonkey/ziggy)'s pipeline system, simplified into a standalone CLI. Key differences from the original:

- **No containers** — uses the Agent SDK directly on your machine
- **No web UI** — pure CLI with readline for interactive prompts
- **No memory system** — fresh context each iteration (by design)
- **Self-contained** — single npm package, no external services

## License

MIT
