#!/usr/bin/env node

/**
 * tl-gh - Token-efficient GitHub CLI wrapper
 *
 * Wraps multi-step gh workflows into single commands.
 * Only covers operations that need 2+ separate gh calls.
 *
 * Usage: tl-gh <command> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-gh',
    desc: 'Batch GitHub operations (issues, sub-issues, project boards)',
    when: 'github',
    example: 'tl-gh issue create-batch --repo edimuj/foo < issues.jsonl'
  }));
  process.exit(0);
}

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createOutput, parseCommonArgs, COMMON_OPTIONS_HELP } from '../src/output.mjs';

// ── Helpers ──────────────────────────────────────────────────────────

function gh(args, { json = false } = {}) {
  const result = execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return json ? JSON.parse(result) : result.trim();
}

function ghGraphQL(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    const flag = typeof v === 'number' || typeof v === 'boolean' ? '-F' : '-f';
    args.push(flag, `${k}=${v}`);
  }
  const result = JSON.parse(execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
  if (result.errors?.length) {
    const msg = result.errors.map(e => e.message).join('; ');
    const err = new Error(`GraphQL error: ${msg}`);
    err.graphqlErrors = result.errors;
    throw err;
  }
  return result;
}

function withRetry(fn, { retries = 2, backoff = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff * (attempt + 1));
    }
  }
}

function getIssueNodeId(repo, number) {
  const [owner, name] = repo.split('/');
  const result = ghGraphQL(`{
    repository(owner: "${owner}", name: "${name}") {
      issue(number: ${number}) { id }
    }
  }`);
  const issueId = result?.data?.repository?.issue?.id;
  if (!issueId) {
    throw new Error(`Issue not found: ${repo}#${number}`);
  }
  return issueId;
}

function resolveProjectId(owner, number) {
  // Try user first, then org — can't query both in one request because
  // GitHub returns a top-level error if either field fails to resolve.
  try {
    const r = ghGraphQL(`query($owner: String!, $number: Int!) {
      user(login: $owner) { projectV2(number: $number) { id } }
    }`, { owner, number });
    if (r?.data?.user?.projectV2?.id) return r.data.user.projectV2.id;
  } catch { /* not a user, try org */ }
  try {
    const r = ghGraphQL(`query($owner: String!, $number: Int!) {
      organization(login: $owner) { projectV2(number: $number) { id } }
    }`, { owner, number });
    if (r?.data?.organization?.projectV2?.id) return r.data.organization.projectV2.id;
  } catch { /* not an org either */ }
  throw new Error(`Project not found: ${owner}/${number}`);
}

function addToProject(projectOwner, projectNumber, issueUrl) {
  const projectId = resolveProjectId(projectOwner, projectNumber);

  // Get issue node ID from URL (extract owner/repo#number)
  const match = issueUrl.match(/repos\/(.+?)\/(.+?)\/issues\/(\d+)/);
  let contentId;
  if (match) {
    contentId = getIssueNodeId(`${match[1]}/${match[2]}`, parseInt(match[3]));
  } else {
    // Try URL format: https://github.com/owner/repo/issues/123
    const urlMatch = issueUrl.match(/github\.com\/(.+?)\/(.+?)\/issues\/(\d+)/);
    if (urlMatch) {
      contentId = getIssueNodeId(`${urlMatch[1]}/${urlMatch[2]}`, parseInt(urlMatch[3]));
    } else {
      throw new Error(`Cannot parse issue URL: ${issueUrl}`);
    }
  }

  ghGraphQL(`mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
      item { id }
    }
  }`, { projectId, contentId });
}

function parseProject(flag) {
  // Format: "owner/number" e.g. "edimuj/1"
  if (!flag) return null;
  const match = flag.match(/^(.+?)\/(\d+)$/);
  if (!match) {
    console.error(`Error: --project format must be owner/number (e.g. edimuj/1)`);
    process.exit(1);
  }
  return { owner: match[1], number: parseInt(match[2]) };
}

function readStdinJSON() {
  const raw = readFileSync('/dev/stdin', 'utf-8').trim();
  if (!raw) {
    console.error('Error: No input on stdin');
    process.exit(1);
  }

  // Try JSON array first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch {
    // Fall back to JSONL
    return raw.split('\n')
      .filter(line => line.trim())
      .map((line, i) => {
        try { return JSON.parse(line); }
        catch { console.error(`Error: Invalid JSON on line ${i + 1}`); process.exit(1); }
      });
  }
}

function extractArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

// ── Commands ─────────────────────────────────────────────────────────

