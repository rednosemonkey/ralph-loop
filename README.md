# Ralph Loop

Autonomous coding loop powered by Claude. Give it a PRD with user stories, and it iterates through them — coding, verifying, and retrying until everything passes.

## How it works

```
You describe what to build
        ↓
Claude Code asks questions, writes prd.json    ← planning (interactive)
        ↓
ralph run                                       ← coding loop (autonomous)
        ↓
pick next story → fresh Claude session → code → verify (typecheck/test/build)
       ↑                                              |
       |         passed? → commit, next story         |
       |         failed? → git reset, record, retry   |
       └──────────────────────────────────────────────┘
```

The work is split between two systems:
- **Claude Code handles planning** — it's already in conversation with you, so it asks clarifying questions, reads your codebase, and writes the PRD
- **`ralph run` handles coding** — each story gets a fresh Claude session with no accumulated context, so hallucinations don't compound across iterations

## Install

```bash
npm install -g ralph-loop
```

Requires Node.js 22+ and either:
- `ANTHROPIC_API_KEY` environment variable, or
- Claude Code configured (`claude login`)

## Usage with Claude Code (recommended)

The primary way to use Ralph is through the Claude Code skill. This gives you interactive planning with the full coding loop.

### 1. Add the skill to your project

```bash
mkdir -p .claude/skills
cp $(npm root -g)/ralph-loop/skill/ralph.md .claude/skills/ralph.md
```

### 2. Ask Claude Code to build something

Just describe what you want in natural language:

> "Add JWT authentication with a /login endpoint and protected routes"

> "Build a dashboard that shows real-time metrics from the database"

> "Create a CLI tool that converts CSV files to JSON with column filtering"

Claude Code will:
1. Read your codebase to understand the existing structure
2. Ask you clarifying questions about scope and requirements
3. Write `prd.json` with phased stories and verification steps
4. Show you the plan for confirmation
5. Run `ralph run` to execute the coding loop autonomously

### 3. Monitor and review

The loop prints progress to stdout as it works through stories. When it's done, Claude Code shows you the results and helps with any failures.

## How Ralph uses git

Ralph commits directly to your project's current branch. This is important to understand:

- **Successful stories** become real commits (e.g., `feat: implement user authentication`)
- **Failed attempts** are rolled back with `git reset --hard` — no trace in history
- **State files** (progress.txt, failed_approaches.md) are written but not committed
- Ralph requires at least one existing commit as a baseline

**Recommendation:** Work on a feature branch if you want to isolate Ralph's work from main.

The skill checks for a git repo before running and initializes one if needed. If you have uncommitted changes, it commits them first so Ralph has a clean baseline.

## CLI Reference

The CLI commands are available for direct terminal usage outside Claude Code.

### `ralph plan <description>`

Interactive planning — reads your codebase, asks clarifying questions, generates `prd.json`.

```bash
ralph plan "Add authentication with JWT tokens and a /login endpoint"
ralph plan --model claude-sonnet-4-6 "Simple CLI tool for converting CSV to JSON"
```

Note: When using the Claude Code skill, planning happens in your Claude Code session directly (better UX since you're already in conversation). `ralph plan` is for standalone terminal use.

### `ralph run`

Runs the autonomous coding loop.

```bash
ralph run                            # defaults to Opus
ralph run --model claude-sonnet-4-6  # use Sonnet (faster, cheaper)
ralph run --no-review                # skip independent review step
ralph run -n 10                      # limit to 10 iterations
```

Press `Ctrl+C` to stop gracefully after the current iteration.

### `ralph init`

Creates a template `prd.json` for manual editing (alternative to `ralph plan`).

### `ralph status`

Shows current progress of all stories.

### `ralph reset [storyId]`

Resets a specific story (or all stories) back to pending.

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

## Key Concepts

| Concept | What it means |
|---------|--------------|
| **Fresh context** | Each iteration starts a new Claude session — no memory of previous attempts, no hallucination buildup |
| **Git commit detection** | Success = new commit appeared; failure = HEAD unchanged |
| **Verification pipeline** | Typecheck → tests → build, fail-fast order |
| **Circuit breaker** | 3 failed attempts per story, then skip and move on |
| **Independent review** | Sonnet reviews each commit against verification steps (fail-open) |
| **Guardrail learning** | When a retry succeeds, extracts a pattern to help future iterations |
| **BLOCKED/DECIDE signals** | Agent can pause and ask the user for input on genuine blockers |

## State Files

Ralph creates these files in your project directory during execution:

| File | Purpose |
|------|---------|
| `prd.json` | Source of truth — stories and their status |
| `progress.txt` | Append-only log of what happened each iteration |
| `failed_approaches.md` | What was tried and why it failed (prevents repeating mistakes) |
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

## Recovery from failures

| Situation | What to do |
|-----------|-----------|
| Story failed but should be retryable | `ralph reset phase1-story3` then `ralph run` |
| Verification steps were wrong | Edit prd.json, then `ralph reset <storyId>` and `ralph run` |
| Story is genuinely too hard for automation | Read `failed_approaches.md`, fix manually, update prd.json status to `"passed"` |
| Want a complete fresh start | `ralph reset` clears all state |
| Different model might work better | `ralph run --model claude-sonnet-4-6` |

## Architecture

Ralph is extracted from [Ziggy](https://github.com/rednosemonkey/ziggy)'s pipeline system, simplified into a standalone CLI.

- **No containers** — uses the Agent SDK directly on your machine
- **No web UI** — pure CLI with readline for interactive prompts
- **No memory system** — fresh context each iteration (by design)
- **Self-contained** — single npm package, no external services

## License

MIT
