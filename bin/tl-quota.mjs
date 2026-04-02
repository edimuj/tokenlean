#!/usr/bin/env node

/**
 * tl-quota - Check AI subscription quota (Claude Code, Codex)
 *
 * Usage: tl-quota [claude|codex] [-j] [-q]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-quota',
    desc: 'Check AI subscription quota usage',
    when: 'before-read',
    example: 'tl-quota'
  }));
  process.exit(0);
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from 'node:https';
import { spawn } from 'node:child_process';
import { createOutput, parseCommonArgs, COMMON_OPTIONS_HELP } from '../src/output.mjs';

const HELP = `
tl-quota - Check AI subscription quota usage

Usage: tl-quota [provider...] [options]

Providers:
  claude          Claude Code (Max/Pro subscription)
  codex           OpenAI Codex CLI

  No argument = check all available providers.

Options:
${COMMON_OPTIONS_HELP}
Examples:
  tl-quota                  # all providers
  tl-quota claude           # Claude only
  tl-quota codex            # Codex only
  tl-quota -j               # JSON output
  tl-quota -q               # compact one-liner
`;

const PROVIDERS = ['claude', 'codex'];

// ── Fetchers ──────────────────────────────────────────────────

async function fetchClaudeQuota() {
  const credsPath = join(homedir(), '.claude', '.credentials.json');
  let token;
  try {
    const creds = JSON.parse(await readFile(credsPath, 'utf8'));
    token = creds.claudeAiOauth?.accessToken;
  } catch {
    return null;
  }
  if (!token) return null;

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        timeout: 5_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            const raw = JSON.parse(body);
            resolve({
              burst: raw.five_hour ? {
                utilization: raw.five_hour.utilization,
                resetsAt: raw.five_hour.resets_at,
              } : null,
              weekly: raw.seven_day ? {
                utilization: raw.seven_day.utilization,
                resetsAt: raw.seven_day.resets_at,
              } : null,
            });
          } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function fetchCodexQuota() {
  return new Promise((resolve) => {
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let reqId = 0;
    const pending = new Map();

    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 10_000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (let nl = stdout.indexOf('\n'); nl !== -1; nl = stdout.indexOf('\n')) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const cb = pending.get(msg.id);
          if (cb) { pending.delete(msg.id); cb(msg); }
        } catch { /* ignore non-JSON */ }
      }
    });

    proc.on('error', () => { clearTimeout(timer); resolve(null); });

    function rpc(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++reqId;
        pending.set(id, (msg) => {
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    (async () => {
      try {
        await rpc('initialize', { clientInfo: { name: 'tl-quota', version: '1.0.0' } });
        const result = await rpc('account/rateLimits/read');
        clearTimeout(timer);
        proc.kill();

        const limits = result.rateLimits;
        if (!limits) { resolve(null); return; }

        resolve({
          burst: limits.primary ? {
            utilization: limits.primary.usedPercent,
            resetsAt: new Date(limits.primary.resetsAt * 1000).toISOString(),
          } : null,
          weekly: limits.secondary ? {
            utilization: limits.secondary.usedPercent,
            resetsAt: new Date(limits.secondary.resetsAt * 1000).toISOString(),
          } : null,
        });
      } catch {
        clearTimeout(timer);
        proc.kill();
        resolve(null);
      }
    })();
  });
}

// ── Formatting ────────────────────────────────────────────────

function timeUntil(isoString) {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hrs = Math.floor(totalMin / 60);
  const rem = totalMin % 60;
  return rem > 0 ? `${hrs}h${rem}m` : `${hrs}h`;
}

function resetLabel(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';

  const diffHrs = diffMs / 3_600_000;
  // Under 24h: just show relative time
  if (diffHrs < 24) return timeUntil(isoString);

  // Over 24h: show weekday + time + relative
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${time} (${timeUntil(isoString)})`;
}

function bar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatProvider(name, quota, quiet) {
  if (!quota) return quiet ? `${name}: unavailable` : null;

  if (quiet) {
    const parts = [name + ':'];
    if (quota.burst) parts.push(`5h ${quota.burst.utilization}%`);
    if (quota.weekly) parts.push(`7d ${quota.weekly.utilization}%`);
    return parts.join(' ');
  }

  const lines = [];
  if (quota.burst) {
    const pct = quota.burst.utilization;
    lines.push(`  5h  ${bar(pct)} ${String(pct).padStart(3)}%  ↻${timeUntil(quota.burst.resetsAt)}`);
  }
  if (quota.weekly) {
    const pct = quota.weekly.utilization;
    lines.push(`  7d  ${bar(pct)} ${String(pct).padStart(3)}%  ↻${resetLabel(quota.weekly.resetsAt)}`);
  }
  return lines.length > 0 ? lines : null;
}

// ── Main ──────────────────────────────────────────────────────

const FETCHER_MAP = { claude: fetchClaudeQuota, codex: fetchCodexQuota };

async function main() {
  const opts = parseCommonArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP.trim());
    process.exit(0);
  }

  // Parse provider args
  const requested = opts.remaining
    .map(a => a.toLowerCase().replace('claude-code', 'claude'))
    .filter(a => PROVIDERS.includes(a));
  const providers = requested.length > 0 ? requested : PROVIDERS;

  // Fetch all in parallel
  const results = await Promise.all(
    providers.map(async (name) => {
      const fetcher = FETCHER_MAP[name];
      const quota = fetcher ? await fetcher() : null;
      return { name, quota };
    })
  );

  // Filter to providers that responded (unless explicitly requested)
  const available = requested.length > 0
    ? results
    : results.filter(r => r.quota !== null);

  if (available.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ providers: [] }));
    } else {
      console.error('No quota data available. Check credentials.');
    }
    process.exit(1);
  }

  // JSON mode
  if (opts.json) {
    const data = {};
    for (const { name, quota } of available) {
      data[name] = quota;
    }
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }

  // Quiet mode: one-liner
  if (opts.quiet) {
    const parts = available.map(({ name, quota }) => formatProvider(name, quota, true));
    console.log(parts.join(' | '));
    process.exit(0);
  }

  // Normal output
  const out = createOutput(opts);
  for (const { name, quota } of available) {
    const lines = formatProvider(name, quota, false);
    if (lines) {
      out.add(name);
      out.addLines(lines);
    } else {
      out.add(`${name}: unavailable`);
    }
  }
  out.print();
}

main();