async function issueView(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const issueNum = args.find(a => /^\d+$/.test(a));

  if (!repo || !issueNum) {
    console.error('Error: --repo/-R and issue number are required');
    console.error('Usage: tl-gh issue view -R owner/repo 434');
    process.exit(1);
  }

  const full = hasFlag(args, '--full');
  const noBody = hasFlag(args, '--no-body');
  const bodyLines = parseInt(extractArg(args, '--body-lines') || '5', 10);
  const out = createOutput(parseCommonArgs(args));

  const [owner, name] = repo.split('/');
  let result;
  try {
    result = ghGraphQL(`{
      repository(owner: "${owner}", name: "${name}") {
        issue(number: ${issueNum}) {
          number title state body url createdAt closedAt
          author { login }
          assignees(first: 5) { nodes { login } }
          labels(first: 10) { nodes { name } }
          comments { totalCount }
          subIssues(first: 50) {
            totalCount
            nodes {
              number title state body url
              labels(first: 5) { nodes { name } }
              assignees(first: 3) { nodes { login } }
              comments { totalCount }
            }
          }
        }
      }
    }`);
  } catch {
    console.error(`Error: Issue not found: ${repo}#${issueNum}`);
    process.exit(1);
  }

  const issue = result?.data?.repository?.issue;
  if (!issue) {
    console.error(`Error: Issue not found: ${repo}#${issueNum}`);
    process.exit(1);
  }

  const subs = issue.subIssues?.nodes || [];
  const subCount = issue.subIssues?.totalCount || 0;

  // ── Text output ──
  const stateIcon = issue.state === 'OPEN' ? '○' : issue.state === 'CLOSED' ? '●' : '◆';
  const labels = issue.labels?.nodes?.map(l => l.name) || [];
  const assignees = issue.assignees?.nodes?.map(a => a.login) || [];

  out.header(`${stateIcon} #${issue.number} ${issue.title}`);
  const meta = [`${issue.state}`, issue.url];
  if (labels.length) meta.push(`Labels: ${labels.join(', ')}`);
  if (assignees.length) meta.push(`Assignees: ${assignees.join(', ')}`);
  if (issue.comments?.totalCount) meta.push(`${issue.comments.totalCount} comments`);
  out.add(`  ${meta.join(' | ')}`);

  if (!noBody && issue.body) {
    out.blank();
    out.add(truncateBody(issue.body, full ? Infinity : bodyLines));
  }

  // ── Sub-issues ──
  if (subCount > 0) {
    out.blank();
    const openCount = subs.filter(s => s.state === 'OPEN').length;
    const closedCount = subs.filter(s => s.state !== 'OPEN').length;
    out.add(`  Sub-issues: ${subCount} (${openCount} open, ${closedCount} closed)`);
    out.add('  ─'.padEnd(60, '─'));

    for (const sub of subs) {
      const subIcon = sub.state === 'OPEN' ? '○' : '●';
      const subLabels = sub.labels?.nodes?.map(l => l.name) || [];
      const labelStr = subLabels.length ? ` [${subLabels.join(', ')}]` : '';
      out.add(`  ${subIcon} #${sub.number} ${sub.title}${labelStr}`);

      if (!noBody && sub.body) {
        const lines = truncateBody(sub.body, full ? Infinity : bodyLines);
        for (const line of lines.split('\n')) {
          out.add(`    ${line}`);
        }
      }
    }
  }

  out.setData('issue', {
    ...issue,
    labels,
    assignees,
    subIssues: subs.map(s => ({
      number: s.number,
      title: s.title,
      state: s.state,
      labels: s.labels?.nodes?.map(l => l.name) || [],
      assignees: s.assignees?.nodes?.map(a => a.login) || [],
      comments: s.comments?.totalCount || 0,
      body: s.body,
    })),
  });
  out.print();
}

function truncateBody(body, maxLines) {
  if (!body) return '';
  const lines = body.split('\n');
  if (lines.length <= maxLines) return body;
  return lines.slice(0, maxLines).join('\n') + `\n  … (${lines.length - maxLines} more lines)`;
}

async function issueCreateBatch(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const project = parseProject(extractArg(args, '--project'));

  if (!repo) {
    console.error('Error: --repo/-R is required');
    process.exit(1);
  }

  const issues = readStdinJSON();
  const out = createOutput(parseCommonArgs(args));
  out.header(`Creating ${issues.length} issues in ${repo}`);

  const results = [];
  for (const issue of issues) {
    const ghArgs = ['issue', 'create', '-R', repo, '--title', issue.title, '--body', issue.body || ''];
    if (issue.labels) {
      const labels = Array.isArray(issue.labels) ? issue.labels.join(',') : issue.labels;
      ghArgs.push('--label', labels);
    }
    if (issue.assignee) ghArgs.push('--assignee', issue.assignee);
    if (issue.milestone) ghArgs.push('--milestone', issue.milestone);

    try {
      const url = gh(ghArgs);
      const num = url.match(/\/(\d+)$/)?.[1] || '?';
      results.push({ number: num, title: issue.title, url, status: 'created' });

      if (project) {
        try {
          withRetry(() => addToProject(project.owner, project.number, url));
          results[results.length - 1].project = true;
        } catch (e) {
          results[results.length - 1].project = `failed: ${e.message}`;
        }
      }
    } catch (e) {
      results.push({ title: issue.title, status: 'failed', error: e.message });
    }
  }

  const created = results.filter(r => r.status === 'created');
  const failed = results.filter(r => r.status === 'failed');

  for (const r of created) {
    const projTag = r.project === true ? ' [+project]' : r.project ? ` [${r.project}]` : '';
    out.add(`  #${r.number} ${r.title}${projTag}`);
  }
  const projFailed = created.filter(r => r.project && r.project !== true);
  if (projFailed.length) {
    out.add('');
    for (const r of projFailed) {
      out.add(`  ⚠ #${r.number} project add failed: ${r.project.replace('failed: ', '')}`);
    }
  }
  if (failed.length) {
    out.add('');
    for (const r of failed) {
      out.add(`  FAILED: ${r.title} — ${r.error}`);
    }
  }

  const projNote = projFailed.length ? `, ${projFailed.length} project-add failed` : '';
  out.stats(`${created.length} created, ${failed.length} failed${projNote}`);
  out.setData('results', results);
  out.print();
}

