# Rocket.Chat Code Analyzer

GSoC project — an MCP server that lets Gemini CLI explore the Rocket.Chat codebase without reading full source files.

**Core idea:** use ts-morph to strip function bodies from every `.ts` file, build an in-memory index with PageRank + BM25, and expose 7 MCP tools over stdio. Gemini gets ~4x token savings and all built-in file tools are disabled — it can only navigate via MCP.

## Thoughts

This is a Search Evaluation problem - focusing on retrival and recall.
1. The tools are straightforward now, but the real challenge is getting the LLM to actually follow instructions and invoke them reliably.
2. For the last version, I/O latency was killing me. Gemini would "over-think" while waiting for a response, padding the context and burning through tokens. I fixed this by pre-warming an offline index, allowing for instant in-memory lookups.
3. I also improved tool depth. I moved from a basic grep to a 3-tier fallback strategy to ensure comprehensive coverage without needing external search.
4. Last but not least, the evaluation suite enables me to tracking token burn versus precision gains. 

## Setup

```bash
git clone https://github.com/echo-xiao/gsoc-rocket-chat.git
cd gsoc-rocket-chat
npm install

# Rocket.Chat source goes here
git clone https://github.com/RocketChat/Rocket.Chat.git

npm start
```

First run scans the full codebase and generates skeletons. Subsequent runs are incremental — only changed files are reprocessed (MD5 hash cache).

Add to Gemini CLI MCP config:

```json
{
  "mcpServers": {
    "rocket-ast-analyzer": {
      "command": "npx",
      "args": ["tsx", "/path/to/gsoc-rocket-chat/src/indexer/index.ts"]
    }
  }
}
```

## Tools

| Tool | What it does |
|------|-------------|
| `search_symbol` | Find where a symbol is defined. Tries exact match → prefix → fuzzy+BM25+PageRank, returns top 5 ranked results. |
| `search_mcp_prewarm_cache` | Find files by path fragment against the in-memory file set. |
| `get_file_skeleton` | Return a file's skeleton — types, interfaces, signatures, no bodies. |
| `read_symbol_details` | Return symbol skeleton + up to 5 callee skeletons. Disambiguates same-name symbols via caller's import graph. |
| `find_references` | BFS over the dependency graph, results grouped by depth (max 5 levels). |
| `get_codebase_topology` | Top-K symbols by PageRank score, or list all files that import a given file. |
| `get_system_config` | Index stats, token compression rate, current session call metrics. |

## Session recording & eval

```bash
alias gemini='npx tsx /path/to/gsoc-rocket-chat/src/eval/session-recorder.ts'
```

Wraps Gemini CLI with `script` to record the full terminal session, then auto-generates logs and an eval report after each session.

Output:
- `logs/session-*.txt` — clean extracted conversation
- `logs/session-*.raw.txt` — full ANSI-stripped terminal output
- `logs/eval-*.md` — 3-part eval report (session summary / metrics / turn-by-turn breakdown)

Metrics: SNR, repeat call rate, cost per task, recall@K, ambiguity resolution, shadow variable interference, reference depth.

## Architecture

![architecture](https://github.com/user-attachments/assets/73aec555-72a2-45a4-9c61-6a24825ca3be)


## Project structure

```
src/
  indexer/
    index.ts              MCP server entry: pre-warm → load/build index → serve
    skeleton.ts           AST dehydration — strips bodies, extracts symbol calls
    hasher.ts             MD5 incremental cache
    centrality.ts         PageRank over file dependency graph (graphology)
    state.ts              GLOBAL_INDEX definition + BM25 term index builder
  pipeline/
    retriever.ts          fuzzy+BM25 hybrid search + callee context builder
    reranker.ts           intent-aware reranking (definition vs implementation)
  tools/
    registry.ts           MCP tool definitions + all request handlers
    orchestrator.ts       re-exports registry (avoids circular deps)
  storage/
    local-db.ts           serialize/deserialize GLOBAL_INDEX to output/.global_index.json
  eval/
    session-recorder.ts   record sessions, generate eval reports
    token-analyzer.ts     SNR / repeat call rate / cost per task
    precision-evaluator.ts  recall@K / ambiguity resolution / shadow vars / ref depth
output/                   generated skeletons, mappings, index cache (gitignored)
logs/                     session logs, eval reports (gitignored)
```
