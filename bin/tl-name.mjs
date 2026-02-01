#!/usr/bin/env node

/**
 * tl-name - Check name availability across npm, GitHub, and domains
 *
 * Helps find available names for new projects by checking multiple registries.
 *
 * Usage: tl-name <name> [names...] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-name',
    desc: 'Check name availability (npm, GitHub, domains)',
    when: 'planning',
    example: 'tl-name myproject coolname'
  }));
  process.exit(0);
}

import { createOutput, parseCommonArgs, COMMON_OPTIONS_HELP } from '../src/output.mjs';
import dns from 'dns';
import { promisify } from 'util';

const dnsResolve = promisify(dns.resolve);

const HELP = `
tl-name - Check name availability across npm, GitHub, and domains

Usage: tl-name <name> [names...] [options]

Options:
  --npm-only, -n        Only check npm registry
  --github-only, -g     Only check GitHub
  --domain-only, -d     Only check domain availability
  --suggest, -s         Suggest variations if name is taken
  --tld <ext>           Domain TLD to check (default: com)
${COMMON_OPTIONS_HELP}

Examples:
  tl-name myproject                # Check all registries
  tl-name foo bar baz              # Check multiple names
  tl-name myproject -s             # Suggest variations if taken
  tl-name myproject --tld io       # Check .io domain

Checks:
  npm:    Registry availability and package info
  GitHub: Repositories, organizations, and users
  Domain: DNS lookup (no DNS = likely available)
`;

// ─────────────────────────────────────────────────────────────
// npm Registry Check
// ─────────────────────────────────────────────────────────────

async function checkNpm(name) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);

    if (response.status === 404) {
      return { available: true };
    }

    if (!response.ok) {
      return { available: null, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const latest = data['dist-tags']?.latest;
    const time = data.time?.modified || data.time?.created;
    const lastPublished = time ? getRelativeTime(new Date(time)) : null;

    return {
      available: false,
      version: latest,
      lastPublished,
      description: data.description?.slice(0, 60)
    };
  } catch (err) {
    return { available: null, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// GitHub Check (repos + orgs/users)
// ─────────────────────────────────────────────────────────────

async function checkGitHub(name) {
  const results = {
    repo: { available: null },
    user: { available: null }
  };

  try {
    // Check for exact repo match
    const repoResponse = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(name)}+in:name&per_page=5`,
      { headers: { 'Accept': 'application/vnd.github.v3+json' } }
    );

    if (repoResponse.ok) {
      const repoData = await repoResponse.json();
      const exactMatch = repoData.items?.find(
        r => r.name.toLowerCase() === name.toLowerCase()
      );

      if (exactMatch) {
        results.repo = {
          available: false,
          fullName: exactMatch.full_name,
          stars: exactMatch.stargazers_count,
          description: exactMatch.description?.slice(0, 50)
        };
      } else {
        results.repo = { available: true, similar: repoData.total_count };
      }
    }

    // Check for user/org with that name
    const userResponse = await fetch(
      `https://api.github.com/users/${encodeURIComponent(name)}`,
      { headers: { 'Accept': 'application/vnd.github.v3+json' } }
    );

    if (userResponse.status === 404) {
      results.user = { available: true };
    } else if (userResponse.ok) {
      const userData = await userResponse.json();
      results.user = {
        available: false,
        type: userData.type, // 'User' or 'Organization'
        name: userData.name || userData.login
      };
    }
  } catch (err) {
    results.error = err.message;
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// Domain Check (DNS lookup)
// ─────────────────────────────────────────────────────────────

async function checkDomain(name, tld = 'com') {
  const domain = `${name}.${tld}`;

  try {
    // Try to resolve any DNS record
    await dnsResolve(domain);
    return { available: false, domain, hasRecords: true };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      // No DNS records - likely available (but could be registered without DNS)
      return { available: 'likely', domain, note: 'no DNS records' };
    }
    return { available: null, domain, error: err.code || err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Name Variations
// ─────────────────────────────────────────────────────────────

function generateVariations(name) {
  const variations = new Set();

  // Common prefixes
  ['node-', 'js-', 'go-', 'py-', 'use-', 'create-', 'get-', 'the-'].forEach(prefix => {
    variations.add(prefix + name);
  });

  // Common suffixes
  ['-js', '-ts', '-cli', '-app', '-lib', '-kit', '-io', '-dev', '-hq', '-hub'].forEach(suffix => {
    variations.add(name + suffix);
  });

  // Scoped packages
  ['@myorg/', '@dev/'].forEach(scope => {
    variations.add(scope + name);
  });

  // Number suffix
  variations.add(name + '2');
  variations.add(name + '-v2');

  // Abbreviations (if name is long enough)
  if (name.length > 6) {
    variations.add(name.slice(0, 3));
    variations.add(name.slice(0, 4));
  }

  // Remove common words if present
  const shortened = name
    .replace(/-?(js|ts|node|app|cli|lib)$/i, '')
    .replace(/^(node|js|the|get|use)-/i, '');
  if (shortened !== name && shortened.length > 2) {
    variations.add(shortened);
  }

  return [...variations].filter(v => v !== name && v.length > 1);
}

// ─────────────────────────────────────────────────────────────
// Formatting Helpers
// ─────────────────────────────────────────────────────────────

function getRelativeTime(date) {
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function formatStatus(available, takenInfo = '') {
  if (available === true) return '✓ available';
  if (available === false) return `✗ taken${takenInfo ? ` (${takenInfo})` : ''}`;
  if (available === 'likely') return '? likely available';
  return '? unknown';
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let npmOnly = false;
let githubOnly = false;
let domainOnly = false;
let suggest = false;
let tld = 'com';

const names = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--npm-only' || arg === '-n') {
    npmOnly = true;
  } else if (arg === '--github-only' || arg === '-g') {
    githubOnly = true;
  } else if (arg === '--domain-only' || arg === '-d') {
    domainOnly = true;
  } else if (arg === '--suggest' || arg === '-s') {
    suggest = true;
  } else if (arg === '--tld') {
    tld = options.remaining[++i] || 'com';
  } else if (!arg.startsWith('-')) {
    names.push(arg.toLowerCase());
  }
}

if (options.help || names.length === 0) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

// If no specific flag, check all
const checkAll = !npmOnly && !githubOnly && !domainOnly;

const out = createOutput(options);
const results = [];

for (const name of names) {
  out.header(`\n📦 ${name}`);

  const result = { name, npm: null, github: null, domain: null };

  // Run checks in parallel
  const checks = [];

  if (checkAll || npmOnly) {
    checks.push(checkNpm(name).then(r => result.npm = r));
  }
  if (checkAll || githubOnly) {
    checks.push(checkGitHub(name).then(r => result.github = r));
  }
  if (checkAll || domainOnly) {
    checks.push(checkDomain(name, tld).then(r => result.domain = r));
  }

  await Promise.all(checks);
  results.push(result);

  // Format npm result
  if (result.npm) {
    const npm = result.npm;
    let info = '';
    if (!npm.available && npm.version) {
      info = `v${npm.version}`;
      if (npm.lastPublished) info += `, ${npm.lastPublished}`;
    }
    out.add(`  npm:    ${formatStatus(npm.available, info)}`);
    if (!npm.available && npm.description) {
      out.add(`          "${npm.description}"`);
    }
  }

  // Format GitHub result
  if (result.github) {
    const gh = result.github;

    // Repo status
    if (gh.repo) {
      let repoInfo = '';
      if (!gh.repo.available && gh.repo.fullName) {
        repoInfo = gh.repo.fullName;
        if (gh.repo.stars > 0) repoInfo += `, ⭐${gh.repo.stars}`;
      }
      out.add(`  github: ${formatStatus(gh.repo.available, repoInfo)} (repo)`);
    }

    // User/org status
    if (gh.user) {
      let userInfo = '';
      if (!gh.user.available) {
        userInfo = `${gh.user.type}: ${gh.user.name}`;
      }
      out.add(`          ${formatStatus(gh.user.available, userInfo)} (user/org)`);
    }
  }

  // Format domain result
  if (result.domain) {
    const dom = result.domain;
    out.add(`  domain: ${formatStatus(dom.available, dom.note || '')} (${dom.domain})`);
  }
}

// Suggest variations if requested and any name is taken
if (suggest) {
  const takenNames = results.filter(r =>
    r.npm?.available === false ||
    r.github?.repo?.available === false ||
    r.domain?.available === false
  );

  if (takenNames.length > 0) {
    out.blank();
    out.header('💡 Suggested variations:');

    for (const taken of takenNames) {
      const variations = generateVariations(taken.name);

      // Check a few variations (limit to avoid rate limits)
      const toCheck = variations.slice(0, 6);
      out.add(`  ${taken.name}:`);

      for (const variant of toCheck) {
        // Quick npm check only for suggestions
        const npmResult = await checkNpm(variant);
        const status = npmResult.available ? '✓' : '✗';
        out.add(`    ${status} ${variant}`);
      }
    }
  }
}

// Summary
out.blank();
const available = results.filter(r =>
  r.npm?.available === true &&
  r.github?.repo?.available === true &&
  (r.domain?.available === true || r.domain?.available === 'likely')
);

if (available.length > 0) {
  out.add(`✨ Fully available: ${available.map(r => r.name).join(', ')}`);
} else if (results.length === 1) {
  out.add('No fully available names found');
} else {
  out.add(`Checked ${results.length} names, none fully available`);
}

// JSON output
out.setData('results', results);
out.setData('fullyAvailable', available.map(r => r.name));

out.print();
