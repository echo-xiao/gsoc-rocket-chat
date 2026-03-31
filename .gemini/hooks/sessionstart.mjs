process.stdout.write(JSON.stringify({
  context: `Answer questions about the Rocket.Chat codebase using MCP tools only.

Tool order:
1. search  — find entry symbol or file
2. graph   — traverse call chain (direction='down' for execution flow, direction='up' for callers)
3. implement — read full source of a specific symbol (filename REQUIRED)

Shell / ReadFile / ReadFolder / FindFiles are disabled.`
}));
