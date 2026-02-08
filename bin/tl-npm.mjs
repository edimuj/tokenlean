#!/usr/bin/env node

/**
 * tl-npm - Quick npm package lookup
 *
 * Token-efficient npm package information for agents.
 * Fetches essential details without the noise.
 *
 * Usage: tl-npm <package...> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-npm',
    desc: 'Quick npm package lookup',
    when: 'search',
    example: 'tl-npm express'
  }));
  process.exit(0);
}

import https from 'https';
import {
  createOutput,
  parseCommonArgs,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';

const HELP = `
tl-npm - Quick npm package lookup

Usage: tl-npm <package...> [options]

Token-efficient npm package info for agents. Shows essential
details without the noise of full npm pages.

Options:
  --deps                Show dependency list
  --versions            Show recent version history
  --search <query>      Search npm registry
  --size <N>            Results for --search (default: 10)
${COMMON_OPTIONS_HELP}

Modes:
  tl-npm <pkg>                    Single package summary
  tl-npm <pkg> --deps             Summary + dependency list
  tl-npm <pkg> --versions         Version history with dates
  tl-npm <pkg1> <pkg2> ...        Compare multiple packages
  tl-npm --search "query"         Search npm registry

Examples:
  tl-npm express                  # Quick summary
  tl-npm express --deps           # Show dependencies
  tl-npm express --versions       # Recent versions
  tl-npm express fastify koa      # Compare packages
  tl-npm --search "web framework" # Search npm
  tl-npm @types/react             # Scoped packages work
`;

// ─────────────────────────────────────────────────────────────
// HTTP Helper
// ─────────────────────────────────────────────────────────────

function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        fetchJSON(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }

      if (res.statusCode === 404) {
        res.resume();
        resolve(null);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Formatting Helpers
// ─────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null) return '?';
  if (n >= 1000000000) return `${(n / 1000000000).toFixed(1)}B`;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso) {
  if (!iso) return '?';
  return iso.slice(0, 10);
}

function fmtSize(bytes) {
  if (bytes == null) return '?';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function repoUrl(pkg) {
  const repo = pkg.repository;
  if (!repo) return null;
  let url = typeof repo === 'string' ? repo : repo.url;
  if (!url) return null;
  // Clean up git+https://...git -> https://...
  url = url.replace(/^git\+/, '').replace(/\.git$/, '');
  return url;
}

function shortRepo(url) {
  if (!url) return null;
  return url.replace(/^https?:\/\/(www\.)?github\.com\//, 'github:');
}

// ─────────────────────────────────────────────────────────────
// Data Fetching
// ─────────────────────────────────────────────────────────────

async function fetchPackage(name) {
  const encoded = encodeURIComponent(name).replace('%40', '@');
  const [pkg, dl] = await Promise.all([
    fetchJSON(`https://registry.npmjs.org/${encoded}/latest`),
    fetchJSON(`https://api.npmjs.org/downloads/point/last-week/${encoded}`).catch(() => null)
  ]);

  if (!pkg) return null;

  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description || '',
    license: typeof pkg.license === 'object' ? pkg.license.type : (pkg.license || '?'),
    homepage: pkg.homepage || null,
    repo: repoUrl(pkg),
    engines: pkg.engines?.node || null,
    deps: Object.keys(pkg.dependencies || {}),
    peerDeps: Object.keys(pkg.peerDependencies || {}),
    devDeps: Object.keys(pkg.devDependencies || {}),
    downloads: dl?.downloads || null,
    unpackedSize: pkg.dist?.unpackedSize || null,
    maintainers: (pkg.maintainers || []).map(m => m.name || m.username).filter(Boolean),
    keywords: (pkg.keywords || []).slice(0, 10),
    deprecated: pkg.deprecated || null
  };
}

async function fetchVersions(name) {
  const encoded = encodeURIComponent(name).replace('%40', '@');
  const doc = await fetchJSON(`https://registry.npmjs.org/${encoded}`);
  if (!doc) return null;

  const distTags = doc['dist-tags'] || {};
  const times = doc.time || {};

  // Build version list sorted by date descending, excluding 'created' and 'modified'
  const versions = Object.entries(times)
    .filter(([v]) => v !== 'created' && v !== 'modified')
    .map(([version, date]) => ({
      version,
      date: fmtDate(date),
      tags: Object.entries(distTags)
        .filter(([, v]) => v === version)
        .map(([tag]) => tag)
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    name: doc.name,
    totalVersions: versions.length,
    distTags,
    versions
  };
}

async function searchPackages(query, size = 10) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`;
  const result = await fetchJSON(url);
  if (!result) return { total: 0, packages: [] };

  return {
    total: result.total || 0,
    packages: (result.objects || []).map(obj => {
      const p = obj.package;
      return {
        name: p.name,
        version: p.version,
        description: (p.description || '').slice(0, 80),
        date: fmtDate(p.date),
        publisher: p.publisher?.username || '?',
        keywords: (p.keywords || []).slice(0, 5)
      };
    })
  };
}

// ─────────────────────────────────────────────────────────────
// Display: Single Package Summary
// ─────────────────────────────────────────────────────────────

function displaySummary(out, pkg) {
  if (pkg.deprecated) {
    out.add(`DEPRECATED: ${pkg.deprecated}`);
    out.blank();
  }

  // Line 1: name version (license) — downloads
  let line1 = `${pkg.name} v${pkg.version} (${pkg.license})`;
  if (pkg.downloads != null) line1 += ` — ${fmtNum(pkg.downloads)} dl/wk`;
  out.add(line1);

  // Line 2: description
  if (pkg.description) out.add(pkg.description);

  // Line 3: links
  const links = [];
  if (pkg.homepage) links.push(pkg.homepage);
  const sr = shortRepo(pkg.repo);
  if (sr && sr !== pkg.homepage) links.push(sr);
  if (links.length > 0) out.add(links.join(' | '));

  // Line 4: metadata
  const meta = [];
  meta.push(`${pkg.deps.length} deps`);
  if (pkg.peerDeps.length > 0) meta.push(`${pkg.peerDeps.length} peer`);
  if (pkg.engines) meta.push(`node ${pkg.engines}`);
  if (pkg.unpackedSize) meta.push(fmtSize(pkg.unpackedSize));
  out.add(meta.join(' | '));

  // Line 5: maintainers (if any)
  if (pkg.maintainers.length > 0) {
    out.add(`maintainers: ${pkg.maintainers.slice(0, 5).join(', ')}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Display: Dependencies
// ─────────────────────────────────────────────────────────────

function displayDeps(out, pkg) {
  displaySummary(out, pkg);

  if (pkg.deps.length > 0) {
    out.blank();
    out.add(`Dependencies (${pkg.deps.length}):`);
    // Show in compact multi-column format
    const sorted = [...pkg.deps].sort();
    const perLine = 5;
    for (let i = 0; i < sorted.length; i += perLine) {
      out.add('  ' + sorted.slice(i, i + perLine).join('  '));
    }
  }

  if (pkg.peerDeps.length > 0) {
    out.blank();
    out.add(`Peer dependencies (${pkg.peerDeps.length}):`);
    out.add('  ' + pkg.peerDeps.sort().join('  '));
  }
}

// ─────────────────────────────────────────────────────────────
// Display: Versions
// ─────────────────────────────────────────────────────────────

function displayVersions(out, info, maxVersions) {
  out.add(`${info.name} — ${info.totalVersions} versions`);
  out.blank();

  // Dist tags
  const tagEntries = Object.entries(info.distTags);
  if (tagEntries.length > 0) {
    out.add('Tags:');
    const tagRows = tagEntries.map(([tag, version]) => {
      const v = info.versions.find(v => v.version === version);
      return ['  ' + tag, version, v ? v.date : ''];
    });
    formatTable(tagRows).forEach(line => out.add(line));
    out.blank();
  }

  // Recent versions
  const shown = info.versions.slice(0, maxVersions);
  out.add(`Recent versions:`);
  const rows = shown.map(v => {
    const tags = v.tags.length > 0 ? `  (${v.tags.join(', ')})` : '';
    return ['  ' + v.version, v.date + tags];
  });
  formatTable(rows).forEach(line => out.add(line));

  if (info.versions.length > maxVersions) {
    out.add(`  ... ${info.versions.length - maxVersions} more`);
  }
}

// ─────────────────────────────────────────────────────────────
// Display: Compare Multiple Packages
// ─────────────────────────────────────────────────────────────

function displayCompare(out, packages) {
  // Build comparison table
  const names = packages.map(p => p.name);
  const maxNameLen = Math.max(12, ...names.map(n => n.length));

  // Header
  const header = ['', ...names];
  const rows = [
    ['version', ...packages.map(p => `v${p.version}`)],
    ['license', ...packages.map(p => p.license)],
    ['dl/wk', ...packages.map(p => p.downloads != null ? fmtNum(p.downloads) : '?')],
    ['deps', ...packages.map(p => String(p.deps.length))],
    ['node', ...packages.map(p => p.engines || '?')],
    ['size', ...packages.map(p => p.unpackedSize ? fmtSize(p.unpackedSize) : '?')]
  ];

  formatTable([header, ...rows], { separator: '   ' }).forEach(line => out.add(line));

  // Short descriptions
  out.blank();
  for (const pkg of packages) {
    if (pkg.description) {
      out.add(`${pkg.name}: ${pkg.description}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Display: Search Results
// ─────────────────────────────────────────────────────────────

function displaySearch(out, query, results) {
  out.add(`npm search: "${query}" (${results.total} total, showing ${results.packages.length})`);
  out.blank();

  if (results.packages.length === 0) {
    out.add('No packages found.');
    return;
  }

  const rows = results.packages.map(p => [
    p.name,
    `v${p.version}`,
    p.date,
    p.description
  ]);
  formatTable(rows, { separator: '  ' }).forEach(line => out.add(line));
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse custom args first
  let showDeps = false;
  let showVersions = false;
  let searchQuery = null;
  let searchSize = 10;
  const filteredArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--deps') {
      showDeps = true;
    } else if (arg === '--versions') {
      showVersions = true;
    } else if (arg === '--search') {
      searchQuery = args[++i] || '';
    } else if (arg === '--size') {
      searchSize = parseInt(args[++i], 10) || 10;
    } else {
      filteredArgs.push(arg);
    }
  }

  const opts = parseCommonArgs(filteredArgs);
  const maxVersions = opts.maxLines !== Infinity ? opts.maxLines : 15;

  if (opts.help) {
    console.log(HELP.trim());
    process.exit(0);
  }

  // Search mode
  if (searchQuery != null) {
    if (!searchQuery) {
      console.error('Error: --search requires a query');
      process.exit(1);
    }

    try {
      const results = await searchPackages(searchQuery, searchSize);
      const out = createOutput(opts);

      if (opts.json) {
        out.setData('query', searchQuery);
        out.setData('total', results.total);
        out.setData('packages', results.packages);
      }

      displaySearch(out, searchQuery, results);
      out.print();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Package lookup mode
  const packageNames = opts.remaining;

  if (packageNames.length === 0) {
    console.log(HELP.trim());
    process.exit(0);
  }

  try {
    // Versions mode (single package only)
    if (showVersions) {
      const name = packageNames[0];
      const info = await fetchVersions(name);
      if (!info) {
        console.error(`Error: package "${name}" not found`);
        process.exit(1);
      }

      const out = createOutput(opts);

      if (opts.json) {
        out.setData('name', info.name);
        out.setData('totalVersions', info.totalVersions);
        out.setData('distTags', info.distTags);
        out.setData('versions', info.versions.slice(0, maxVersions));
      }

      displayVersions(out, info, maxVersions);
      out.print();
      process.exit(0);
    }

    // Fetch all packages in parallel
    const results = await Promise.all(
      packageNames.map(name => fetchPackage(name))
    );

    // Check for not-found packages
    const notFound = packageNames.filter((name, i) => !results[i]);
    if (notFound.length > 0) {
      console.error(`Error: package${notFound.length > 1 ? 's' : ''} not found: ${notFound.join(', ')}`);
      process.exit(1);
    }

    const packages = results.filter(Boolean);
    const out = createOutput(opts);

    if (packages.length === 1) {
      // Single package
      const pkg = packages[0];

      if (opts.json) {
        out.setData('name', pkg.name);
        out.setData('version', pkg.version);
        out.setData('description', pkg.description);
        out.setData('license', pkg.license);
        out.setData('homepage', pkg.homepage);
        out.setData('repo', pkg.repo);
        out.setData('engines', pkg.engines);
        out.setData('downloads', pkg.downloads);
        out.setData('unpackedSize', pkg.unpackedSize);
        out.setData('dependencies', pkg.deps);
        out.setData('peerDependencies', pkg.peerDeps);
        out.setData('maintainers', pkg.maintainers);
        out.setData('deprecated', pkg.deprecated);
      }

      if (showDeps) {
        displayDeps(out, pkg);
      } else {
        displaySummary(out, pkg);
      }
    } else {
      // Multiple packages — comparison
      if (opts.json) {
        out.setData('packages', packages.map(pkg => ({
          name: pkg.name,
          version: pkg.version,
          license: pkg.license,
          downloads: pkg.downloads,
          deps: pkg.deps.length,
          engines: pkg.engines,
          unpackedSize: pkg.unpackedSize,
          description: pkg.description
        })));
      }

      displayCompare(out, packages);
    }

    out.print();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