async function issueAddSub(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const parentNum = extractArg(args, '--parent');

  if (!repo || !parentNum) {
    console.error('Error: --repo/-R and --parent are required');
    console.error('Usage: tl-gh issue add-sub --repo owner/repo --parent 10 42 43 44');
    process.exit(1);
  }

  // Remaining positional args are child issue numbers
  const childNums = args.filter(a =>
    !a.startsWith('-') && a !== 'issue' && a !== 'add-sub'
    && a !== repo && a !== parentNum
  ).map(Number).filter(n => n > 0);

  if (!childNums.length) {
    console.error('Error: Provide child issue numbers as positional arguments');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));
  out.header(`Linking ${childNums.length} sub-issues to #${parentNum} in ${repo}`);

  let parentId;
  try {
    parentId = getIssueNodeId(repo, parseInt(parentNum, 10));
  } catch (e) {
    out.add(`  ⛔ Could not resolve parent #${parentNum}: ${e.message}`);
    out.stats('0 linked, 1 failed');
    out.setData('results', [{ number: parseInt(parentNum, 10), status: 'failed', error: e.message }]);
    out.print();
    process.exit(1);
  }
  const results = [];

  for (const childNum of childNums) {
    try {
      const childId = getIssueNodeId(repo, childNum);
      withRetry(() => ghGraphQL(`mutation($parentId: ID!, $childId: ID!) {
        addSubIssue(input: {issueId: $parentId, subIssueId: $childId}) {
          issue { id }
        }
      }`, { parentId, childId }));
      results.push({ number: childNum, status: 'linked' });
      out.add(`  #${childNum} → sub of #${parentNum}`);
    } catch (e) {
      results.push({ number: childNum, status: 'failed', error: e.message });
      out.add(`  #${childNum} FAILED: ${e.message}`);
    }
  }

  const linked = results.filter(r => r.status === 'linked').length;
  const failed = results.filter(r => r.status === 'failed').length;
  out.stats(`${linked} linked, ${failed} failed`);
  out.setData('results', results);
  out.print();
}

async function issueCreateTree(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const project = parseProject(extractArg(args, '--project'));

  if (!repo) {
    console.error('Error: --repo/-R is required');
    process.exit(1);
  }

  const input = readStdinJSON();
  // Input: [{ title, body, labels, children: [{ title, body, labels }] }]
  // Or single object (not array)
  const trees = Array.isArray(input) ? input : [input];

  const out = createOutput(parseCommonArgs(args));
  out.header(`Creating ${trees.length} issue tree(s) in ${repo}`);

  const results = [];

  for (const tree of trees) {
    // Create parent
    const parentArgs = ['issue', 'create', '-R', repo, '--title', tree.title, '--body', tree.body || ''];
    if (tree.labels) {
      const labels = Array.isArray(tree.labels) ? tree.labels.join(',') : tree.labels;
      parentArgs.push('--label', labels);
    }
    if (tree.assignee) parentArgs.push('--assignee', tree.assignee);

    let parentUrl, parentNum;
    try {
      parentUrl = gh(parentArgs);
      parentNum = parentUrl.match(/\/(\d+)$/)?.[1];
    } catch (e) {
      results.push({ title: tree.title, status: 'failed', error: e.message });
      out.add(`  FAILED parent: ${tree.title} — ${e.message}`);
      continue;
    }

    const treeResult = { number: parentNum, title: tree.title, status: 'created', url: parentUrl, children: [] };

    if (project) {
      try {
        withRetry(() => addToProject(project.owner, project.number, parentUrl));
        treeResult.project = true;
      } catch (e) {
        treeResult.project = `failed: ${e.message}`;
      }
    }

    const projTag = treeResult.project === true ? ' [+project]' : '';
    out.add(`  #${parentNum} ${tree.title}${projTag}`);

    // Create children and link as sub-issues
    const children = tree.children || [];
    if (children.length) {
      const parentId = getIssueNodeId(repo, parseInt(parentNum));

      for (const child of children) {
        const childArgs = ['issue', 'create', '-R', repo, '--title', child.title, '--body', child.body || ''];
        if (child.labels) {
          const labels = Array.isArray(child.labels) ? child.labels.join(',') : child.labels;
          childArgs.push('--label', labels);
        }
        if (child.assignee) childArgs.push('--assignee', child.assignee);

        try {
          const childUrl = gh(childArgs);
          const childNum = childUrl.match(/\/(\d+)$/)?.[1];

          // Resolve child node ID (retry — GitHub may not have indexed the new issue yet)
          const childId = withRetry(
            () => getIssueNodeId(repo, parseInt(childNum)),
            { retries: 2, backoff: 2000 }
          );
          withRetry(() => ghGraphQL(`mutation($parentId: ID!, $childId: ID!) {
            addSubIssue(input: {issueId: $parentId, subIssueId: $childId}) {
              issue { id }
            }
          }`, { parentId, childId }));

          // Add child to project too
          if (project) {
            try {
              withRetry(() => addToProject(project.owner, project.number, childUrl));
            } catch { /* parent success is enough */ }
          }

          treeResult.children.push({ number: childNum, title: child.title, status: 'created', url: childUrl });
          out.add(`    └─ #${childNum} ${child.title}`);
        } catch (e) {
          treeResult.children.push({ title: child.title, status: 'failed', error: e.message });
          out.add(`    └─ FAILED: ${child.title} — ${e.message}`);
        }
      }
    }

    results.push(treeResult);
  }

  const totalParents = results.filter(r => r.status === 'created').length;
  const totalChildren = results.flatMap(r => r.children || []).filter(c => c.status === 'created').length;
  const totalFailed = results.filter(r => r.status === 'failed').length
    + results.flatMap(r => r.children || []).filter(c => c.status === 'failed').length;

  out.stats(`${totalParents} parents, ${totalChildren} children created, ${totalFailed} failed`);
  out.setData('results', results);
  out.print();
}

// ── PR Commands ──────────────────────────────────────────────────────

