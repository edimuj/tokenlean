import { execFile } from "node:child_process";

function runTlHook(payload: Record<string, unknown>, timeoutMs = 1200): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("tl-hook", ["run"], {
      timeout: timeoutMs,
      env: {
        ...process.env,
        TOKENLEAN_HOOK_FORMAT: "pi",
        TOKENLEAN_HOOK_LOG: process.env.TOKENLEAN_HOOK_LOG || `${process.env.HOME || ""}/.pi/agent/tokenlean-hooks.jsonl`,
      },
      maxBuffer: 64 * 1024,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve((stdout || "").trim());
    });

    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}

function mapToolName(toolName: string): string {
  if (toolName === "bash") return "Bash";
  if (toolName === "read") return "Read";
  if (toolName === "webfetch") return "WebFetch";
  return toolName;
}

export default function tokenleanHookExtension(pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      const mappedTool = mapToolName(String(event.toolName || ""));
      if (mappedTool !== "Bash" && mappedTool !== "Read" && mappedTool !== "WebFetch") return;

      const payload = {
        cwd: ctx.cwd,
        hook_event_name: "PreToolUse",
        model: "pi",
        permission_mode: "default",
        session_id: `pi-${process.pid}`,
        tool_input: event.input || {},
        tool_name: mappedTool,
        tool_use_id: event.toolCallId || `pi-${Date.now()}`,
        transcript_path: null,
        turn_id: `pi-${Date.now()}`,
      };

      const raw = await runTlHook(payload);
      if (!raw) return;

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      const hook = parsed?.hookSpecificOutput;
      const decision = hook?.permissionDecision;
      const reason = hook?.permissionDecisionReason;

      if (decision === "deny") {
        return { block: true, reason: reason || "Blocked by tokenlean hook" };
      }

      if (ctx.hasUI && typeof reason === "string" && reason.trim()) {
        ctx.ui.notify(reason, "info");
      }
    } catch {
      // Non-blocking: never fail a user request because hook plumbing failed.
    }
  });
}
