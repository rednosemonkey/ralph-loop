/**
 * Verification pipeline — automated checks after each coding iteration.
 *
 * Runs typecheck, tests, and build in fail-fast order.
 * Enforces file allowlists to prevent test tampering.
 * Truncates output to prevent context exhaustion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  step: 'allowlist' | 'typecheck' | 'test' | 'build';
  output: string;
}

export interface ProjectChecks {
  typecheck: { cmd: string; args: string[] } | null;
  test: { cmd: string; args: string[] } | null;
  build: { cmd: string; args: string[] } | null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Detect available verification checks from project config files. */
export function detectChecks(projectDir: string): ProjectChecks {
  const checks: ProjectChecks = { typecheck: null, test: null, build: null };

  // TypeScript typecheck
  if (fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    checks.typecheck = { cmd: 'npx', args: ['tsc', '--noEmit'] };
  }

  // Python typecheck (fallback)
  if (!checks.typecheck) {
    if (fs.existsSync(path.join(projectDir, 'pyproject.toml')) ||
        fs.existsSync(path.join(projectDir, 'setup.py'))) {
      checks.typecheck = { cmd: 'mypy', args: ['.'] };
    }
  }

  // Tests and build from package.json
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.test) checks.test = { cmd: 'npm', args: ['test'] };
      if (pkg.scripts?.build) checks.build = { cmd: 'npm', args: ['run', 'build'] };
    } catch { /* malformed package.json */ }
  }

  // Python tests (fallback)
  if (!checks.test) {
    if (fs.existsSync(path.join(projectDir, 'pyproject.toml')) &&
        fs.existsSync(path.join(projectDir, 'tests'))) {
      checks.test = { cmd: 'pytest', args: [] };
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/** Truncate output to prevent context exhaustion (50 lines, 4000 chars). */
export function truncateOutput(output: string, maxLines = 50, maxChars = 4000): string {
  const lines = output.split('\n');
  let truncated = lines.length > maxLines
    ? lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} lines truncated)`
    : output;
  if (truncated.length > maxChars) {
    truncated = truncated.slice(0, maxChars) + '\n... (output truncated at 4000 chars)';
  }
  return truncated;
}

// ---------------------------------------------------------------------------
// File Allowlist
// ---------------------------------------------------------------------------

const PROTECTED_EXTENSIONS = [
  '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx',
  '.test.js', '.spec.js', '.test.jsx', '.spec.jsx',
];
const PROTECTED_SUFFIXES = ['_test.py', '_test.go'];
const PROTECTED_DIRS = ['__tests__/', 'tests/'];

/** Check if a file path matches a protected test file pattern. */
export function isProtectedFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (PROTECTED_EXTENSIONS.some(ext => basename.endsWith(ext))) return true;
  if (basename.startsWith('test_') && basename.endsWith('.py')) return true;
  if (PROTECTED_SUFFIXES.some(sfx => basename.endsWith(sfx))) return true;
  if (PROTECTED_DIRS.some(d => filePath.includes(`/${d}`) || filePath.startsWith(d))) return true;
  return false;
}

function fileExistedBefore(projectDir: string, filePath: string, beforeSha: string): boolean {
  try {
    execFileSync('git', ['show', `${beforeSha}:${filePath}`], {
      cwd: projectDir, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch { return false; }
}

/** Check if changed files violate the allowlist. New test files are permitted. */
export function checkAllowlist(
  changedFiles: string[],
  projectDir: string,
  beforeSha: string,
): { violated: boolean; files: string[] } {
  const violations = changedFiles.filter(
    f => isProtectedFile(f) && fileExistedBefore(projectDir, f, beforeSha),
  );
  return { violated: violations.length > 0, files: violations };
}

// ---------------------------------------------------------------------------
// Verification Runner
// ---------------------------------------------------------------------------

function runStep(cmd: string, args: string[], projectDir: string, timeoutMs = 120_000) {
  try {
    execFileSync(cmd, args, {
      cwd: projectDir, encoding: 'utf-8', timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, output: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { passed: false, output: truncateOutput([e.stdout ?? '', e.stderr ?? ''].join('\n')) };
  }
}

/** Run verification pipeline in fail-fast order: allowlist → typecheck → test → build. */
export function runVerification(
  projectDir: string,
  beforeSha: string,
  changedFiles: string[],
): VerificationResult {
  const allowlist = checkAllowlist(changedFiles, projectDir, beforeSha);
  if (allowlist.violated) {
    return { passed: false, step: 'allowlist', output: `modified protected test file: ${allowlist.files.join(', ')}` };
  }

  const checks = detectChecks(projectDir);
  const steps: Array<{ name: VerificationResult['step']; check: ProjectChecks['typecheck'] }> = [
    { name: 'typecheck', check: checks.typecheck },
    { name: 'test', check: checks.test },
    { name: 'build', check: checks.build },
  ];

  for (const { name, check } of steps) {
    if (!check) continue;
    const result = runStep(check.cmd, check.args, projectDir);
    if (!result.passed) return { passed: false, step: name, output: result.output };
  }

  return { passed: true, step: 'build', output: '' };
}