async function prDigest(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const prNum = args.find(a => /^\d+$/.test(a));

  if (!repo || !prNum) {
    console.error('Error: --repo/-R and PR number are required');
    console.error('Usage: tl-gh pr digest -R owner/repo 123');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));

  // Fetch all data: pr view, reviews, comments, checks
  const pr = gh(['pr', 'view', prNum, '-R', repo, '--json',
    'title,state,author,baseRefName,headRefName,mergeable,additions,deletions,' +
    'changedFiles,reviewDecision,labels,url,body,number,isDraft,createdAt,' +
    'statusCheckRollup,reviewRequests'], { json: true });

  const [owner, name] = repo.split('/');
  let reviews = [], comments = [];
  try {
    reviews = gh(['api', `repos/${owner}/${name}/pulls/${prNum}/reviews`], { json: true });
  } catch { /* no reviews */ }
  try {
    comments = gh(['api', `repos/${owner}/${name}/pulls/${prNum}/comments`], { json: true });
  } catch { /* no comments */ }

  // Header
  const draft = pr.isDraft ? ' [DRAFT]' : '';
  const state = pr.state === 'MERGED' ? 'MERGED' : pr.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  out.header(`#${pr.number} ${pr.title}${draft}`);
  out.add(`  ${state} | ${pr.headRefName} → ${pr.baseRefName} | +${pr.additions} -${pr.deletions} (${pr.changedFiles} files)`);
  out.add(`  By ${pr.author.login} | ${pr.url}`);

  // Labels
  if (pr.labels?.length) {
    out.add(`  Labels: ${pr.labels.map(l => l.name).join(', ')}`);
  }

  // Mergeable
  if (pr.state === 'OPEN') {
    const merge = pr.mergeable === 'MERGEABLE' ? 'clean' :
      pr.mergeable === 'CONFLICTING' ? 'CONFLICTS' : pr.mergeable?.toLowerCase() || 'unknown';
    out.add(`  Merge: ${merge}`);
  }

  // CI checks
  const checks = pr.statusCheckRollup || [];
  if (checks.length) {
    out.blank();
    const passed = checks.filter(c => c.conclusion === 'SUCCESS' || c.status === 'COMPLETED' && c.conclusion === 'SUCCESS').length;
    const failed = checks.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR').length;
    const pending = checks.filter(c => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING').length;
    const skipped = checks.length - passed - failed - pending;

    let ciSummary = `CI: ${passed}/${checks.length} passed`;
    if (failed) ciSummary += `, ${failed} FAILED`;
    if (pending) ciSummary += `, ${pending} pending`;
    if (skipped) ciSummary += `, ${skipped} skipped`;
    out.add(`  ${ciSummary}`);

    // Show failed checks by name
    const failedChecks = checks.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR');
    for (const c of failedChecks) {
      out.add(`    ✗ ${c.name || c.context || 'unknown'}`);
    }
  }

  // Reviews
  if (reviews.length) {
    out.blank();
    // Deduplicate: take latest review per user
    const byUser = new Map();
    for (const r of reviews) {
      if (r.state === 'COMMENTED' && !r.body) continue; // skip empty comments-only
      byUser.set(r.user.login, r);
    }

    const verdicts = [];
    for (const [login, r] of byUser) {
      const icon = r.state === 'APPROVED' ? '✓' :
        r.state === 'CHANGES_REQUESTED' ? '✗' :
        r.state === 'COMMENTED' ? '💬' : '?';
      verdicts.push(`${icon} ${login}: ${r.state.toLowerCase().replace('_', ' ')}`);
    }
    out.add(`  Reviews: ${pr.reviewDecision?.toLowerCase().replace('_', ' ') || 'none'}`);
    for (const v of verdicts) {
      out.add(`    ${v}`);
    }

    // Pending reviewers
    if (pr.reviewRequests?.length) {
      for (const rr of pr.reviewRequests) {
        const name = rr.login || rr.name || 'unknown';
        out.add(`    ⏳ ${name}: pending`);
      }
    }
  }

  // Comments summary
  if (comments.length) {
    out.blank();
    // Group by resolved/unresolved (in_reply_to_id means threaded)
    const threads = new Map();
    for (const c of comments) {
      const threadId = c.in_reply_to_id || c.id;
      if (!threads.has(threadId)) {
        threads.set(threadId, { file: c.path, line: c.line || c.original_line, replies: 0, resolved: false });
      } else {
        threads.get(threadId).replies++;
      }
    }
    // Check for resolved threads via GraphQL and use those threads for unresolved-by-file counts.
    const [gqlOwner, gqlName] = repo.split('/');
    let gqlThreads;
    let resolvedCount = 0;
    try {
      const threadData = ghGraphQL(`{
        repository(owner: "${gqlOwner}", name: "${gqlName}") {
          pullRequest(number: ${prNum}) {
            reviewThreads(first: 100) {
              nodes { isResolved path line }
            }
          }
        }
      }`);
      gqlThreads = threadData.data.repository.pullRequest.reviewThreads.nodes || [];
      resolvedCount = gqlThreads.filter(t => t.isResolved).length;
    } catch { /* fall back to count only */ }

    const total = gqlThreads ? gqlThreads.length : threads.size;
    const unresolved = total - resolvedCount;
    out.add(`  Comments: ${total} threads (${unresolved} unresolved, ${resolvedCount} resolved)`);

    // Show unresolved by file
    if (unresolved > 0) {
      const byFile = new Map();
      if (gqlThreads) {
        for (const t of gqlThreads) {
          if (t.isResolved) continue;
          const file = t.path || '(general)';
          const count = byFile.get(file) || 0;
          byFile.set(file, count + 1);
        }
      } else {
        for (const [, t] of threads) {
          const count = byFile.get(t.file) || 0;
          byFile.set(t.file, count + 1);
        }
      }
      for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        out.add(`    ${file}: ${count}`);
      }
    }
  }

  // Bottom line verdict
  out.blank();
  const blockers = [];
  if (pr.isDraft) blockers.push('draft');
  if (pr.mergeable === 'CONFLICTING') blockers.push('conflicts');
  const failedCI = (pr.statusCheckRollup || []).filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR');
  if (failedCI.length) blockers.push(`${failedCI.length} CI failures`);
  if (pr.reviewDecision === 'CHANGES_REQUESTED') blockers.push('changes requested');
  if (pr.reviewDecision !== 'APPROVED' && pr.state === 'OPEN') blockers.push('not approved');

  if (blockers.length) {
    out.add(`  ⛔ Blocked: ${blockers.join(', ')}`);
  } else if (pr.state === 'OPEN') {
    out.add(`  ✅ Ready to merge`);
  }

  out.setData('pr', { ...pr, reviews: [...(new Map(reviews.map(r => [r.user?.login, r]))).values()], comments: comments.length });
  out.print();
}

