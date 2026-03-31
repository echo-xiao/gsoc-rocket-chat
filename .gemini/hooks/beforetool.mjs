import { createInterface } from "readline";

const BLOCKED_TOOLS = new Set([
  "glob",
  "grep_search",
  "search_file_content",
  "run_shell_command",
  "google_web_search",
  "web_fetch",
  "read_file",
  "read_many_files",
  "list_directory",
  "list_directory_tree",
  "read_folder",
  "write_file",
  "replace",
  "edit_file",
  "create_file",
  "ask_user",
  "write_todos",
  "codebase_investigator",
]);

const lines = [];
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => lines.push(line));
rl.on("close", () => {
  try {
    const input = JSON.parse(lines.join("\n"));
    if (BLOCKED_TOOLS.has(input.tool_name)) {
      process.stdout.write(JSON.stringify({
        decision: "deny",
        reason: `Built-in tool '${input.tool_name}' is disabled. Use MCP tools instead.`,
      }));
      process.exit(0);
    }
  } catch {}
  process.stdout.write("{}");
});
