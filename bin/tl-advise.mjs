#!/usr/bin/env node

/**
 * tl-advise - Recommend the next tokenlean commands for a task
 *
 * Lightweight router for agents: turn an intent like "review this PR" or
 * "debug npm test" into a short ordered command plan.
 *
 * Usage: tl-advise <goal> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-advise',
    desc: 'Recommend the next tokenlean commands for a task',
    when: 'before-read',
    example: 'tl-advise "refactor src/cache.mjs"'
  }));
  process.exit(0);
}

import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';

const HELP = `
tl-advise - Recommend the next tokenlean commands for a task

Usage: tl-advise <goal> [options]

Options:
  --all                Show secondary recommendations too
  --list               List known intent routes
${COMMON_OPTIONS_HELP}

Examples:
  tl-advise "review PR 123"
  tl-advise "debug npm test"
  tl-advise "refactor src/cache.mjs"
  tl-advise "understand this repo"
  tl-advise "prepare commit"
  tl-advise "look up React useEffect docs"
`;

const ROUTES = [
  {
    name: 'pr-review',
    label: 'PR review',
    pattern: /\b(pr|pull request|review)\b/i,
    build: buildReviewAdvice
  },
  {
    name: 'debug',
    label: 'Debugging',
    pattern: /\b(debug|bug|failing|failure|fix test|test fail|repro)\b/i,
    build: buildDebugAdvice
  },
  {
    name: 'refactor',
    label: 'Refactor',
    pattern: /\b(refactor|rename|move|extract|cleanup|clean up)\b/i,
    build: buildRefactorAdvice
  },
  {
    name: 'onboard',
    label: 'Understand codebase',
    pattern: /\b(understand|onboard|explore|map|overview|architecture|codebase|repo)\b/i,
    build: buildOnboardAdvice
  },
  {
    name: 'test',
    label: 'Testing',
    pattern: /\b(tests?|coverage|specs?|assertions?)\b/i,
    build: buildTestAdvice
  },
  {
    name: 'feature',
    label: 'Add feature',
    pattern: /\b(add|implement|feature|build|support)\b/i,
    build: buildFeatureAdvice
  },
  {
    name: 'docs',
    label: 'Documentation lookup',
    pattern: /\b(docs|documentation|api docs|lookup|look up|context7|library)\b/i,
    build: buildDocsAdvice
  },
  {
    name: 'commit',
    label: 'Commit prep',
    pattern: /\b(commit|push|ship|land|pre-commit)\b/i,
    build: buildCommitAdvice
  }
];

function parseArgs(rawArgs) {
  const options = parseCommonArgs(rawArgs);
  let all = false;
  let list = false;
  const goalParts = [];

  for (const arg of options.remaining) {
    if (arg === '--all') all = true;
    else if (arg === '--list') list = true;
    else goalParts.push(arg);
  }

  return {
    ...options,
    all,
    list,
    goal: goalParts.join(' ').trim()
  };
}

function shellQuote(value) {
  if (!value) return '""';
  if (/^[\w@./:=+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function extractPrNumber(goal) {
  const match = goal.match(/\b(?:pr|pull request)\s*#?(\d+)\b/i) || goal.match(/#(\d+)\b/);
  return match ? match[1] : null;
}

function extractPath(goal) {
  const match = goal.match(/(?:^|\s)([.\w@/-]+\.(?:mjs|cjs|js|jsx|ts|tsx|mts|py|go|rs|rb|java|kt|php|cs|css|scss|md|json|ya?ml))(?:\s|$)/i);
  return match ? match[1] : null;
}

function extractCommand(goal) {
  const quoted = goal.match(/"([^"]+)"/) || goal.match(/'([^']+)'/);
  if (quoted) return quoted[1];

  const commandMatch = goal.match(/\b((?:npm|pnpm|yarn|bun|node|npx|pytest|go test|cargo test|cargo build|make|just|uv|pytest|vitest|jest)\b.*)$/i);
  return commandMatch ? commandMatch[1].trim() : null;
}

function add(command, why) {
  return { command, why };
}

function buildReviewAdvice(goal) {
  const pr = extractPrNumber(goal);
  const path = extractPath(goal);
  if (pr) {
    return [
      add(`tl pack pr ${pr}`, 'Start with a compact PR briefing.'),
      add(`tl gh pr digest -R owner/repo ${pr}`, 'Use when GitHub status, CI, reviews, or unresolved comments matter.'),
      add(`tl gh pr comments -R owner/repo ${pr} --unresolved`, 'Pull only unresolved review threads.')
    ];
  }
  if (path) {
    return [
      add(`tl analyze ${path}`, 'Profile the changed file before reading it.'),
      add(`tl impact ${path}`, 'Check blast radius.'),
      add(`tl related ${path}`, 'Find nearby tests and importers.')
    ];
  }
  return [
    add('tl pack review', 'Use current branch/staged context as the review briefing.'),
    add('tl diff --staged', 'Inspect staged changes if the pack shows staged work.'),
    add('tl guard', 'Run pre-commit risk checks before approving or landing.')
  ];
}

function buildDebugAdvice(goal) {
  const command = extractCommand(goal);
  const path = extractPath(goal);
  const advice = [];
  advice.push(add(command ? `tl pack debug ${shellQuote(command)}` : 'tl pack debug "<failing command>"', 'Capture the failure without dumping full logs.'));
  if (path) {
    advice.push(add(`tl related ${path}`, 'Find tests and importers around the suspected file.'));
    advice.push(add(`tl history ${path}`, 'Check recent changes before editing.'));
  } else {
    advice.push(add('tl test --dry-run', 'Map changed files to likely tests.'));
    advice.push(add('tl errors .', 'Scan likely throw/error sites if the failure is unclear.'));
  }
  return advice;
}

function buildRefactorAdvice(goal) {
  const path = extractPath(goal);
  return [
    add(path ? `tl pack refactor ${path}` : 'tl pack refactor <file>', 'Start with file profile, impact, related files, and test mapping.'),
    add(path ? `tl impact ${path}` : 'tl impact <file>', 'Do not edit shared code before checking dependents.'),
    add(path ? `tl test-map ${path}` : 'tl test-map <file>', 'Identify the smallest useful verification target.')
  ];
}

function buildOnboardAdvice(goal) {
  const path = extractPath(goal) || '.';
  return [
    add(`tl pack onboard ${path}`, 'Get project shape, entry points, stack, and token hotspots in one pass.'),
    add(`tl structure ${path} --depth 2`, 'Use this if you only need the directory map.'),
    add('tl entry', 'Find runtime entry points before reading internals.')
  ];
}

function buildFeatureAdvice(goal) {
  const path = extractPath(goal);
  return [
    add('tl pack onboard', 'Map the project before adding behavior.'),
    add(path ? `tl analyze ${path}` : 'tl search <feature keyword>', 'Find the closest existing pattern.'),
    add(path ? `tl related ${path}` : 'tl example <symbol-or-pattern>', 'Locate tests and real usage before editing.')
  ];
}

function buildTestAdvice(goal) {
  const path = extractPath(goal);
  const command = extractCommand(goal);
  if (command) {
    return [
      add(`tl run ${shellQuote(command)} --type test`, 'Summarize test output instead of streaming full logs.'),
      add('tl test --dry-run', 'Find targeted tests for changed files.'),
      add('tl coverage .', 'Check coverage only when risk justifies it.')
    ];
  }
  return [
    add(path ? `tl related ${path}` : 'tl test --dry-run', 'Find the smallest relevant test target.'),
    add(path ? `tl coverage ${path}` : 'tl coverage .', 'Check whether the area is already covered.'),
    add('tl run "npm test" --type test', 'Run broad tests through token-efficient summarization.')
  ];
}

function buildDocsAdvice(goal) {
  const libMatch = goal.match(/\b(?:docs|documentation|lookup|look up)\s+([@\w./-]+)/i);
  const lib = libMatch ? libMatch[1] : '<library>';
  return [
    add(`tl context7 ${shellQuote(lib)}`, 'Use current library docs when available.'),
    add('tl browse <url>', 'Fetch web docs as clean markdown instead of raw page text.'),
    add('tl npm <package>', 'Check package metadata before choosing or upgrading dependencies.')
  ];
}

function buildCommitAdvice() {
  return [
    add('tl commit-prep', 'Collect status, diff stat, and recent log in one call.'),
    add('tl guard', 'Check commit risks before writing the message.'),
    add('tl push "type: summary"', 'Stage tracked changes, commit, and push when ready.')
  ];
}

function defaultAdvice(goal) {
  const path = extractPath(goal);
  return [
    add(path ? `tl analyze ${path}` : 'tl pack onboard', 'Start with compact context before reading files.'),
    add(path ? `tl symbols ${path}` : 'tl structure --depth 2', 'Prefer signatures and structure over full file reads.'),
    add('tl advise "<more specific goal>"', 'Add intent words like review, debug, refactor, test, or commit for a sharper plan.')
  ];
}

function routeGoal(goal, includeAll) {
  const matches = ROUTES.filter(route => route.pattern.test(goal));
  const selected = matches.length > 0 ? matches : [];
  const primary = selected[0];

  if (!primary) {
    return {
      intent: 'general',
      label: 'General context',
      suggestions: defaultAdvice(goal)
    };
  }

  const suggestions = [];
  for (const route of includeAll ? selected : [primary]) {
    for (const item of route.build(goal)) {
      if (!suggestions.some(existing => existing.command === item.command)) {
        suggestions.push(item);
      }
    }
  }

  return {
    intent: primary.name,
    label: primary.label,
    suggestions
  };
}

function printRoutes(out) {
  out.header('Known intent routes:');
  for (const route of ROUTES) {
    out.add(`  ${route.name.padEnd(12)} ${route.label}`);
  }
  out.setData('routes', ROUTES.map(route => ({ name: route.name, label: route.label })));
  out.print();
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const out = createOutput(options);

if (options.list) {
  printRoutes(out);
  process.exit(0);
}

if (!options.goal) {
  console.error('Goal required. Example: tl advise "debug npm test"');
  process.exit(1);
}

const result = routeGoal(options.goal, options.all);

out.setData('goal', options.goal);
out.setData('intent', result.intent);
out.setData('label', result.label);
out.setData('suggestions', result.suggestions);

out.header(`Advice: ${result.label}`);
out.header(`Goal: ${options.goal}`);
out.blank();

result.suggestions.forEach((item, index) => {
  out.add(`${index + 1}. ${item.command}`);
  if (!options.quiet) out.add(`   ${item.why}`);
});

out.print();