async function prComments(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const prNum = args.find(a => /^\d+$/.test(a));
  const unresolvedOnly = hasFlag(args, '--unresolved');

  if (!repo || !prNum) {
    console.error('Error: --repo/-R and PR number are required');
    console.error('Usage: tl-gh pr comments -R owner/repo 123 [--unresolved]');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));
  const [owner, name] = repo.split('/');

  // Get review threads via GraphQL (includes resolution status)
  const result = ghGraphQL(`{
    repository(owner: "${owner}", name: "${name}") {
      pullRequest(number: ${prNum}) {
        title
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            path
            line
            comments(first: 50) {
              nodes {
                author { login }
                body
                createdAt
              }
            }
          }
        }
      }
    }
  }`);

  const pr = result.data.repository.pullRequest;
  let threads = pr.reviewThreads.nodes;

  if (unresolvedOnly) {
    threads = threads.filter(t => !t.isResolved);
  }

  out.header(`#${prNum} ${pr.title} — ${threads.length} ${unresolvedOnly ? 'unresolved ' : ''}threads`);

  if (!threads.length) {
    out.add(unresolvedOnly ? '  No unresolved threads' : '  No review comments');
    out.print();
    return;
  }

  // Group by file
  const byFile = new Map();
  for (const t of threads) {
    const file = t.path || '(general)';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(t);
  }

  const data = [];
  for (const [file, fileThreads] of byFile) {
    out.blank();
    out.add(`── ${file} ──`);

    for (const t of fileThreads) {
      const status = t.isResolved ? '✓ resolved' : t.isOutdated ? '⚠ outdated' : '● open';
      const lineInfo = t.line ? `:${t.line}` : '';
      out.add(`  [${status}]${lineInfo}`);

      for (const c of t.comments.nodes) {
        const body = c.body.split('\n')[0].slice(0, 120);
        out.add(`    @${c.author?.login || '?'}: ${body}`);
      }

      data.push({
        file, line: t.line, resolved: t.isResolved, outdated: t.isOutdated,
        comments: t.comments.nodes.map(c => ({ author: c.author?.login, body: c.body }))
      });
    }
  }

  const resolved = threads.filter(t => t.isResolved).length;
  const open = threads.filter(t => !t.isResolved).length;
  out.stats(`${open} open, ${resolved} resolved across ${byFile.size} files`);
  out.setData('threads', data);
  out.print();
}

async function issueCloseBatch(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const comment = extractArg(args, '--comment') || extractArg(args, '-c');
  const reason = extractArg(args, '--reason') || 'completed';

  if (!repo) {
    console.error('Error: --repo/-R is required');
    process.exit(1);
  }

  const issueNums = args.filter(a => /^\d+$/.test(a));
  if (!issueNums.length) {
    console.error('Error: Provide issue numbers as positional arguments');
    console.error('Usage: tl-gh issue close-batch -R owner/repo 1 2 3 -c "Sprint done"');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));
  out.header(`Closing ${issueNums.length} issues in ${repo}`);

  const results = [];
  for (const num of issueNums) {
    const ghArgs = ['issue', 'close', num, '-R', repo, '--reason', reason];
    if (comment) ghArgs.push('-c', comment);

    try {
      gh(ghArgs);
      results.push({ number: num, status: 'closed' });
      out.add(`  #${num} closed`);
    } catch (e) {
      results.push({ number: num, status: 'failed', error: e.message });
      out.add(`  #${num} FAILED: ${e.message}`);
    }
  }

  const closed = results.filter(r => r.status === 'closed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  out.stats(`${closed} closed, ${failed} failed`);
  out.setData('results', results);
  out.print();
}

async function issueLabelBatch(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const addLabels = extractArg(args, '--add');
  const removeLabels = extractArg(args, '--remove');

  if (!repo) {
    console.error('Error: --repo/-R is required');
    process.exit(1);
  }
  if (!addLabels && !removeLabels) {
    console.error('Error: --add and/or --remove are required');
    console.error('Usage: tl-gh issue label-batch -R owner/repo --add "bug,P0" --remove "triage" 1 2 3');
    process.exit(1);
  }

  const issueNums = args.filter(a => /^\d+$/.test(a));
  if (!issueNums.length) {
    console.error('Error: Provide issue numbers as positional arguments');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));
  const actions = [];
  if (addLabels) actions.push(`+${addLabels}`);
  if (removeLabels) actions.push(`-${removeLabels}`);
  out.header(`Labeling ${issueNums.length} issues in ${repo} (${actions.join(', ')})`);

  const results = [];
  for (const num of issueNums) {
    const ghArgs = ['issue', 'edit', num, '-R', repo];
    if (addLabels) ghArgs.push('--add-label', addLabels);
    if (removeLabels) ghArgs.push('--remove-label', removeLabels);

    try {
      gh(ghArgs);
      results.push({ number: num, status: 'updated' });
      out.add(`  #${num} updated`);
    } catch (e) {
      results.push({ number: num, status: 'failed', error: e.message });
      out.add(`  #${num} FAILED: ${e.message}`);
    }
  }

  const updated = results.filter(r => r.status === 'updated').length;
  const failed = results.filter(r => r.status === 'failed').length;
  out.stats(`${updated} updated, ${failed} failed`);
  out.setData('results', results);
  out.print();
}

