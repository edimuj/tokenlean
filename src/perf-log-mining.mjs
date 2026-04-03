import { resolve } from 'node:path';

export function parseJsonSafe(line) {
  if (typeof line !== 'string' || line.trim() === '') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function parseToolArguments(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  if (typeof argumentsValue !== 'string') return {};
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return {};
  }
}

export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isWithinSinceDays(timestampValue, sinceDays, nowMs = Date.now()) {
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) return true;
  const timestampMs = toEpochMs(timestampValue);
  if (timestampMs === null) return false;
  const cutoffMs = nowMs - sinceDays * 24 * 60 * 60 * 1000;
  return timestampMs >= cutoffMs;
}

export function isSameOrWithinPath(childPath, parentPath) {
  if (!childPath || !parentPath) return false;

  const child = resolve(childPath);
  const parent = resolve(parentPath);

  if (child === parent) return true;
  return child.startsWith(`${parent}/`);
}

export function normalizeClaudeProjectPath(projectPath) {
  return projectPath.replaceAll('/', '-').replace(/^[-]+/, '');
}

export function extractTlTool(command) {
  if (typeof command !== 'string' || command.trim() === '') return null;

  const directMatch = command.match(/(?:^|[;&]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(tl-[a-z0-9-]+)(?=\s|$)/i);
  if (directMatch) return directMatch[1].toLowerCase();

  const nodeBinMatch = command.match(/(?:^|[;&]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*node\s+bin\/(tl-[a-z0-9-]+)\.mjs(?=\s|$)/i);
  if (nodeBinMatch) return nodeBinMatch[1].toLowerCase();

  return null;
}

export function compactCommand(command) {
  if (typeof command !== 'string') return '';
  const firstLine = command.split('\n')[0] || '';
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function extractCodexShellCommands(record) {
  const commands = [];
  if (!record || record.type !== 'response_item') return commands;

  const payload = record.payload || {};
  if (payload.type !== 'function_call') return commands;

  const args = parseToolArguments(payload.arguments);

  if (payload.name === 'exec_command') {
    if (typeof args.cmd === 'string' && args.cmd.trim()) {
      commands.push(args.cmd);
    }
    return commands;
  }

  if (payload.name === 'multi_tool_use.parallel') {
    const toolUses = Array.isArray(args.tool_uses) ? args.tool_uses : [];
    toolUses.forEach((toolUse) => {
      const recipient = toolUse?.recipient_name;
      const nestedArgs = toolUse?.parameters;
      if (recipient === 'functions.exec_command' && typeof nestedArgs?.cmd === 'string' && nestedArgs.cmd.trim()) {
        commands.push(nestedArgs.cmd);
      }
    });
  }

  return commands;
}

export function extractClaudeShellCommands(record) {
  const commands = [];
  const content = record?.message?.content;
  if (!Array.isArray(content)) return commands;

  content.forEach((block) => {
    if (block?.type !== 'tool_use' || block?.name !== 'Bash') return;
    const command = block?.input?.command;
    if (typeof command === 'string' && command.trim()) {
      commands.push(command);
    }
  });

  return commands;
}
