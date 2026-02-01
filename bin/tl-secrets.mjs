#!/usr/bin/env node

/**
 * tl-secrets - Find hardcoded secrets, API keys, and credentials
 *
 * Scans code for potential security issues before they get committed.
 * Detects API keys, passwords, tokens, private keys, and more.
 *
 * Usage: tl-secrets [path] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-secrets',
    desc: 'Find hardcoded secrets and API keys',
    when: 'before-commit',
    example: 'tl-secrets src/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { listFiles } from '../src/traverse.mjs';

const HELP = `
tl-secrets - Find hardcoded secrets, API keys, and credentials

Usage: tl-secrets [path] [options]

Options:
  --staged              Only scan git staged files
  --include-tests       Include test files (excluded by default)
  --include-examples    Include .env.example files (excluded by default)
  --min-severity <lvl>  Minimum severity: low, medium, high (default: low)
  --no-git-ignore       Don't respect .gitignore
${COMMON_OPTIONS_HELP}

Examples:
  tl-secrets                     # Scan current directory
  tl-secrets src/                # Scan specific directory
  tl-secrets --staged            # Only staged files
  tl-secrets --min-severity high # Only high severity

Detects:
  AWS keys, Google API keys, Stripe keys, GitHub tokens,
  private keys, JWTs, passwords, database URLs, generic secrets
`;

// ─────────────────────────────────────────────────────────────
// Secret Patterns
// ─────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  // AWS
  {
    name: 'AWS Access Key ID',
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    severity: 'high',
    type: 'aws'
  },
  {
    name: 'AWS Secret Access Key',
    pattern: /aws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    severity: 'high',
    type: 'aws'
  },

  // Google
  {
    name: 'Google API Key',
    pattern: /\b(AIza[0-9A-Za-z\-_]{35})\b/g,
    severity: 'high',
    type: 'google'
  },
  {
    name: 'Google OAuth Client Secret',
    pattern: /client_secret["']?\s*[:=]\s*["']([A-Za-z0-9_-]{24})["']/gi,
    severity: 'high',
    type: 'google'
  },

  // Stripe
  {
    name: 'Stripe Secret Key',
    pattern: /\b(sk_live_[0-9a-zA-Z]{24,})\b/g,
    severity: 'high',
    type: 'stripe'
  },
  {
    name: 'Stripe Publishable Key (Live)',
    pattern: /\b(pk_live_[0-9a-zA-Z]{24,})\b/g,
    severity: 'medium',
    type: 'stripe'
  },

  // GitHub
  {
    name: 'GitHub Personal Access Token',
    pattern: /\b(ghp_[0-9a-zA-Z]{36})\b/g,
    severity: 'high',
    type: 'github'
  },
  {
    name: 'GitHub OAuth Token',
    pattern: /\b(gho_[0-9a-zA-Z]{36})\b/g,
    severity: 'high',
    type: 'github'
  },
  {
    name: 'GitHub App Token',
    pattern: /\b(ghu_[0-9a-zA-Z]{36})\b/g,
    severity: 'high',
    type: 'github'
  },
  {
    name: 'GitHub Fine-grained Token',
    pattern: /\b(github_pat_[0-9a-zA-Z_]{22,})\b/g,
    severity: 'high',
    type: 'github'
  },

  // GitLab
  {
    name: 'GitLab Personal Access Token',
    pattern: /\b(glpat-[0-9a-zA-Z\-_]{20,})\b/g,
    severity: 'high',
    type: 'gitlab'
  },

  // Slack
  {
    name: 'Slack Bot Token',
    pattern: /\b(xoxb-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{24})\b/g,
    severity: 'high',
    type: 'slack'
  },
  {
    name: 'Slack Webhook URL',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[a-zA-Z0-9]{24}/g,
    severity: 'high',
    type: 'slack'
  },

  // Discord
  {
    name: 'Discord Bot Token',
    pattern: /\b([MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27})\b/g,
    severity: 'high',
    type: 'discord'
  },
  {
    name: 'Discord Webhook URL',
    pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    severity: 'high',
    type: 'discord'
  },

  // OpenAI / Anthropic
  {
    name: 'OpenAI API Key',
    pattern: /\b(sk-[A-Za-z0-9]{48})\b/g,
    severity: 'high',
    type: 'openai'
  },
  {
    name: 'Anthropic API Key',
    pattern: /\b(sk-ant-[A-Za-z0-9\-_]{40,})\b/g,
    severity: 'high',
    type: 'anthropic'
  },

  // NPM
  {
    name: 'NPM Token',
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/g,
    severity: 'high',
    type: 'npm'
  },

  // Private Keys
  {
    name: 'RSA Private Key',
    pattern: /-----BEGIN RSA PRIVATE KEY-----/g,
    severity: 'high',
    type: 'private-key'
  },
  {
    name: 'OpenSSH Private Key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
    severity: 'high',
    type: 'private-key'
  },
  {
    name: 'EC Private Key',
    pattern: /-----BEGIN EC PRIVATE KEY-----/g,
    severity: 'high',
    type: 'private-key'
  },
  {
    name: 'PGP Private Key',
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
    severity: 'high',
    type: 'private-key'
  },

  // JWT (only if it looks real - has 3 parts)
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9-_]{20,}\.eyJ[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_.]{20,}\b/g,
    severity: 'medium',
    type: 'jwt'
  },

  // Database URLs with credentials
  {
    name: 'Database URL with Password',
    pattern: /((?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s'"]+)/gi,
    severity: 'high',
    type: 'database'
  },

  // Generic patterns (lower confidence)
  {
    name: 'Generic API Key Assignment',
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]([^'"]{20,})['"](?!\s*\|\|)/gi,
    severity: 'medium',
    type: 'generic',
    extract: 1
  },
  {
    name: 'Generic Secret Assignment',
    pattern: /(?:secret|secret[_-]?key)\s*[:=]\s*['"]([^'"]{16,})['"](?!\s*\|\|)/gi,
    severity: 'medium',
    type: 'generic',
    extract: 1
  },
  {
    name: 'Password Assignment',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{8,})['"](?!\s*\|\|)/gi,
    severity: 'medium',
    type: 'password',
    extract: 1
  },
  {
    name: 'Authorization Header',
    pattern: /['"]?authorization['"]?\s*[:=]\s*['"](?:Bearer |Basic )?([A-Za-z0-9+/=_-]{20,})['"](?!\s*\|\|)/gi,
    severity: 'medium',
    type: 'auth-header',
    extract: 1
  },

  // Twilio
  {
    name: 'Twilio Account SID',
    pattern: /\b(AC[a-f0-9]{32})\b/g,
    severity: 'medium',
    type: 'twilio'
  },
  {
    name: 'Twilio Auth Token',
    pattern: /twilio.*auth.*token\s*[:=]\s*['"]?([a-f0-9]{32})['"]?/gi,
    severity: 'high',
    type: 'twilio'
  },

  // SendGrid
  {
    name: 'SendGrid API Key',
    pattern: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g,
    severity: 'high',
    type: 'sendgrid'
  },

  // Mailchimp
  {
    name: 'Mailchimp API Key',
    pattern: /\b([a-f0-9]{32}-us[0-9]{1,2})\b/g,
    severity: 'high',
    type: 'mailchimp'
  },

  // Firebase
  {
    name: 'Firebase Database URL',
    pattern: /https:\/\/[a-z0-9-]+\.firebaseio\.com/gi,
    severity: 'low',
    type: 'firebase'
  },

  // Heroku
  {
    name: 'Heroku API Key',
    pattern: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
    severity: 'low', // UUIDs are common, low confidence
    type: 'heroku',
    contextRequired: ['heroku', 'HEROKU']
  },
];

// ─────────────────────────────────────────────────────────────
// False Positive Filters
// ─────────────────────────────────────────────────────────────

const FALSE_POSITIVE_VALUES = [
  // Exact placeholder values (case insensitive)
  'your-api-key',
  'your-api-key-here',
  'your_api_key',
  'your_api_key_here',
  'your-key-here',
  'your_key_here',
  'api-key-here',
  'api_key_here',
  'insert-key-here',
  'insert_key_here',
  'replace-with-key',
  'replace_with_key',
  'changeme',
  'fixme',
  'todo',
  'placeholder',
  'example-key',
  'example_key',
  'test-key',
  'test_key',
  'fake-key',
  'fake_key',
  'dummy-key',
  'dummy_key',
  'sample-key',
  'sample_key',
  'demo-key',
  'demo_key',
  'none',
  'null',
  'undefined',
];

const FALSE_POSITIVE_PATTERNS = [
  /^xxx+$/i,                    // Just x's
  /^\$\{/,                      // Environment variable template ${VAR}
  /^process\.env\./,            // process.env.VAR
  /^import\.meta\.env\./,       // import.meta.env.VAR
  /^<[A-Z_]+>$/,                // <YOUR_KEY_HERE>
  /^your[_-]?.*key.*here$/i,    // your-key-here variants
  /^insert[_-]?.*here$/i,       // insert-here variants
  /^replace[_-]?.*with$/i,      // replace-with variants
  /^[a-z]{1,10}[_-]?key$/i,     // simple word + key like "test_key"
];

const SKIP_FILES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  'example.env',
  'sample.env',
];

const SKIP_EXTENSIONS = [
  '.lock',
  '.map',
  '.min.js',
  '.min.css',
  '.svg',
  '.png',
  '.jpg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
];

// ─────────────────────────────────────────────────────────────
// Scanning Logic
// ─────────────────────────────────────────────────────────────

function isFalsePositive(value, line) {
  const lowerValue = value.toLowerCase();

  // Check exact match against known placeholder values
  if (FALSE_POSITIVE_VALUES.includes(lowerValue)) return true;

  // Check value against false positive patterns
  for (const pattern of FALSE_POSITIVE_PATTERNS) {
    if (pattern.test(value)) return true;
  }

  // Check if line is a comment explaining format
  const trimmedLine = line.trim();
  if (trimmedLine.startsWith('//') || trimmedLine.startsWith('#') || trimmedLine.startsWith('*')) {
    if (/format|example|e\.g\.|i\.e\.|like this/i.test(line)) return true;
  }

  // Check for common test values (but not for long hex/alphanumeric strings)
  if (/^[a-z]+$/.test(value) && value.length < 16) return true; // Simple lowercase word
  if (/^[A-Z_]+$/.test(value) && !value.startsWith('AKIA')) return true; // All caps constant name (but not AWS keys)

  return false;
}

function isTestFile(filePath) {
  const lower = filePath.toLowerCase();
  return lower.includes('test') ||
    lower.includes('spec') ||
    lower.includes('__tests__') ||
    lower.includes('__mocks__') ||
    lower.includes('fixture') ||
    lower.includes('.test.') ||
    lower.includes('.spec.');
}

function shouldSkipFile(filePath, options) {
  const name = basename(filePath).toLowerCase();
  const ext = extname(filePath).toLowerCase();

  // Skip by extension
  if (SKIP_EXTENSIONS.includes(ext)) return true;

  // Skip example env files (unless --include-examples)
  if (!options.includeExamples && SKIP_FILES.includes(name)) return true;

  // Skip test files (unless --include-tests)
  if (!options.includeTests && isTestFile(filePath)) return true;

  return false;
}

function scanFile(filePath, options) {
  const findings = [];

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return findings; // Can't read file
  }

  const lines = content.split('\n');

  for (const secretPattern of SECRET_PATTERNS) {
    // Skip if below minimum severity
    if (options.minSeverity === 'high' && secretPattern.severity !== 'high') continue;
    if (options.minSeverity === 'medium' && secretPattern.severity === 'low') continue;

    // Reset regex state
    secretPattern.pattern.lastIndex = 0;

    let match;
    while ((match = secretPattern.pattern.exec(content)) !== null) {
      const value = secretPattern.extract !== undefined ? match[secretPattern.extract] : match[1] || match[0];
      const matchStart = match.index;

      // Find line number
      let lineNum = 1;
      let pos = 0;
      for (let i = 0; i < lines.length; i++) {
        if (pos + lines[i].length >= matchStart) {
          lineNum = i + 1;
          break;
        }
        pos += lines[i].length + 1; // +1 for newline
      }

      const line = lines[lineNum - 1] || '';

      // Check for context requirement
      if (secretPattern.contextRequired) {
        const hasContext = secretPattern.contextRequired.some(ctx =>
          content.includes(ctx) || filePath.includes(ctx)
        );
        if (!hasContext) continue;
      }

      // Skip false positives
      if (isFalsePositive(value, line)) continue;

      // Mask the secret for display
      const masked = maskSecret(value);

      findings.push({
        type: secretPattern.type,
        name: secretPattern.name,
        severity: secretPattern.severity,
        line: lineNum,
        value: masked,
        context: line.trim().slice(0, 100)
      });
    }
  }

  return findings;
}

function maskSecret(value) {
  if (value.length <= 8) return '*'.repeat(value.length);
  const visible = Math.min(4, Math.floor(value.length / 4));
  return value.slice(0, visible) + '*'.repeat(value.length - visible * 2) + value.slice(-visible);
}

// ─────────────────────────────────────────────────────────────
// Git Integration
// ─────────────────────────────────────────────────────────────

function getStagedFiles(projectRoot) {
  const { execSync } = require('child_process');
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
      cwd: projectRoot,
      encoding: 'utf-8'
    });
    return output.trim().split('\n').filter(Boolean).map(f => join(projectRoot, f));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let targetPath = '.';
let scanStaged = false;
let includeTests = false;
let includeExamples = false;
let minSeverity = 'low';

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--staged') {
    scanStaged = true;
  } else if (arg === '--include-tests') {
    includeTests = true;
  } else if (arg === '--include-examples') {
    includeExamples = true;
  } else if (arg === '--min-severity' && options.remaining[i + 1]) {
    minSeverity = options.remaining[++i];
  } else if (!arg.startsWith('-')) {
    targetPath = arg;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

const scanOptions = {
  includeTests,
  includeExamples,
  minSeverity
};

// Get files to scan
let files = [];

if (scanStaged) {
  files = getStagedFiles(projectRoot);
  if (files === null) {
    console.error('Not a git repository or no staged files');
    process.exit(1);
  }
  if (files.length === 0) {
    out.header('No staged files to scan');
    out.print();
    process.exit(0);
  }
} else if (existsSync(targetPath) && statSync(targetPath).isFile()) {
  files = [targetPath];
} else {
  const allFiles = listFiles(targetPath);
  files = allFiles.map(f => f.path);
}

// Scan files
const allFindings = [];
let scannedCount = 0;

for (const file of files) {
  if (shouldSkipFile(file, scanOptions)) continue;

  scannedCount++;
  const findings = scanFile(file, scanOptions);

  if (findings.length > 0) {
    const relPath = relative(projectRoot, file);
    findings.forEach(f => {
      allFindings.push({ ...f, file: relPath });
    });
  }
}

// Sort by severity
const severityOrder = { high: 0, medium: 1, low: 2 };
allFindings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

// Output
const highCount = allFindings.filter(f => f.severity === 'high').length;
const mediumCount = allFindings.filter(f => f.severity === 'medium').length;
const lowCount = allFindings.filter(f => f.severity === 'low').length;

if (allFindings.length === 0) {
  out.header('✓ No secrets found');
  out.add(`Scanned ${scannedCount} files`);
} else {
  const icon = highCount > 0 ? '🚨' : '⚠️';
  out.header(`${icon} Found ${allFindings.length} potential secret(s)`);
  out.blank();

  // Group by file
  const byFile = {};
  for (const finding of allFindings) {
    if (!byFile[finding.file]) byFile[finding.file] = [];
    byFile[finding.file].push(finding);
  }

  for (const [file, findings] of Object.entries(byFile)) {
    out.add(`📄 ${file}`);

    for (const f of findings) {
      const severityIcon = f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '⚪';
      out.add(`   ${severityIcon} Line ${f.line}: ${f.name}`);
      out.add(`      ${f.value}`);
    }
    out.blank();
  }

  // Summary
  out.add('─'.repeat(50));
  const parts = [];
  if (highCount > 0) parts.push(`${highCount} high`);
  if (mediumCount > 0) parts.push(`${mediumCount} medium`);
  if (lowCount > 0) parts.push(`${lowCount} low`);
  out.add(`${parts.join(', ')} severity | ${scannedCount} files scanned`);

  if (highCount > 0) {
    out.blank();
    out.add('⚠️  High severity secrets should be removed and rotated immediately!');
  }
}

// Set JSON data
out.setData('findings', allFindings);
out.setData('summary', { high: highCount, medium: mediumCount, low: lowCount });
out.setData('filesScanned', scannedCount);

out.print();

// Exit with error code if high severity secrets found
if (highCount > 0 && !options.json) {
  process.exit(1);
}
