#!/usr/bin/env node

/**
 * tl-publish - Publish to npm with an availability gate
 *
 * Publishes the current package, then polls the registry until npm itself can
 * resolve the published version (using --prefer-online to defeat stale cached
 * metadata — the usual cause of post-publish `npm install` 404s). Optionally
 * bumps the version first and installs the new version globally.
 *
 * Version-bump *reasoning* (deciding patch/minor/major from commit history) is
 * intentionally NOT done here — that needs judgment and lives in the /publish
 * skill. This tool is the mechanical core it calls.
 *
 * Usage: tl-publish [patch|minor|major] [--install-globally] [--verify "cmd"]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-publish',
    desc: 'Publish to npm, wait until installable, optionally reinstall globally',
    when: 'release',
    example: 'tl-publish patch --install-globally'
  }));
  process.exit(0);
}

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';

const HELP = `
tl-publish - Publish to npm with an availability gate

Usage: tl-publish [patch|minor|major] [options]

Publishes the current package to npm, then polls the registry until npm can
actually resolve the new version (--prefer-online, defeating stale cache —
the usual reason a fresh-published version 404s on install). Optionally bumps
the version first and reinstalls it globally the way a user would.

Bump argument (optional):
  patch | minor | major   Run 'npm version <type>' first (commit + tag).
                          Requires a clean working tree. Omit to publish the
                          version already in package.json.

Options:
  --install-globally, -g  After the gate passes, 'npm install -g <pkg>@<ver>'
  --verify "<cmd>"        Run <cmd> after install to confirm it works (e.g.
                          "tl push --help"); its exit code is reported
  --tag <dist-tag>        Publish under a npm dist-tag (default: latest)
  --no-push               Don't 'git push --follow-tags' after a version bump
  --no-wait               Skip the availability gate (publish and return)
  --timeout <seconds>     Max seconds to wait for the gate (default: 120)
  --dry-run               Show the plan without executing
${COMMON_OPTIONS_HELP}

Examples:
  tl-publish                              # Publish current version, wait
  tl-publish patch -g                     # Bump patch, publish, wait, reinstall
  tl-publish minor -g --verify "tl --help"
  tl-publish --no-wait                    # Fire-and-forget publish
`;

function run(cmd, args, opts = {}) {
  const proc = spawnSync(cmd, args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    ...opts
  });
  return {
    ok: proc.status === 0,
    status: proc.status,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim()
  };
}

function readPkg() {
  try {
    return JSON.parse(readFileSync('package.json', 'utf-8'));
  } catch (e) {
    console.error(`Error: cannot read package.json: ${e.message}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

let bump = null;
let installGlobally = false;
let verifyCmd = null;
let distTag = null;
let noPush = false;
let noWait = false;
let dryRun = false;
let timeoutSec = 120;

const remaining = options.remaining;
for (let i = 0; i < remaining.length; i++) {
  const arg = remaining[i];
  if (arg === 'patch' || arg === 'minor' || arg === 'major') bump = arg;
  else if (arg === '--install-globally' || arg === '-g') installGlobally = true;
  else if (arg === '--verify') {
    verifyCmd = remaining[++i];
    if (!verifyCmd) { console.error('Error: --verify requires a command'); process.exit(2); }
  }
  else if (arg === '--tag') {
    distTag = remaining[++i];
    if (!distTag) { console.error('Error: --tag requires a dist-tag name'); process.exit(2); }
  }
  else if (arg === '--no-push') noPush = true;
  else if (arg === '--no-wait') noWait = true;
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '--timeout') {
    timeoutSec = parseInt(remaining[++i], 10);
    if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
      console.error('Error: --timeout requires a positive number of seconds');
      process.exit(2);
    }
  }
  else {
    console.error(`Error: unknown argument: ${arg}`);
    console.error('Usage: tl-publish [patch|minor|major] [options]  (see --help)');
    process.exit(2);
  }
}

const out = createOutput(options);
const pkg = readPkg();
const name = pkg.name;
if (!name) { console.error('Error: package.json has no "name"'); process.exit(1); }

if (dryRun) {
  out.header('Dry run — would execute:');
  if (bump) out.add(`  npm version ${bump}`);
  out.add(`  npm publish${distTag ? ` --tag ${distTag}` : ''}`);
  if (bump && !noPush) out.add('  git push --follow-tags');
  if (!noWait) out.add(`  poll: npm view ${name}@<new-version> version --prefer-online (≤ ${timeoutSec}s)`);
  if (installGlobally) out.add(`  npm install -g ${name}@<new-version> --prefer-online`);
  if (verifyCmd) out.add(`  ${verifyCmd}`);
  out.print();
  process.exit(0);
}

// 1. Optional version bump (needs a clean tree; npm version enforces that).
if (bump) {
  const v = run('npm', ['version', bump]);
  if (!v.ok) {
    console.error(`npm version ${bump} failed: ${v.stderr || v.stdout}`);
    if (/Git working directory not clean/i.test(v.stderr)) {
      console.error('Commit or stash changes first (tl-publish does not auto-commit).');
    }
    process.exit(1);
  }
}

const version = readPkg().version;
if (!version) { console.error('Error: package.json has no "version"'); process.exit(1); }

// 2. Publish. Abort before pushing if this fails — never push a broken release.
const pubArgs = ['publish'];
if (distTag) pubArgs.push('--tag', distTag);
const pub = run('npm', pubArgs);
if (!pub.ok) {
  console.error(`npm publish failed: ${pub.stderr || pub.stdout}`);
  process.exit(1);
}

// 3. Push commit + tag (only meaningful when we bumped).
let pushed = false;
let pushWarn = null;
if (bump && !noPush) {
  const push = run('git', ['push', '--follow-tags']);
  pushed = push.ok;
  if (!push.ok) pushWarn = push.stderr || push.stdout;
}

// 4. Availability gate — poll until npm can resolve the version. --prefer-online
//    forces revalidation, defeating the stale local metadata that makes a
//    freshly published version 404 on install.
let waitedMs = 0;
let available = false;
if (!noWait) {
  const deadline = Date.now() + timeoutSec * 1000;
  let delay = 2000;
  while (Date.now() < deadline) {
    const view = run('npm', ['view', `${name}@${version}`, 'version', '--prefer-online']);
    if (view.ok && view.stdout === version) { available = true; break; }
    await sleep(delay);
    waitedMs += delay;
    delay = Math.min(delay + 1000, 8000);
  }
  if (!available) {
    out.add(`Published ${name}@${version} but registry did not resolve it within ${timeoutSec}s.`);
    out.add('The publish itself succeeded — try the install again shortly.');
    out.setData('published', true);
    out.setData('version', version);
    out.setData('available', false);
    out.print();
    process.exit(1);
  }
} else {
  available = true; // not checked
}

// 5. Optional global install (also --prefer-online so it sees the new version).
let installedVersion = null;
if (installGlobally) {
  const inst = run('npm', ['install', '-g', `${name}@${version}`, '--prefer-online']);
  if (!inst.ok) {
    out.add(`Published ${name}@${version} but global install failed: ${inst.stderr || inst.stdout}`);
    out.setData('published', true);
    out.setData('version', version);
    out.setData('installed', false);
    out.print();
    process.exit(1);
  }
  const ls = run('npm', ['ls', '-g', name, '--depth=0']);
  const m = ls.stdout.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@(\\S+)`));
  installedVersion = m ? m[1] : null;
}

// 6. Optional verify command against the freshly installed binary.
let verifyOk = null;
if (verifyCmd) {
  const vr = run(verifyCmd, [], { shell: true });
  verifyOk = vr.ok;
}

// 7. Summary.
out.setData('published', true);
out.setData('package', name);
out.setData('version', version);
if (distTag) out.setData('tag', distTag);
out.setData('available', available);
if (bump) out.setData('pushed', pushed);
if (installGlobally) out.setData('installed', installedVersion === version);
if (installGlobally) out.setData('installedVersion', installedVersion);
if (verifyCmd) out.setData('verified', verifyOk);

const tagStr = distTag ? ` (tag: ${distTag})` : '';
out.add(`Published ${name}@${version}${tagStr}`);
if (bump && !noPush) out.add(pushed ? 'Pushed commit + tag' : `Push failed: ${pushWarn}`);
if (!noWait) out.add(`Registry resolved it after ~${Math.round(waitedMs / 1000)}s`);
if (installGlobally) {
  out.add(installedVersion === version
    ? `Installed globally: ${name}@${installedVersion}`
    : `Global install mismatch — wanted ${version}, got ${installedVersion || 'unknown'}`);
}
if (verifyCmd) out.add(`Verify (${verifyCmd}): ${verifyOk ? 'ok' : 'FAILED'}`);

out.print();
process.exit((installGlobally && installedVersion !== version) || verifyOk === false ? 1 : 0);