async function prLand(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const prNum = args.find(a => /^\d+$/.test(a));
  const method = extractArg(args, '--method') || 'squash';
  const deleteBranch = !hasFlag(args, '--no-delete');
  const closeIssues = !hasFlag(args, '--no-close');
  const dryRun = hasFlag(args, '--dry-run');

  if (!repo || !prNum) {
    console.error('Error: --repo/-R and PR number are required');
    console.error('Usage: tl-gh pr land -R owner/repo 123 [--method merge|squash|rebase]');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));
  const [owner, name] = repo.split('/');

  // Step 1: Get PR state + checks
  out.header(`Landing PR #${prNum} in ${repo}`);

  const pr = gh(['pr', 'view', prNum, '-R', repo, '--json',
    'title,state,headRefName,mergeable,statusCheckRollup,body,number'], { json: true });

  if (pr.state !== 'OPEN') {
    out.add(`  ⛔ PR is ${pr.state.toLowerCase()}, cannot land`);
    out.print();
    process.exit(1);
  }

  // Step 2: Check CI
  const checks = pr.statusCheckRollup || [];
  const failed = checks.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR');
  const pending = checks.filter(c => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING');

  if (failed.length) {
    out.add(`  ⛔ ${failed.length} CI check(s) failed:`);
    for (const c of failed) out.add(`    ✗ ${c.name || c.context}`);
    out.add('  Use --force to merge anyway (not implemented — fix CI first)');
    out.print();
    process.exit(1);
  }

  if (pending.length) {
    out.add(`  ⏳ ${pending.length} check(s) still running — waiting...`);
    // Poll checks up to 5 minutes
    const start = Date.now();
    const timeout = 5 * 60 * 1000;
    let ready = false;
    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 10_000));
      const fresh = gh(['pr', 'view', prNum, '-R', repo, '--json', 'statusCheckRollup'], { json: true });
      const freshChecks = fresh.statusCheckRollup || [];
      const stillPending = freshChecks.filter(c => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING');
      const nowFailed = freshChecks.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR');
      if (nowFailed.length) {
        out.add(`  ⛔ ${nowFailed.length} check(s) failed while waiting`);
        for (const c of nowFailed) out.add(`    ✗ ${c.name || c.context}`);
        out.print();
        process.exit(1);
      }
      if (!stillPending.length) { ready = true; break; }
      out.add(`  ⏳ ${stillPending.length} still pending (${Math.round((Date.now() - start) / 1000)}s)...`);
    }
    if (!ready) {
      out.add(`  ⛔ Timed out waiting for CI (5m). Try again later`);
      out.print();
      process.exit(1);
    }
    out.add(`  ✓ All checks passed`);
  } else if (checks.length) {
    out.add(`  ✓ CI: ${checks.length} checks passed`);
  }

  // Step 3: Check merge conflicts
  if (pr.mergeable === 'CONFLICTING') {
    out.add(`  ⛔ Merge conflicts — resolve before landing`);
    out.print();
    process.exit(1);
  }

  if (dryRun) {
    out.add(`  [dry-run] Would merge with --${method}${deleteBranch ? ', delete branch' : ''}${closeIssues ? ', close linked issues' : ''}`);
    out.print();
    return;
  }

  // Step 4: Merge
  const mergeArgs = ['pr', 'merge', prNum, '-R', repo, `--${method}`];
  if (deleteBranch) mergeArgs.push('--delete-branch');
  try {
    gh(mergeArgs);
    out.add(`  ✓ Merged via ${method}${deleteBranch ? ' (branch deleted)' : ''}`);
  } catch (e) {
    out.add(`  ⛔ Merge failed: ${e.message}`);
    out.print();
    process.exit(1);
  }

  // Step 5: Close linked issues
  if (closeIssues) {
    // Extract "Closes #N", "Fixes #N", "Resolves #N" from PR body
    const body = pr.body || '';
    const issueRefs = [...body.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)];
    if (issueRefs.length) {
      const nums = [...new Set(issueRefs.map(m => m[1]))];
      for (const num of nums) {
        try {
          gh(['issue', 'close', num, '-R', repo, '-c', `Closed via PR #${prNum}`]);
          out.add(`  ✓ Closed linked issue #${num}`);
        } catch {
          out.add(`  ⚠ Could not close #${num} (may already be closed)`);
        }
      }
    }
  }

  out.stats('landed');
  out.print();
}

