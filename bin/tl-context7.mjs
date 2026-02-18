#!/usr/bin/env node

/**
 * tl-context7 - Look up library documentation via Context7 API
 *
 * Searches for libraries and retrieves up-to-date documentation snippets.
 *
 * Usage: tl-context7 <library> [query] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-context7',
    desc: 'Look up library docs via Context7',
    when: 'coding',
    example: 'tl-context7 react "useEffect cleanup"'
  }));
  process.exit(0);
}

import { createOutput, parseCommonArgs, COMMON_OPTIONS_HELP, formatTable } from '../src/output.mjs';
import { loadConfig } from '../src/config.mjs';
import { getCached, setCached } from '../src/cache.mjs';
import { join } from 'path';
import { homedir } from 'os';

const HELP = `
tl-context7 - Look up library documentation via Context7 API

Usage: tl-context7 <library> [query] [options]

Arguments:
  <library>             Library name or Context7 ID (starts with /)
  [query]               What to look up (required for docs, optional for search)

Options:
  --search, -s          Search only mode (list matching libraries)
  --tokens N            Max tokens for doc response (default: 10000, min: 1000)
  --topic T             Focus on specific doc section
  --page N              Pagination for large results (1-10)
${COMMON_OPTIONS_HELP}

Examples:
  tl-context7 react "useEffect cleanup"         # One-shot: search + get docs
  tl-context7 nextjs "app router middleware"     # Search by name, fetch docs
  tl-context7 /facebook/react "server components"  # Direct library ID
  tl-context7 -s react                           # Search only (find IDs)
  tl-context7 react "hooks" --tokens 5000        # Limit API response tokens
  tl-context7 react "hooks" --topic "state"      # Focus on topic
  tl-context7 react "hooks" -j                   # JSON output

API key (optional, higher rate limits):
  Set CONTEXT7_API_KEY env var, or add to .tokenleanrc.json:
  { "context7": { "apiKey": "ctx7sk-..." } }
`;

const API_BASE = 'https://context7.com/api/v2';

// Use a synthetic project root for cache (TTL-based, no git)
const CACHE_ROOT = join(homedir(), '.tokenlean', 'context7');

// ─────────────────────────────────────────────────────────────
// API Key Resolution
// ─────────────────────────────────────────────────────────────

function getApiKey() {
  // 1. Environment variable
  if (process.env.CONTEXT7_API_KEY) {
    return process.env.CONTEXT7_API_KEY;
  }

  // 2. Config file
  const { config } = loadConfig();
  if (config.context7?.apiKey) {
    return config.context7.apiKey;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// API Fetch
// ─────────────────────────────────────────────────────────────

async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {};
  const apiKey = getApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url.toString(), { headers });

  if (response.status === 200) {
    const contentType = response.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }
    return { ok: true, data };
  }

  if (response.status === 202) {
    return { ok: false, status: 202, message: 'Library is still being processed. Try again later.' };
  }

  if (response.status === 301) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, status: 301, message: `Library moved.`, redirect: body.newId || body.libraryId };
  }

  if (response.status === 429) {
    let msg = 'Rate limited by Context7.';
    if (!apiKey) {
      msg += ' Get an API key at context7.com/dashboard for higher limits.';
    }
    return { ok: false, status: 429, message: msg };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, message: 'Invalid or expired API key.' };
  }

  if (response.status === 404) {
    return { ok: false, status: 404, message: 'Library not found. Use --search to find the right ID.' };
  }

  return { ok: false, status: response.status, message: `Context7 API error (HTTP ${response.status}).` };
}

// ─────────────────────────────────────────────────────────────
// Search Libraries
// ─────────────────────────────────────────────────────────────

async function searchLibrary(name, query) {
  const cacheKey = { op: 'context7-search', libraryName: name, query: query || '' };
  const cached = getCached(cacheKey, CACHE_ROOT);
  if (cached !== null) return { ok: true, data: cached, fromCache: true };

  const params = { libraryName: name };
  if (query) params.query = query;

  const result = await apiFetch('/libs/search', params);
  if (result.ok) {
    // API wraps results in a { results: [...] } envelope
    const libs = result.data?.results || result.data || [];
    setCached(cacheKey, libs, CACHE_ROOT);
    return { ok: true, data: libs };
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Get Library Docs
// ─────────────────────────────────────────────────────────────

async function getLibraryDocs(libraryId, query, options = {}) {
  const { tokens = 10000, topic, page } = options;

  const cacheKey = { op: 'context7-docs', libraryId, query, tokens, topic: topic || '', page: page || '' };
  const cached = getCached(cacheKey, CACHE_ROOT);
  if (cached !== null) return { ok: true, data: cached, fromCache: true };

  const params = { libraryId, query, tokens };
  if (topic) params.topic = topic;
  if (page) params.page = page;

  const result = await apiFetch('/context', params);
  if (result.ok) {
    setCached(cacheKey, result.data, CACHE_ROOT);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────

function formatSearchResults(results, out) {
  if (!results || !Array.isArray(results) || results.length === 0) {
    out.add('No matching libraries found.');
    return;
  }

  out.header(`Found ${results.length} matching libraries:\n`);

  const rows = results.map(lib => [
    lib.id || lib.libraryId || '',
    lib.name || lib.title || '',
    lib.totalSnippets != null ? `${lib.totalSnippets} snippets` : '',
    lib.description ? lib.description.slice(0, 60) : ''
  ]);

  const formatted = formatTable(rows, { indent: '  ', separator: '  ' });
  out.addLines(formatted);
}

function formatDocs(data, out) {
  // Handle string response
  if (typeof data === 'string') {
    out.addLines(data.split('\n'));
    return;
  }

  // Handle object with content field
  if (data.content) {
    const content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2);
    out.addLines(content.split('\n'));
    return;
  }

  // Handle object with context/snippets array
  const snippets = data.context || data.snippets || data.results || [];
  if (Array.isArray(snippets) && snippets.length > 0) {
    for (const snippet of snippets) {
      if (snippet.title || snippet.heading) {
        out.add(`## ${snippet.title || snippet.heading}`);
      }
      if (snippet.content || snippet.text || snippet.code) {
        const text = snippet.content || snippet.text || snippet.code;
        out.addLines(text.split('\n'));
      }
      if (snippet.url || snippet.source) {
        out.add(`  Source: ${snippet.url || snippet.source}`);
      }
      out.blank();
      if (out.truncated) break;
    }
    return;
  }

  // Fallback: dump as JSON
  out.addLines(JSON.stringify(data, null, 2).split('\n'));
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let searchOnly = false;
let apiTokens = null;
let topic = null;
let page = null;
const positional = [];

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--search' || arg === '-s') {
    searchOnly = true;
  } else if (arg === '--tokens') {
    apiTokens = parseInt(options.remaining[++i], 10) || 10000;
    if (apiTokens < 1000) apiTokens = 1000;
  } else if (arg === '--topic') {
    topic = options.remaining[++i] || null;
  } else if (arg === '--page') {
    page = parseInt(options.remaining[++i], 10) || null;
    if (page && (page < 1 || page > 10)) page = null;
  } else if (!arg.startsWith('-')) {
    positional.push(arg);
  }
}

// Get config defaults
const { config } = loadConfig();
const c7Config = config.context7 || {};
if (!apiTokens) apiTokens = c7Config.defaultTokens || 10000;

const library = positional[0] || null;
const query = positional.slice(1).join(' ') || null;

if (options.help || !library) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const out = createOutput(options);

try {
  if (searchOnly) {
    // ── Search only mode ──
    const result = await searchLibrary(library, query);

    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }

    formatSearchResults(result.data, out);
    out.setData('search', result.data);
    if (result.fromCache) out.stats('\n(cached)');

  } else if (library.startsWith('/')) {
    // ── Direct library ID mode ──
    if (!query) {
      console.error('Query is required when using a library ID.\nUsage: tl-context7 /org/repo "query"');
      process.exit(1);
    }

    const result = await getLibraryDocs(library, query, { tokens: apiTokens, topic, page });

    if (!result.ok) {
      if (result.status === 301 && result.redirect) {
        console.error(`Library moved to: ${result.redirect}\nRetry with: tl-context7 ${result.redirect} "${query}"`);
      } else {
        console.error(result.message);
      }
      process.exit(1);
    }

    out.header(`# ${library} — "${query}"\n`);
    formatDocs(result.data, out);
    out.setData('libraryId', library);
    out.setData('query', query);
    out.setData('docs', result.data);
    if (result.fromCache) out.stats('\n(cached)');

  } else {
    // ── One-shot mode: search + auto-pick + get docs ──
    if (!query) {
      // Without query, fall back to search mode
      const result = await searchLibrary(library);

      if (!result.ok) {
        console.error(result.message);
        process.exit(1);
      }

      formatSearchResults(result.data, out);
      out.setData('search', result.data);
      if (result.fromCache) out.stats('\n(cached)');

    } else {
      // Search for library, pick best match, then get docs
      const searchResult = await searchLibrary(library, query);

      if (!searchResult.ok) {
        console.error(searchResult.message);
        process.exit(1);
      }

      const libs = searchResult.data;
      if (!Array.isArray(libs) || libs.length === 0) {
        console.error(`No libraries found matching "${library}". Try a different name.`);
        process.exit(0);
      }

      const bestMatch = libs[0];
      const libraryId = bestMatch.id || bestMatch.libraryId;

      if (!libraryId) {
        console.error('Could not determine library ID from search results.');
        process.exit(1);
      }

      if (!options.quiet) {
        out.header(`Using: ${bestMatch.name || bestMatch.title || libraryId} (${libraryId})\n`);
      }

      const docsResult = await getLibraryDocs(libraryId, query, { tokens: apiTokens, topic, page });

      if (!docsResult.ok) {
        if (docsResult.status === 301 && docsResult.redirect) {
          console.error(`Library moved to: ${docsResult.redirect}\nRetry with: tl-context7 ${docsResult.redirect} "${query}"`);
        } else {
          console.error(docsResult.message);
        }
        process.exit(1);
      }

      formatDocs(docsResult.data, out);
      out.setData('libraryId', libraryId);
      out.setData('libraryName', bestMatch.name || bestMatch.title || library);
      out.setData('query', query);
      out.setData('docs', docsResult.data);
      if (docsResult.fromCache) out.stats('\n(cached)');
    }
  }
} catch (err) {
  if (err.cause?.code === 'ENOTFOUND' || err.cause?.code === 'ECONNREFUSED') {
    console.error('Cannot reach Context7 API. Check your network connection.');
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
}

out.print();
