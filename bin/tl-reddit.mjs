#!/usr/bin/env node

/**
 * tl-reddit - Fetch Reddit posts and comments as clean markdown
 *
 * Uses old.reddit.com HTML (no API key, no auth).
 *
 * Usage: tl-reddit <url> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-reddit',
    desc: 'Fetch Reddit post/comments as clean markdown',
    when: 'search',
    example: 'tl-reddit https://www.reddit.com/r/ClaudeAI/comments/abc123/'
  }));
  process.exit(0);
}

import { createOutput, parseCommonArgs, estimateTokens, formatTokens, COMMON_OPTIONS_HELP } from '../src/output.mjs';

const HELP = `
tl-reddit - Fetch Reddit post/comments as clean markdown

Usage: tl-reddit <url> [options]

Options:
  -c, --comments <n>    Max comments to show (default: 20)
  --op-only             Show only OP's post, no comments
  --timeout <ms>        Request timeout in ms (default: 15000)
${COMMON_OPTIONS_HELP}

Examples:
  tl-reddit https://www.reddit.com/r/ClaudeAI/comments/abc123/
  tl-reddit https://reddit.com/r/claude/comments/xyz/comment/def456/
  tl-reddit <url> -c 5           # Only first 5 comments
  tl-reddit <url> --op-only      # Just the post, skip comments
  tl-reddit <url> -t 2000        # Limit to ~2000 tokens
  tl-reddit <url> -j             # JSON output
`;

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_COMMENTS = 20;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

// ─────────────────────────────────────────────────────────────
// URL Helpers
// ─────────────────────────────────────────────────────────────

function toOldRedditUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    // Try adding https://
    try {
      url = new URL('https://' + raw);
    } catch {
      return null;
    }
  }

  // Strip tracking params
  url.search = '';

  // Convert to old.reddit.com
  if (url.hostname === 'www.reddit.com' || url.hostname === 'reddit.com' ||
      url.hostname === 'new.reddit.com' || url.hostname === 'old.reddit.com') {
    url.hostname = 'old.reddit.com';
  } else {
    return null; // Not a reddit URL
  }

  return url.toString();
}

// ─────────────────────────────────────────────────────────────
// HTML Parsing
// ─────────────────────────────────────────────────────────────

function decodeEntities(text) {
  return text
    .replace(/&#32;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<code>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<pre>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMdContent(html) {
  // The md div may be nested inside other divs, so we need greedy-enough matching
  // but not so greedy we grab the next comment's content
  const match = html.match(/<div class="md">([\s\S]*?)<\/div>\s*<\/div>/);
  if (!match) return '';
  return decodeEntities(stripTags(match[1]));
}

function parsePost(html) {
  // Title
  const titleMatch = html.match(/<a class="title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : '(no title)';

  // Subreddit
  const subMatch = html.match(/\/r\/(\w+)/);
  const subreddit = subMatch ? subMatch[1] : '';

  // Score
  const scoreMatch = html.match(/<div class="score[^"]*"[^>]*>[\s\S]*?<span class="number">([\d.,]+)<\/span>/);
  const score = scoreMatch ? scoreMatch[1] : '';

  // Post body - usertext-body has extra classes on old.reddit
  const bodyParts = html.split(/class="usertext-body[^"]*"/);
  let body = '';
  // First split is subreddit description, second is the post body
  if (bodyParts.length > 2) {
    body = extractMdContent(bodyParts[2]);
  } else if (bodyParts.length > 1) {
    body = extractMdContent(bodyParts[1]);
  }

  // Comment count
  const commentCountMatch = html.match(/<a[^>]*class="[^"]*comments[^"]*"[^>]*>(\d+)\s+comments?<\/a>/);
  const commentCount = commentCountMatch ? parseInt(commentCountMatch[1], 10) : null;

  return { title, subreddit, score, body, commentCount };
}

function parseComments(html, maxComments) {
  const comments = [];

  // Split on comment things - old.reddit uses "thing ... comment" pattern
  const commentAreas = html.split(/class="[^"]*\bcomment\b[^"]*"/);

  for (let i = 1; i < commentAreas.length && comments.length < maxComments; i++) {
    const area = commentAreas[i];

    // Author
    const authorMatch = area.match(/class="author[^"]*"[^>]*>([^<]+)<\/a>/);
    const author = authorMatch ? authorMatch[1] : '[deleted]';

    // Score
    const scoreMatch = area.match(/title="(\d+) points?"/);
    const score = scoreMatch ? scoreMatch[1] : '';

    // Nesting depth
    const nestMatch = area.match(/data-depth="(\d+)"/);
    const depth = nestMatch ? parseInt(nestMatch[1], 10) : 0;

    // Body - find the usertext-body within this comment area
    const bodyParts = area.split(/class="usertext-body[^"]*"/);
    const body = bodyParts.length > 1 ? extractMdContent(bodyParts[1]) : '';

    if (body || author !== '[deleted]') {
      comments.push({ author, score, depth, body: body || '[deleted]' });
    }
  }

  return comments;
}

// ─────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────

async function fetchReddit(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { error: `HTTP ${response.status} ${response.statusText}` };
    }

    return { html: await response.text() };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { error: `Request timed out after ${timeout}ms` };
    }
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────────────────────

function formatPost(post) {
  const lines = [];
  const meta = [post.subreddit ? `r/${post.subreddit}` : '', post.score ? `${post.score} pts` : ''].filter(Boolean).join(' | ');
  if (meta) lines.push(meta);
  lines.push(`# ${post.title}`);
  if (post.body) {
    lines.push('');
    lines.push(post.body);
  }
  if (post.commentCount !== null) {
    lines.push('');
    lines.push(`(${post.commentCount} comments)`);
  }
  return lines.join('\n');
}

function formatComments(comments) {
  if (!comments.length) return '';

  const lines = ['', '---', ''];
  for (const c of comments) {
    const indent = '  '.repeat(Math.min(c.depth, 4));
    const meta = [c.author, c.score ? `${c.score}pts` : ''].filter(Boolean).join(' | ');
    lines.push(`${indent}**${meta}**`);
    // Indent comment body
    for (const bodyLine of c.body.split('\n')) {
      lines.push(`${indent}${bodyLine}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let maxComments = DEFAULT_MAX_COMMENTS;
let opOnly = false;
let timeout = DEFAULT_TIMEOUT;
let rawUrl = null;

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '-c' || arg === '--comments') {
    maxComments = parseInt(options.remaining[++i], 10) || DEFAULT_MAX_COMMENTS;
  } else if (arg === '--op-only') {
    opOnly = true;
  } else if (arg === '--timeout') {
    timeout = parseInt(options.remaining[++i], 10) || DEFAULT_TIMEOUT;
  } else if (!arg.startsWith('-')) {
    rawUrl = arg;
  }
}

if (options.help || !rawUrl) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const url = toOldRedditUrl(rawUrl);
if (!url) {
  console.error('Error: not a Reddit URL');
  process.exit(1);
}

const result = await fetchReddit(url, timeout);
if (result.error) {
  console.error(`Error: ${result.error}`);
  process.exit(1);
}

const post = parsePost(result.html);
const comments = opOnly ? [] : parseComments(result.html, maxComments);

const postText = formatPost(post);
const commentText = formatComments(comments);
const fullText = postText + commentText;

const out = createOutput(options);
const tokens = estimateTokens(fullText);

if (!options.quiet) {
  out.header(`# ${url}`);
  out.add(`~${formatTokens(tokens)} tokens | ${comments.length} comments shown`);
  out.blank();
}

out.addLines(fullText.split('\n'));

out.setData('url', url);
out.setData('title', post.title);
out.setData('subreddit', post.subreddit);
out.setData('score', post.score);
out.setData('commentCount', post.commentCount);
out.setData('commentsShown', comments.length);
out.setData('tokens', tokens);

out.print();