async function releaseNotes(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const tag = extractArg(args, '--tag');
  const dryRun = hasFlag(args, '--dry-run');
  const draft = hasFlag(args, '--draft');

  if (!repo) {
    console.error('Error: --repo/-R is required');
    console.error('Usage: tl-gh release notes -R owner/repo --tag v1.2.0 [--dry-run] [--draft]');
    process.exit(1);
  }

  if (!tag) {
    console.error('Error: --tag is required (the new version tag)');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));
  const [owner, name] = repo.split('/');

  // Find previous tag
  let prevTag;
  try {
    const tags = gh(['api', `repos/${owner}/${name}/tags`, '--jq', '.[].name'], { json: false });
    const tagList = tags.split('\n').filter(Boolean);
    // Previous tag is the latest existing one
    prevTag = tagList[0];
  } catch { /* no previous tags */ }

  out.header(`Release ${tag} for ${repo}`);

  // Get commits since last tag
  let commits = [];
  if (prevTag) {
    try {
      const compare = gh(['api', `repos/${owner}/${name}/compare/${prevTag}...HEAD`], { json: true });
      commits = (compare.commits || []).map(c => ({
        fullSha: c.sha,
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.author?.login || c.commit.author?.name || 'unknown'
      }));
    } catch { /* comparison failed */ }
  }
  if (!commits.length) {
    // Fallback: recent commits from default branch
    try {
      const recent = gh(['api', `repos/${owner}/${name}/commits?per_page=30`], { json: true });
      commits = recent.map(c => ({
        fullSha: c.sha,
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.author?.login || c.commit.author?.name || 'unknown'
      }));
    } catch { /* no commits */ }
  }

  // Get merged PRs since last tag
  let prs = [];
  try {
    const prList = gh(['pr', 'list', '-R', repo, '--state', 'merged', '--limit', '50', '--json',
      'number,title,author,labels,mergedAt'], { json: true });

    if (prevTag && commits.length) {
      // Use the oldest commit's date as cutoff — anything merged after that belongs to this release
      const oldestCommitSha = commits[0].fullSha || commits[0].sha;
      try {
        const commitData = gh(['api', `repos/${owner}/${name}/commits/${oldestCommitSha}`], { json: true });
        const cutoff = new Date(commitData.commit.committer?.date || commitData.commit.author?.date);
        prs = prList.filter(pr => new Date(pr.mergedAt) >= cutoff);
      } catch {
        prs = prList;
      }
    } else {
      prs = prList;
    }
  } catch { /* no PRs */ }

  // Categorize by conventional commit prefix
  const categories = new Map();
  const categorize = (msg) => {
    if (/^feat/i.test(msg)) return 'Features';
    if (/^fix/i.test(msg)) return 'Bug Fixes';
    if (/^refactor/i.test(msg)) return 'Refactoring';
    if (/^test/i.test(msg)) return 'Tests';
    if (/^docs?/i.test(msg)) return 'Documentation';
    if (/^chore|^ci|^build/i.test(msg)) return 'Maintenance';
    if (/^perf/i.test(msg)) return 'Performance';
    return 'Other';
  };

  // Prefer PRs over raw commits when available
  const items = prs.length ? prs.map(pr => ({
    text: `${pr.title} (#${pr.number}) @${pr.author?.login || pr.author?.name || 'unknown'}`,
    category: categorize(pr.title)
  })) : commits.map(c => ({
    text: `${c.message} (${c.sha}) @${c.author}`,
    category: categorize(c.message)
  }));

  for (const item of items) {
    if (!categories.has(item.category)) categories.set(item.category, []);
    categories.get(item.category).push(item.text);
  }

  // Build release body
  const lines = [];
  if (prevTag) lines.push(`Changes since ${prevTag}\n`);

  const categoryOrder = ['Features', 'Bug Fixes', 'Performance', 'Refactoring', 'Tests', 'Documentation', 'Maintenance', 'Other'];
  for (const cat of categoryOrder) {
    const entries = categories.get(cat);
    if (!entries) continue;
    lines.push(`## ${cat}`);
    for (const entry of entries) lines.push(`- ${entry}`);
    lines.push('');
  }

  const body = lines.join('\n').trim();

  // Preview
  out.add(body);
  out.blank();

  if (dryRun) {
    out.stats(`dry-run: ${items.length} entries, ${categories.size} categories`);
    out.setData('body', body);
    out.setData('items', items);
    out.print();
    return;
  }

  // Create the release
  const releaseArgs = ['release', 'create', tag, '-R', repo, '--title', tag, '--notes', body];
  if (draft) releaseArgs.push('--draft');

  try {
    const url = gh(releaseArgs);
    out.add(`  ✓ Release created: ${url}`);
  } catch (e) {
    out.add(`  ⛔ Release failed: ${e.message}`);
  }

  out.stats(`${items.length} entries from ${prs.length} PRs, ${commits.length} commits`);
  out.setData('body', body);
  out.print();
}

// ── Project Commands ─────────────────────────────────────────────────

async function projectAddBatch(args) {
  const repo = extractArg(args, '--repo') || extractArg(args, '-R');
  const project = parseProject(extractArg(args, '--project'));

  if (!repo || !project) {
    console.error('Error: --repo/-R and --project are required');
    console.error('Usage: tl-gh project add-batch -R owner/repo --project owner/N 452 453 454');
    process.exit(1);
  }

  const issueNums = args.filter(a =>
    !a.startsWith('-') && a !== 'project' && a !== 'add-batch'
    && a !== repo && a !== `${project.owner}/${project.number}`
  ).map(Number).filter(n => n > 0);

  if (!issueNums.length) {
    console.error('Error: Provide issue numbers as positional arguments');
    process.exit(1);
  }

  const out = createOutput(parseCommonArgs(args));
  out.header(`Adding ${issueNums.length} issues to project ${project.owner}/${project.number}`);

  const results = [];
  for (const num of issueNums) {
    try {
      const url = `https://github.com/${repo}/issues/${num}`;
      withRetry(() => addToProject(project.owner, project.number, url));
      results.push({ number: num, status: 'added' });
      out.add(`  #${num} → project ${project.owner}/${project.number}`);
    } catch (e) {
      results.push({ number: num, status: 'failed', error: e.message });
      out.add(`  #${num} FAILED: ${e.message}`);
    }
  }

  const added = results.filter(r => r.status === 'added').length;
  const failed = results.filter(r => r.status === 'failed').length;
  out.stats(`${added} added, ${failed} failed`);
  out.setData('results', results);
  out.print();
}

// ── Main ─────────────────────────────────────────────────────────────

