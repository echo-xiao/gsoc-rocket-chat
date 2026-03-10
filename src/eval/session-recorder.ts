#!/usr/bin/env npx tsx
/**
 * Gemini Session Recorder
 * 用 script 录制终端会话，提取干净的对话内容保存到 logs/
 * 会话结束后自动生成三部分评估报告（logs/eval-*.md）
 *
 * alias gemini='npx tsx /Users/echoooooo/Desktop/code/gsoc-rocket-chat/src/eval/session-recorder.ts'
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR   = path.join(__dirname, '..', '..', 'logs');
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const RC_SRC_DIR = path.join(__dirname, '..', '..', 'Rocket.Chat');
fs.mkdirSync(LOGS_DIR, { recursive: true });

// Must be defined before generateReport() is called (const is not hoisted)
const MCP_TOOLS: Record<string, string> = {
  search_symbol:            'fuzzy+BM25 dual search → PageRank weighting → intent rerank',
  search_mcp_prewarm_cache: 'path fuzzy match against allFiles Set',
  get_file_skeleton:        'reads pre-generated .skeleton.ts dehydrated AST',
  read_symbol_details:      'getContext() + callee skeleton concat',
  get_codebase_topology:    'PageRank scores / fileDependents reverse index',
  find_references:          'BFS over fileDependents map (max 5 levels)',
  get_system_config:        'session tracking stats + token compression rate',
};

const BUILTIN_TOOLS: Record<string, string> = {
  Shell:      'executes shell command directly (bypasses MCP)',
  ReadFile:   'reads raw source file contents',
  ReadFolder: 'lists directory contents',
  SearchText: 'regex text search',
  FindFiles:  'file path search',
};

const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
const rawFile    = path.join(LOGS_DIR, `session-${timestamp}.raw`);
const rawTxtFile = path.join(LOGS_DIR, `session-${timestamp}.raw.txt`);
const txtFile    = path.join(LOGS_DIR, `session-${timestamp}.txt`);

console.log(`📹 Recording → ${path.basename(txtFile)}`);

spawnSync('script', ['-q', rawFile, '/opt/homebrew/bin/gemini'], { stdio: 'inherit' });

if (!fs.existsSync(rawFile)) {
  console.error('❌ No recording found.');
  process.exit(1);
}

const { default: stripAnsi } = await import('strip-ansi');

const raw  = fs.readFileSync(rawFile, 'utf-8');
const text = stripAnsi(raw)
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b[()][0-9A-Za-z]/g, '')
  .replace(/\x1b[^[\r\n]/g, '')
  .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '')
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n');

const sessionLog = extractConversation(text);
fs.writeFileSync(rawTxtFile, text, 'utf-8');       // ANSI-stripped, unfiltered
fs.writeFileSync(txtFile, sessionLog, 'utf-8');    // extracted conversation
fs.unlinkSync(rawFile);                            // delete binary script output

// 只保留最新 session 文件（分别保留最新 .raw.txt 和最新 .txt）
for (const f of fs.readdirSync(LOGS_DIR)) {
  const full = path.join(LOGS_DIR, f);
  if (/^session-.*\.raw\.txt$/.test(f) && full !== rawTxtFile) fs.unlinkSync(full);
  if (/^session-(?!.*\.raw\.txt).*\.txt$/.test(f) && full !== txtFile) fs.unlinkSync(full);
}
console.log(`✅ Saved: logs/${path.basename(rawTxtFile)} (raw)`);
console.log(`✅ Saved: logs/${path.basename(txtFile)} (clean)`);

// ── 生成评估报告 ──────────────────────────────────────────────────────────────
console.log('📊 Generating eval report...');
const report = await generateReport(sessionLog);
const evalFile = path.join(LOGS_DIR, `eval-${timestamp}.md`);
fs.writeFileSync(evalFile, report, 'utf-8');

// 只保留最新 eval 报告
for (const f of fs.readdirSync(LOGS_DIR)) {
  if (/^eval-.*\.md$/.test(f) && path.join(LOGS_DIR, f) !== evalFile)
    fs.unlinkSync(path.join(LOGS_DIR, f));
}
console.log(`📋 Report:  logs/${path.basename(evalFile)}`);

// =============================================================================
// 报告生成
// =============================================================================

async function generateReport(log: string): Promise<string> {
  const sections: string[] = [];
  const date = new Date().toLocaleString('en-US');

  sections.push(`# Eval Report — ${date}\n`);
  sections.push(`> Session: \`${path.basename(txtFile)}\`\n`);

  // ── Part 1: Session Summary ─────────────────────────────────────────────────
  sections.push(part1_sessionSummary(log));

  // ── Part 2: Metrics ─────────────────────────────────────────────────────────
  sections.push(await part2_metrics(log));

  // ── Part 3: Operation Analysis ──────────────────────────────────────────────
  sections.push(part3_operationAnalysis(log));

  return sections.join('\n---\n\n');
}

// =============================================================================
// Part 1 · Session Summary
// 原样提取 "Agent powering down" 方框内容
// =============================================================================

function part1_sessionSummary(log: string): string {
  const lines   = log.split('\n');
  const start   = lines.findIndex(l => /^│\s+Agent powering down/.test(l));
  const boxStart = lines.slice(0, start).lastIndexOf(lines.slice(0, start).find(l => l.startsWith('╭─')) ?? '');

  // 找 ╭─ 开头的那一行（从 Agent powering down 往上找）
  let boxFrom = -1;
  for (let i = start; i >= 0; i--) {
    if (lines[i].startsWith('╭─')) { boxFrom = i; break; }
  }
  const boxTo = lines.findIndex((l, i) => i > start && l.startsWith('╰─'));

  const box = boxFrom >= 0 && boxTo >= 0
    ? lines.slice(boxFrom, boxTo + 1).join('\n')
    : '(session summary not found)';

  return `## Part 1 · Session Summary\n\n\`\`\`\n${box}\n\`\`\`\n`;
}

// =============================================================================
// Part 2 · Metrics
// 调用 TokenAnalyzer 和 PrecisionEvaluator
// =============================================================================

async function part2_metrics(log: string): Promise<string> {
  const lines: string[] = ['## Part 2 · Metrics\n'];

  // ── Token Efficiency ────────────────────────────────────────────────────────
  const { TokenAnalyzer } = await import('./token-analyzer.js');
  const ta = new TokenAnalyzer();

  const snr    = ta.evaluateSNR(log, OUTPUT_DIR, RC_SRC_DIR);
  const repeat = ta.evaluateRepeatCallRate(log);
  const cost   = ta.evaluateTaskCost(log, RC_SRC_DIR, OUTPUT_DIR);

  lines.push('### Token Efficiency\n');
  lines.push('#### Signal-to-Noise Ratio\n');
  lines.push(`**Avg SNR**: ${snr.avgSNR}  ${snr.verdict}\n`);
  if (snr.results.length > 0) {
    lines.push('| Query | Tool | Symbol | Skeleton IDs | Used | SNR |');
    lines.push('|-------|------|--------|-------------|------|-----|');
    for (const r of snr.results) {
      lines.push(`| ${r.query} | \`${r.tool}\` | ${r.symbol} | ${r.skeletonIdentifiers} | ${r.referencedInAnswer} | **${r.snr}** |`);
    }
    if (snr.fatSkeletons.length > 0) {
      lines.push(`\n> ⚠️ Fat skeletons (SNR < 30%): ${snr.fatSkeletons.map(f => f.symbol).join(', ')}`);
      lines.push(`> Unused identifiers sample: ${snr.fatSkeletons[0]?.unusedTopK.join(', ')}`);
    }
  } else {
    lines.push('> No skeleton-returning tool calls found in session.\n');
  }

  lines.push('\n#### Repeat Call Rate\n');
  lines.push(`**Repeat Rate**: ${repeat.repeatRate}  ${repeat.verdict}\n`);
  lines.push(`| Metric | Value |\n|--------|-------|\n| Total Calls | ${repeat.totalCalls} |\n| Unique Symbols | ${repeat.uniqueSymbols} |\n| Repeated | ${repeat.repeatedSymbols} |`);
  if (repeat.hotSymbols.length > 0) {
    lines.push('\n**Repeated symbols:**');
    for (const h of repeat.hotSymbols) {
      lines.push(`- \`${h.symbol}\` called ×${h.callCount} via [${h.tools.join(', ')}]`);
      lines.push(`  Queries: ${h.queries.map(q => `"${q.substring(0, 50)}"`).join(' / ')}`);
    }
  }

  lines.push('\n#### Cost per Task\n');
  lines.push(`**Avg Saved**: ${cost.avgSaved}  ${cost.verdict}\n`);
  if (cost.results.length > 0) {
    lines.push('| Query | Files | Full Tokens | Skeleton Tokens | Compression | Saved | ✓ |');
    lines.push('|-------|-------|------------|-----------------|-------------|-------|---|');
    for (const r of cost.results) {
      const mark = r.meetsTarget ? '✅' : '⚠️';
      lines.push(`| ${r.query.substring(0, 50)} | ${r.filesAccessed} | ${r.fullCodeTokens} | ${r.skeletonTokens} | ${r.compressionRatio} | ${r.savedPercent} | ${mark} |`);
    }
  } else {
    lines.push('> No file-accessing tool calls found in session.\n');
  }

  // ── Search Precision ────────────────────────────────────────────────────────
  lines.push('\n### Search Precision\n');

  try {
    const { LocalDatabase } = await import('../storage/local-db.js');
    const loaded = new LocalDatabase().loadIndex();
    if (!loaded) throw new Error('Index not available');

    const { PrecisionEvaluator } = await import('./precision-evaluator.js');
    const pe = new PrecisionEvaluator();

    // Recall@K
    const recall = pe.evaluateRecallFromSession(log);
    lines.push('#### Recall@K\n');
    lines.push(`${recall.verdict}\n`);
    if (recall.total > 0) {
      lines.push(`| Metric | Score |\n|--------|-------|\n| Recall@1 | ${recall.hit1} |\n| Recall@5 | ${recall.hit5} |\n| Recall@10 | ${recall.hit10} |\n| Cases | ${recall.total} |`);
      if (recall.cases.length > 0) {
        lines.push('\n| Query | Expected | Source | Rank | @1 |');
        lines.push('|-------|----------|--------|------|-----|');
        for (const c of recall.cases) {
          lines.push(`| ${c.query} | \`${c.expected}\` | ${c.source} | #${c.rank} | ${c.inTop1 ? '✅' : '❌'} |`);
        }
      }
    }

    // 同名冲突
    const ambig = pe.evaluateAmbiguityFromSession(log);
    lines.push('\n#### Ambiguity Resolution\n');
    lines.push(`${ambig.verdict}\n`);
    if (ambig.allAmbiguousInIndex.length > 0) {
      lines.push(`**Top ambiguous symbols in index:**`);
      for (const a of ambig.allAmbiguousInIndex.slice(0, 5)) {
        lines.push(`- \`${a.symbol}\`: ${a.definitions} definitions (${a.files.join(', ')})`);
      }
    }
    if (ambig.results.length > 0) {
      lines.push('\n| Symbol | Definitions | Expected | Resolved |');
      lines.push('|--------|------------|---------|---------|');
      for (const r of ambig.results) {
        lines.push(`| \`${r.symbol}\` | ${r.totalDefinitions} | ${r.expectedKeyword} | ${r.resolved ? '✅' : '❌'} |`);
      }
    }

    // 阴影变量
    const shadow = pe.evaluateShadowVarsFromSession(log);
    lines.push('\n#### Shadow Variable Interference\n');
    lines.push(`${shadow.verdict}\n`);
    if (shadow.results.length > 0) {
      lines.push('| Query | Top-5 Symbols | Leaked | |');
      lines.push('|-------|--------------|--------|--|');
      for (const r of shadow.results) {
        lines.push(`| ${r.query} | ${r.top5Symbols.join(', ')} | ${r.leakedSymbols.join(', ') || '—'} | ${r.hasLeak ? '⚠️' : '✅'} |`);
      }
    }
    if (shadow.globalSuspiciousSample.length > 0) {
      lines.push(`\n> Global suspicious symbols in index (${shadow.globalSuspiciousCount} total): \`${shadow.globalSuspiciousSample.join('`, `')}\``);
    }

    // 引用路径空洞
    const depth = pe.evaluateReferenceDepthFromSession(log);
    lines.push('\n#### Reference Depth\n');
    lines.push(`${depth.verdict}\n`);
    if (depth.results.length > 0) {
      lines.push('| Target | Depth-1 | Depth-2 | Depth-3 | Growth | |');
      lines.push('|--------|---------|---------|---------|--------|--|');
      for (const r of depth.results) {
        lines.push(`| \`${r.target}\` | ${r.depth1} | ${r.depth2} | ${r.depth3} | ${r.growth} | ${r.hasIndirect ? '✅' : '🔴'} |`);
      }
    }

  } catch (e: any) {
    lines.push(`> ⚠️ Precision evaluation skipped: ${e.message}`);
    lines.push('> Run the indexer first to load the global symbol index.\n');
  }

  return lines.join('\n');
}

// =============================================================================
// Part 3 · Operation Analysis
// 按对话轮次分析每次操作用了哪些工具、走了哪条路径
// =============================================================================

function part3_operationAnalysis(log: string): string {
  const lines  = log.split('\n');
  const turns  = parseTurns(lines);
  const out: string[] = ['## Part 3 · Operation Analysis\n'];

  // MCP vs built-in 汇总
  const mcpCount     = turns.flatMap(t => t.calls).filter(c => c.isMCP).length;
  const builtinCount = turns.flatMap(t => t.calls).filter(c => !c.isMCP).length;
  out.push(`**${turns.length} turns** · **${mcpCount} MCP calls** · **${builtinCount} built-in calls**\n`);

  for (const [idx, turn] of turns.entries()) {
    out.push(`### Turn ${idx + 1}: "${turn.query}"\n`);

    if (turn.calls.length === 0) {
      out.push('- No tool calls (AI responded from context)\n');
    } else {
      for (const call of turn.calls) {
        if (call.isMCP) {
          out.push(`- **[MCP]** \`${call.tool}\``);
          out.push(`  - Args: \`${JSON.stringify(call.args)}\``);
          out.push(`  - How: ${MCP_TOOLS[call.tool] ?? 'MCP tool'}`);
          out.push(`  - Status: ${call.status}`);
        } else {
          out.push(`- **[Built-in]** \`${call.tool}\``);
          out.push(`  - How: ${BUILTIN_TOOLS[call.tool] ?? 'built-in tool'}`);
          if (call.snippet) out.push(`  - \`${call.snippet}\``);
          out.push(`  - Status: ${call.status}`);
        }
      }
    }

    const aiSummary = turn.aiLines.slice(0, 2).join(' ').substring(0, 120);
    if (aiSummary) out.push(`\n> ✦ ${aiSummary}…\n`);
    out.push('');
  }

  // 工具分工总表
  out.push('### Tool Distribution\n');
  out.push('| Type | Tool | Count |');
  out.push('|------|------|-------|');
  const toolCounts = new Map<string, { isMCP: boolean; count: number }>();
  for (const call of turns.flatMap(t => t.calls)) {
    const e = toolCounts.get(call.tool) ?? { isMCP: call.isMCP, count: 0 };
    e.count++;
    toolCounts.set(call.tool, e);
  }
  for (const [tool, { isMCP, count }] of [...toolCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    out.push(`| ${isMCP ? 'MCP' : 'Built-in'} | \`${tool}\` | ${count} |`);
  }

  return out.join('\n');
}

// =============================================================================
// Helpers
// =============================================================================

interface ParsedCall {
  tool:    string;
  args:    Record<string, any>;
  status:  string;
  isMCP:   boolean;
  snippet: string;   // first meaningful line of result (for built-in tools)
}

interface ParsedTurn {
  query:   string;
  calls:   ParsedCall[];
  aiLines: string[];
}

function parseTurns(lines: string[]): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  let inBox    = false;
  let curTool  = '';
  let curArgs: Record<string, any> = {};
  let curStatus = '✓';
  let curIsMCP  = false;
  let boxSnippet = '';

  for (const line of lines) {
    if (/^ > [^/]/.test(line) && !line.includes('Type your message')) {
      if (current) turns.push(current);
      current = { query: line.replace(/^ > /, '').trim(), calls: [], aiLines: [] };
      continue;
    }

    if (line.startsWith('╭─')) {
      inBox = true; curTool = ''; curArgs = {}; curStatus = '✓'; boxSnippet = '';
      continue;
    }

    if (inBox && line.startsWith('╰─')) {
      inBox = false;
      if (current && curTool) {
        current.calls.push({
          tool:    curTool,
          args:    curArgs,
          status:  curStatus,
          isMCP:   curIsMCP,
          snippet: boxSnippet,
        });
      }
      continue;
    }

    if (inBox) {
      // Tool call header line: │ ✓  toolName (server) {...}
      const header = line.match(/^│ ([✓✗])  (\S+)(?: \(([^)]*)\))? ?(\{.*)?/);
      if (header && !curTool) {
        curStatus = header[1];
        curTool   = header[2];
        curIsMCP  = (header[3] ?? '').toLowerCase().includes('mcp');
        try { curArgs = header[4] ? JSON.parse(header[4].replace(/\s+│.*$/, '')) : {}; } catch { curArgs = {}; }
      } else if (!boxSnippet) {
        // First content line as snippet (for built-in tools showing the command)
        const content = line.replace(/^│ ?/, '').trim();
        if (content && !content.startsWith('✓') && !content.startsWith('✗')) {
          boxSnippet = content.substring(0, 100);
        }
      }
      continue;
    }

    if (line.startsWith('✦ ') && current) {
      current.aiLines.push(line.replace(/^✦ /, ''));
    }
  }

  if (current) turns.push(current);
  return turns.filter(t => t.query !== '/quit');
}

// =============================================================================
// Conversation extraction (unchanged)
// =============================================================================

type Segment = { firstPos: number; lines: string[] };

function extractConversation(text: string): string {
  const lines = text.split('\n');
  const segments = new Map<string, Segment>();
  const order: string[] = [];

  function upsert(key: string, pos: number, segLines: string[]) {
    if (!segments.has(key)) {
      segments.set(key, { firstPos: pos, lines: segLines });
      order.push(key);
    } else {
      segments.get(key)!.lines = segLines;
    }
  }

  const CHROME = (l: string) =>
    l.startsWith('─') || l.startsWith('shift+tab') ||
    /^~\//.test(l)    || /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(l) ||
    /^\? for shortcuts/.test(l) || l.startsWith('q4;');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    if (line.startsWith('╭─')) {
      const boxStart  = i;
      const boxLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const bl = lines[i].trimEnd();
        boxLines.push(bl);
        i++;
        if (bl.startsWith('╰─')) break;
      }
      if (boxLines.some(l => /^│ ⊶/.test(l)))                 continue;
      if (boxLines.some(l => /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l))) continue;
      const isGood = boxLines.some(l =>
        /^│ (✓|✗|Action Required)/.test(l) || /^│ \?  /.test(l) ||
        /^│  Agent powering down/.test(l)   || /^│  Interaction Summary/.test(l)
      );
      if (!isGood) continue;
      const keyLine = boxLines.find(l => /^│ \S/.test(l) || /^│  \S/.test(l)) ?? '';
      upsert('box:' + keyLine.replace(/\s+/g, ' ').trim().substring(0, 60), boxStart, boxLines);
      continue;
    }

    if (/^ > \S/.test(line) && !line.includes('Type your message')) {
      upsert('user:' + line.trim(), i, [line]);
      i++; continue;
    }

    if (line.startsWith('✦ ')) {
      const aiStart   = i;
      const aiLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const next = lines[i].trimEnd();
        if (!next) { i++; break; }
        if (next.startsWith('✦ ') || next.startsWith('╭─') || /^ > /.test(next) || CHROME(next)) break;
        aiLines.push(next);
        i++;
      }
      upsert('ai:' + line.substring(0, 80), aiStart, aiLines);
      continue;
    }

    i++;
  }

  const out: string[] = [];
  for (const key of order) out.push(...segments.get(key)!.lines, '');
  return out.join('\n').trimEnd() + '\n';
}
