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
import { Evaluator } from './evaluator.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR   = path.join(__dirname, '..', '..', 'logs');
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const RC_SRC_DIR = path.join(__dirname, '..', '..', 'Rocket.Chat');
fs.mkdirSync(LOGS_DIR, { recursive: true });

// Must be defined before generateReport() is called (const is not hoisted)
const MCP_TOOLS: Record<string, string> = {
  search:   'symbol index (exact→prefix→fuzzy) + file path substring + call-pattern grep',
  explore:  'skeleton + upstream callers for all exported symbols',
  implement: 'actual source implementation + callee skeletons (filename required)',
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
fs.unlinkSync(rawTxtFile);;

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

  // ── Part 2: Actual vs Expected ───────────────────────────────────────────────
  const { part2, part3 } = await part2_and_part3(log);
  if (part2) sections.push(part2);
  if (part3) sections.push(part3);

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
// Part 2 · Actual vs Expected  +  Part 3 · Details
// =============================================================================

async function part2_and_part3(log: string): Promise<{ part2: string; part3: string }> {
  const ev = new Evaluator();
  const testcasesPath = path.join(__dirname, 'testcases.json');
  const result = ev.evaluateErrorTypes(log, testcasesPath);

  if (result.matchedTurns === 0 && result.errors.length === 0) return { part2: '', part3: '' };

  const sm = result.sessionMetrics;
  const mt = result.matchedTurns;

  // ── Part 2 ─────────────────────────────────────────────────────────────────
  const p2: string[] = ['## Part 2 · Actual vs Expected\n'];
  p2.push('> Automated comparison of each error type against its detection threshold.\n');
  p2.push(`**${result.verdict}**\n`);

  p2.push('| Error Type | Expected | Actual | Status |');
  p2.push('|------------|----------|--------|--------|');

  // Session-level metrics
  const tooMany = sm.totalCalls > sm.threshold;
  p2.push(`| Too many tool calls | ≤ ${sm.threshold} calls | ${sm.totalCalls} calls | ${tooMany ? '❌' : '✅'} |`);

  const rsdPct = (sm.rsdShare * 100).toFixed(1);
  const rsdOver = sm.rsdShare > 0.30;
  const rsdUnder = sm.totalCalls > 0 && sm.rsdShare < 0.05;
  const rsdStatus = (rsdOver || rsdUnder) ? '❌' : '✅';
  const rsdNote = rsdOver ? ' (overuse)' : rsdUnder ? ' (underuse)' : '';
  p2.push(`| implement overuse | 5%–30% share | ${rsdPct}% (${sm.rsdCount}/${sm.totalCalls})${rsdNote} | ${rsdStatus} |`);

  // Per-turn metrics
  const totalSymbols  = result.turnSummaries.reduce((n, ts) => n + ts.symbols.length, 0);
  const foundSymbols  = result.turnSummaries.reduce((n, ts) => n + ts.symbols.filter(s => s.found).length, 0);
  const totalFiles    = result.turnSummaries.reduce((n, ts) => n + ts.files.length, 0);
  const retrievedFiles = result.turnSummaries.reduce((n, ts) => n + ts.files.filter(f => f.retrieved).length, 0);
  p2.push(`| Missing key fact | 100% coverage per turn | ${foundSymbols}/${totalSymbols} symbols found | ${foundSymbols === totalSymbols ? '✅' : '❌'} |`);
  p2.push(`| Wrong file retrieved | ≥ 95% hit rate per turn | ${retrievedFiles}/${totalFiles} files retrieved | ${retrievedFiles === totalFiles ? '✅' : '❌'} |`);

  // ── Part 3 ─────────────────────────────────────────────────────────────────
  const p3: string[] = ['## Part 3 · Details\n'];

  if (result.turnSummaries.length > 0) {
    for (const ts of result.turnSummaries) {
      p3.push(`### Q: \`${ts.question.substring(0, 80)}\`\n`);

      // ── Files ─────────────────────────────────────────────────────────────
      if (ts.files.length > 0) {
        p3.push('**Files**\n');
        p3.push('| # | File | Expected | Actual |');
        p3.push('|---|------|----------|--------|');
        ts.files.forEach((f, i) => {
          const retrievedLabel = f.retrieved ? `✅ Retrieved${f.source ? ` (${f.source})` : ''}` : '❌ Not found';
          p3.push(`| ${i + 1} | \`${f.path}\` | ✅ Required | ${retrievedLabel} |`);
        });
        p3.push('');
      }

      // ── Retrieval Order ───────────────────────────────────────────────────
      if (ts.path.length > 0) {
        p3.push('**Retrieval Order**\n');

        const expectedOrder = [...ts.path].sort((a, b) => a.expectedPos - b.expectedPos);
        const actualOrder = [
          ...ts.path.filter(p => p.actualPos !== null).sort((a, b) => a.actualPos! - b.actualPos!),
          ...ts.path.filter(p => p.actualPos === null),
        ];
        const maxLen = Math.max(expectedOrder.length, actualOrder.length);

        p3.push('| Expected Order | Actual Order |');
        p3.push('|----------------|--------------|');
        for (let i = 0; i < maxLen; i++) {
          const exp = expectedOrder[i];
          const act = actualOrder[i];
          const expCell = exp ? `\`${exp.file}\` _(${exp.symbol})_` : '';
          const actCell = act ? `\`${act.file}\` _(${act.symbol})_` : '';
          p3.push(`| ${expCell} | ${actCell} |`);
          if (i < maxLen - 1) p3.push('| ↓ | ↓ |');
        }
        p3.push('');
      }

      // ── Key Symbols ───────────────────────────────────────────────────────
      if (ts.symbols.length > 0) {
        p3.push('**Key Symbols**\n');
        p3.push('| Symbol | Expected | Actual |');
        p3.push('|--------|----------|--------|');
        for (const s of ts.symbols) {
          p3.push(`| \`${s.name}\` | ✅ Required | ${s.found ? '✅ Found' : '❌ Missing'} |`);
        }
        p3.push('');
      }
    }
  }

  // ── Correction hints ──────────────────────────────────────────────────────
  if (result.errors.length > 0) {
    p3.push('### Corrections\n');
    for (const e of result.errors) {
      p3.push(`**${e.verdict} ${e.type}** — \`${e.turn}\``);
      p3.push(`- ${e.detail}`);
      p3.push(`- 💡 ${e.correction}`);
      p3.push('');
    }
  }

  return { part2: p2.join('\n'), part3: p3.join('\n') };
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
      upsert('box:' + keyLine.replace(/\s+/g, ' ').trim().substring(0, 160), boxStart, boxLines);
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