const HELP = `
tl-gh - Token-efficient GitHub CLI wrapper

Wraps multi-step gh workflows into single commands.

Issue Commands:
  issue view            View issue with sub-issues in one call
  issue create-batch    Create multiple issues from JSON/JSONL on stdin
  issue add-sub         Link existing issues as sub-issues
  issue create-tree     Create parent + children with sub-issue links
  issue close-batch     Close multiple issues with optional comment
  issue label-batch     Add/remove labels across multiple issues

Project Commands:
  project add-batch     Add existing issues to a project board in bulk

PR Commands:
  pr digest             Full PR status: CI, reviews, comments, merge readiness
  pr comments           Review comments grouped by file with resolution status
  pr land               Check CI, merge, close linked issues — one command

Release Commands:
  release notes         Auto-changelog from PRs/commits, create GitHub release

Global Options:
  --repo, -R <repo>     Target repository (owner/repo)
  --project <owner/num> Add created issues to a GitHub project board (e.g. edimuj/1)
${COMMON_OPTIONS_HELP}

─── issue view ───

  View an issue with all sub-issues in a single API call.
  Bodies truncated to 5 lines by default — use --full for complete text.

  Options:
    --full                Show complete bodies (no truncation)
    --no-body             Titles and metadata only (most compact)
    --body-lines <n>      Lines of body to show per issue (default: 5)

  Usage:
    tl-gh issue view -R owner/repo 434
    tl-gh issue view -R owner/repo 434 --no-body
    tl-gh issue view -R owner/repo 434 --full
    tl-gh issue view -R owner/repo 434 --body-lines 10

─── issue create-batch ───

  Create issues in bulk from JSON array or JSONL on stdin.

  Input format (JSON array or one object per line):
    {"title": "Bug: ...", "body": "Details", "labels": ["bug","P1"], "assignee": "user"}

  Usage:
    echo '[{"title":"A"},{"title":"B"}]' | tl-gh issue create-batch -R owner/repo
    cat issues.jsonl | tl-gh issue create-batch -R owner/repo --project edimuj/1

─── issue add-sub ───

  Link existing issues as sub-issues of a parent.

  Usage:
    tl-gh issue add-sub -R owner/repo --parent 10 42 43 44 45

─── issue create-tree ───

  Create a parent issue with children, auto-linked as sub-issues.

  Input (JSON on stdin):
    {"title": "Epic", "children": [{"title": "Sub-task 1"}, {"title": "Sub-task 2"}]}

  Usage:
    cat tree.json | tl-gh issue create-tree -R owner/repo --project edimuj/1

─── issue close-batch ───

  Close multiple issues at once with optional comment.

  Usage:
    tl-gh issue close-batch -R owner/repo 1 2 3 -c "Sprint complete"
    tl-gh issue close-batch -R owner/repo 10 11 --reason "not planned"

─── issue label-batch ───

  Add/remove labels across multiple issues at once.

  Usage:
    tl-gh issue label-batch -R owner/repo --add "bug,P0" 1 2 3
    tl-gh issue label-batch -R owner/repo --add "P1" --remove "triage" 5 6 7

─── project add-batch ───

  Add existing issues to a GitHub project board in bulk.

  Usage:
    tl-gh project add-batch -R owner/repo --project edimuj/1 452 453 454
    tl-gh project add-batch -R owner/repo --project edimuj/1 $(seq 450 500)

─── pr digest ───

  Full PR status digest: state, CI checks, review verdicts, unresolved
  comments, merge readiness — all in one call.

  Usage:
    tl-gh pr digest -R owner/repo 123

─── pr comments ───

  Review comments grouped by file, threaded, with resolution status.

  Usage:
    tl-gh pr comments -R owner/repo 123
    tl-gh pr comments -R owner/repo 123 --unresolved

─── pr land ───

  Check CI → merge → close linked issues → delete branch. One command.
  Waits up to 5 minutes for pending CI checks.

  Options:
    --method <merge|squash|rebase>  Merge method (default: squash)
    --no-delete                     Don't delete the branch after merge
    --no-close                      Don't close linked issues
    --dry-run                       Show what would happen without acting

  Usage:
    tl-gh pr land -R owner/repo 123
    tl-gh pr land -R owner/repo 123 --method rebase --dry-run

─── release notes ───

  Auto-generate changelog from PRs/commits since the last tag,
  categorized by conventional commit type. Creates a GitHub release.

  Options:
    --tag <version>     New version tag (required)
    --draft             Create as draft release
    --dry-run           Preview changelog without creating release

  Usage:
    tl-gh release notes -R owner/repo --tag v1.2.0
    tl-gh release notes -R owner/repo --tag v1.2.0 --dry-run
`;

const args = process.argv.slice(2);

if (hasFlag(args, '-h') || hasFlag(args, '--help') || args.length === 0) {
  console.log(HELP.trim());
  process.exit(0);
}

const sub = `${args[0]} ${args[1] || ''}`.trim();

switch (sub) {
  case 'issue view':
    await issueView(args.slice(2));
    break;
  case 'issue create-batch':
    await issueCreateBatch(args.slice(2));
    break;
  case 'issue add-sub':
    await issueAddSub(args.slice(2));
    break;
  case 'issue create-tree':
    await issueCreateTree(args.slice(2));
    break;
  case 'issue close-batch':
    await issueCloseBatch(args.slice(2));
    break;
  case 'issue label-batch':
    await issueLabelBatch(args.slice(2));
    break;
  case 'pr digest':
    await prDigest(args.slice(2));
    break;
  case 'pr comments':
    await prComments(args.slice(2));
    break;
  case 'pr land':
    await prLand(args.slice(2));
    break;
  case 'release notes':
    await releaseNotes(args.slice(2));
    break;
  case 'project add-batch':
    await projectAddBatch(args.slice(2));
    break;
  default:
    console.error(`Unknown command: ${sub}`);
    console.error('Run tl-gh --help for usage');
    process.exit(1);
}
