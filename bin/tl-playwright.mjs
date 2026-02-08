#!/usr/bin/env node

/**
 * tl-playwright - Headless browser content extraction
 *
 * Renders pages in a headless browser and extracts content.
 * Requires playwright or playwright-core installed externally.
 *
 * Usage: tl-playwright <url> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-playwright',
    desc: 'Extract content from JS-rendered pages via headless browser',
    when: 'search',
    example: 'tl-playwright https://example.com -s "article"'
  }));
  process.exit(0);
}

import { createOutput, parseCommonArgs, COMMON_OPTIONS_HELP } from '../src/output.mjs';
import { loadConfig } from '../src/config.mjs';

const HELP = `
tl-playwright - Headless browser content extraction

Usage: tl-playwright <url> [options]

Arguments:
  <url>                   URL to navigate to (auto-prepends https:// if missing)

Content extraction:
  --select, -s <sel>      CSS selector to extract (default: body)
  --html                  Output innerHTML instead of innerText
  --eval <expr>           Evaluate JS expression (overrides --select)

Interactions:
  --click <selector>      Click element before extraction
  --wait <selector>       Wait for element to be visible

Screenshot:
  --screenshot <path>     Save screenshot to file

Browser options:
  --timeout <ms>          Navigation timeout in ms (default: 30000)
  --wait-until <event>    domcontentloaded (default), load, networkidle
  --browser <name>        chromium (default), firefox, webkit
  --headful               Run in headed mode (for debugging)
  --viewport <WxH>        Viewport size (default: 1280x720)
  --user-agent <string>   Custom user agent
${COMMON_OPTIONS_HELP}

Examples:
  tl-playwright https://example.com                         # Full page text
  tl-playwright https://example.com -s "article"            # Specific element
  tl-playwright https://example.com -s "table" --html       # Get HTML
  tl-playwright https://example.com --screenshot shot.png   # Screenshot
  tl-playwright https://example.com --click ".load-more" -s ".results"
  tl-playwright https://example.com --wait "#content" -s "#content"
  tl-playwright https://example.com --eval "document.title"
  tl-playwright https://example.com --viewport 390x844      # Mobile viewport
  tl-playwright https://example.com -s "p" -j              # JSON output
  tl-playwright https://example.com -s "body" -l 20        # Limited output
`;

// ─────────────────────────────────────────────────────────────
// Playwright Loader
// ─────────────────────────────────────────────────────────────

async function loadPlaywright() {
  for (const pkg of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(pkg);
      return mod.default || mod;
    } catch {}
  }
  console.error('Playwright not found. Install with:');
  console.error('  npm install -g playwright');
  console.error('  npx playwright install chromium');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function parseViewport(str) {
  const match = str.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

function normalizeUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url;
}

// ─────────────────────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let selector = null;
let screenshotPath = null;
let clickSelector = null;
let waitSelector = null;
let evalExpr = null;
let htmlMode = false;
let timeout = null;
let waitUntil = null;
let browserName = null;
let headful = false;
let viewport = null;
let userAgent = null;
const positional = [];

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--select' || arg === '-s') {
    selector = options.remaining[++i] || null;
  } else if (arg === '--screenshot') {
    screenshotPath = options.remaining[++i] || null;
  } else if (arg === '--click') {
    clickSelector = options.remaining[++i] || null;
  } else if (arg === '--wait') {
    waitSelector = options.remaining[++i] || null;
  } else if (arg === '--eval') {
    evalExpr = options.remaining[++i] || null;
  } else if (arg === '--html') {
    htmlMode = true;
  } else if (arg === '--timeout') {
    timeout = parseInt(options.remaining[++i], 10) || null;
  } else if (arg === '--wait-until') {
    waitUntil = options.remaining[++i] || null;
  } else if (arg === '--browser') {
    browserName = options.remaining[++i] || null;
  } else if (arg === '--headful') {
    headful = true;
  } else if (arg === '--viewport') {
    viewport = options.remaining[++i] || null;
  } else if (arg === '--user-agent') {
    userAgent = options.remaining[++i] || null;
  } else if (!arg.startsWith('-')) {
    positional.push(arg);
  }
}

const url = positional[0] || null;

if (options.help || !url) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────
// Config Merge (CLI > config > defaults)
// ─────────────────────────────────────────────────────────────

const { config } = loadConfig();
const pwConfig = config.playwright || {};

timeout = timeout || pwConfig.timeout || 30000;
waitUntil = waitUntil || pwConfig.waitUntil || 'domcontentloaded';
browserName = browserName || pwConfig.browser || 'chromium';
selector = selector || 'body';

const validWaitUntil = ['domcontentloaded', 'load', 'networkidle'];
if (!validWaitUntil.includes(waitUntil)) {
  console.error(`Invalid --wait-until value: ${waitUntil}`);
  console.error(`Use: ${validWaitUntil.join(', ')}`);
  process.exit(1);
}

const validBrowsers = ['chromium', 'firefox', 'webkit'];
if (!validBrowsers.includes(browserName)) {
  console.error(`Unknown browser: ${browserName}`);
  console.error(`Use: ${validBrowsers.join(', ')}`);
  process.exit(1);
}

let viewportSize = null;
const viewportStr = viewport || pwConfig.viewport || '1280x720';
viewportSize = parseViewport(viewportStr);
if (!viewportSize) {
  console.error(`Invalid viewport: ${viewportStr}. Use WxH (e.g., 1280x720)`);
  process.exit(1);
}

const normalizedUrl = normalizeUrl(url);

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const pw = await loadPlaywright();
const out = createOutput(options);

let browser;
try {
  // Launch browser
  try {
    browser = await pw[browserName].launch({
      headless: !headful,
      timeout
    });
  } catch (err) {
    if (err.message?.includes('Executable doesn\'t exist') ||
        err.message?.includes('browserType.launch') ||
        err.message?.includes('executable') ||
        err.message?.includes('not found')) {
      console.error(`Browser "${browserName}" is not installed.`);
      console.error(`Install with: npx playwright install ${browserName}`);
      process.exit(1);
    }
    throw err;
  }

  const context = await browser.newContext({
    viewport: viewportSize,
    ...(userAgent ? { userAgent } : {})
  });
  const page = await context.newPage();

  // Navigate
  try {
    await page.goto(normalizedUrl, {
      timeout,
      waitUntil
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.error(`Page load timed out after ${timeout}ms: ${normalizedUrl}`);
      process.exit(1);
    }
    console.error(`Failed to navigate: ${err.message}`);
    process.exit(1);
  }

  // Optional: --wait
  if (waitSelector) {
    try {
      await page.locator(waitSelector).first().waitFor({ state: 'visible', timeout });
    } catch {
      console.error(`Timed out waiting for: ${waitSelector}`);
      process.exit(1);
    }
  }

  // Optional: --click
  if (clickSelector) {
    try {
      await page.locator(clickSelector).first().click({ timeout });
      // Small settle delay after click
      await page.waitForTimeout(500);
    } catch {
      console.error(`Click target not found: ${clickSelector}`);
      process.exit(1);
    }
  }

  // Optional: --screenshot
  if (screenshotPath) {
    try {
      if (selector !== 'body' && !evalExpr) {
        // Element screenshot
        const el = page.locator(selector).first();
        await el.screenshot({ path: screenshotPath });
      } else {
        // Full page screenshot
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      if (!options.quiet) {
        out.header(`Screenshot saved: ${screenshotPath}`);
      }
    } catch (err) {
      console.error(`Screenshot failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Content extraction
  if (evalExpr) {
    // ── Eval mode ──
    try {
      const result = await page.evaluate(evalExpr);
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      if (!options.quiet) {
        out.header(`# eval: ${evalExpr}\n`);
      }
      out.addLines(resultStr.split('\n'));
      out.setData('url', normalizedUrl);
      out.setData('eval', evalExpr);
      out.setData('result', result);
    } catch (err) {
      console.error(`Evaluation error: ${err.message}`);
      process.exit(1);
    }
  } else if (!screenshotPath || selector !== 'body' || htmlMode) {
    // ── Text/HTML extraction mode ──
    // Skip text extraction for screenshot-only runs (screenshot + default selector + no html)
    const locator = page.locator(selector);
    const count = await locator.count();

    if (count === 0) {
      // No matches — not an error, just empty output
      out.setData('url', normalizedUrl);
      out.setData('selector', selector);
      out.setData('matches', []);
    } else {
      const results = [];
      for (let idx = 0; idx < count; idx++) {
        const el = locator.nth(idx);
        let text;
        if (htmlMode) {
          text = await el.innerHTML();
        } else {
          text = await el.innerText();
        }
        text = text.trim();
        if (text) results.push(text);
      }

      if (!options.quiet) {
        out.header(`# ${normalizedUrl}${selector !== 'body' ? ` -> ${selector}` : ''}\n`);
      }

      if (options.json) {
        out.setData('url', normalizedUrl);
        out.setData('selector', selector);
        out.setData('html', htmlMode);
        out.setData('matches', results);
        // Still add lines for truncation tracking
        for (const r of results) {
          out.addLines(r.split('\n'));
        }
      } else {
        const joined = results.join('\n\n');
        out.addLines(joined.split('\n'));
      }
    }
  }

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
} finally {
  if (browser) {
    await browser.close();
  }
}

out.print();
