#!/usr/bin/env node

/**
 * tl-browse - Fetch URL as clean markdown
 *
 * Tries Cloudflare's native markdown first, falls back to local HTML conversion.
 *
 * Usage: tl-browse <url> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-browse',
    desc: 'Fetch URL as clean markdown',
    when: 'search',
    example: 'tl-browse https://example.com/docs'
  }));
  process.exit(0);
}

import { createOutput, parseCommonArgs, estimateTokens, formatTokens, COMMON_OPTIONS_HELP } from '../src/output.mjs';
import { NodeHtmlMarkdown } from 'node-html-markdown';

const HELP = `
tl-browse - Fetch URL as clean markdown

Usage: tl-browse <url> [options]

Options:
  --no-native           Skip Cloudflare markdown, force local HTML conversion
  --timeout <ms>        Request timeout in ms (default: 15000)
${COMMON_OPTIONS_HELP}

Examples:
  tl-browse https://docs.example.com/api         # Fetch as markdown
  tl-browse https://example.com --no-native      # Force HTML conversion
  tl-browse https://example.com -t               # Show token count
  tl-browse https://example.com -l 50            # Limit to 50 lines
  tl-browse https://example.com -j               # JSON output
  tl-browse https://example.com -q               # No header, just content
`;

const DEFAULT_TIMEOUT = 15000;

// ─────────────────────────────────────────────────────────────
// URL Helpers
// ─────────────────────────────────────────────────────────────

function normalizeUrl(raw) {
  if (!/^https?:\/\//i.test(raw)) {
    return 'https://' + raw;
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────
// HTML → Markdown Conversion
// ─────────────────────────────────────────────────────────────

function convertHtml(html) {
  return NodeHtmlMarkdown.translate(html, {
    ignore: ['nav', 'footer', 'header', 'aside'],
    maxConsecutiveNewlines: 3
  });
}

// ─────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────

async function fetchMarkdown(url, { native = true, timeout = DEFAULT_TIMEOUT } = {}) {
  const headers = {};
  if (native) {
    headers['Accept'] = 'text/markdown';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);

    if (!response.ok) {
      return { error: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    // Native markdown from Cloudflare
    if (contentType.includes('text/markdown')) {
      const markdown = await response.text();
      const nativeTokens = response.headers.get('x-markdown-tokens');
      return {
        source: 'native',
        markdown,
        tokens: nativeTokens ? parseInt(nativeTokens, 10) : null
      };
    }

    // HTML — convert locally
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const markdown = convertHtml(html);
      return { source: 'converted', markdown };
    }

    // Plain text — pass through
    if (contentType.includes('text/plain')) {
      const text = await response.text();
      return { source: 'passthrough', markdown: text };
    }

    return { error: `Unsupported content type: ${contentType}` };
  } catch (err) {
    clearTimeout(timer);

    if (err.name === 'AbortError') {
      return { error: `Request timed out after ${timeout}ms` };
    }

    const code = err.cause?.code;
    if (code === 'ENOTFOUND') {
      return { error: `DNS resolution failed for ${url}` };
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      return { error: `Connection failed: ${code}` };
    }
    if (code) {
      return { error: `Connection failed: ${code}` };
    }

    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let native = true;
let timeout = DEFAULT_TIMEOUT;
let url = null;

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--no-native') {
    native = false;
  } else if (arg === '--timeout') {
    timeout = parseInt(options.remaining[++i], 10) || DEFAULT_TIMEOUT;
  } else if (!arg.startsWith('-')) {
    url = arg;
  }
}

if (options.help || !url) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

url = normalizeUrl(url);

const result = await fetchMarkdown(url, { native, timeout });

if (result.error) {
  console.error(`Error: ${result.error}`);
  process.exit(1);
}

const out = createOutput(options);

const tokens = result.tokens || estimateTokens(result.markdown);

if (!options.quiet) {
  out.header(`# ${url}`);
  out.add(`Source: ${result.source} | ~${formatTokens(tokens)} tokens`);
  out.blank();
}

out.addLines(result.markdown.split('\n'));

out.setData('url', url);
out.setData('source', result.source);
out.setData('tokens', tokens);
out.setData('markdown', result.markdown);

out.print();
