import { CodeRetriever } from '../pipeline/retriever.js';
import { GLOBAL_INDEX } from '../indexer/state.js';

/**
 * 精度评估 — 全部从 session log 动态提取测试用例，不依赖预设样例。
 *
 * 四项指标：
 *   1. Recall@K          — 从 search_symbol 调用提取查询，重跑搜索验证召回率
 *   2. 同名冲突解析率     — 找出 session 中被查询的多定义符号，验证 import 图歧义解析
 *   3. 阴影变量干扰       — 对 session 中所有搜索结果检查可疑的局部变量模式
 *   4. 引用路径空洞       — 对 session 中 find_references 的实际 target 验证 BFS 深度
 */
export class PrecisionEvaluator {

    // =========================================================================
    // Session log 解析
    // =========================================================================

    private parseSession(sessionLog: string): ParsedSession {
        const lines = sessionLog.split('\n');
        const turns: Turn[] = [];
        let current: Turn | null = null;
        let inBox = false;
        let currentTool = '';
        let currentArgs: Record<string, any> = {};
        let currentStatus: '✓' | '✗' = '✓';
        let boxContent: string[] = [];

        for (const line of lines) {
            if (/^ > [^/]/.test(line) && !line.includes('Type your message')) {
                if (current) turns.push(current);
                current = { query: line.replace(/^ > /, '').trim(), toolCalls: [], aiLines: [] };
                continue;
            }
            if (line.startsWith('╭─')) { inBox = true; boxContent = []; continue; }
            if (inBox && line.startsWith('╰─')) {
                inBox = false;
                if (current && currentTool) {
                    current.toolCalls.push({
                        tool: currentTool, args: currentArgs,
                        status: currentStatus, resultText: boxContent.join('\n'),
                    });
                }
                currentTool = ''; currentArgs = {};
                continue;
            }
            if (inBox) {
                const h = line.match(/^│ ([✓✗])  (\S+) \([^)]+\) (\{.+?)(?:\s{3,}│)?\s*$/);
                if (h) {
                    currentStatus = h[1] as '✓' | '✗';
                    currentTool   = h[2];
                    try { currentArgs = JSON.parse(h[3]); } catch { currentArgs = {}; }
                }
                boxContent.push(line.replace(/^│ ?/, '').trimEnd());
                continue;
            }
            if (line.startsWith('✦ ') && current) {
                current.aiLines.push(line.replace(/^✦ /, ''));
            }
        }
        if (current) turns.push(current);
        return { turns };
    }

    // =========================================================================
    // 1. Recall@K — 从 session 的 search_symbol 调用提取查询，重跑后验证
    //
    // 测试用例自动生成逻辑：
    //   - 找出所有 search_symbol 调用（args.query）
    //   - 如果 query 字符串本身在 GLOBAL_INDEX 中存在 → expected = query
    //   - 否则从该轮的 AI 回复中提取第一个出现在索引里的符号名作为 expected
    //   - 两者均无法确定 → 跳过（无法构造 ground truth）
    // =========================================================================

    evaluateRecallFromSession(sessionLog: string): RecallSummary {
        const { turns } = this.parseSession(sessionLog);
        const cases: Array<{ query: string; expected: string; source: string }> = [];

        for (const turn of turns) {
            for (const call of turn.toolCalls) {
                if (call.tool !== 'search_symbol' || call.status !== '✓') continue;
                const query = call.args.query as string;
                if (!query) continue;

                // 策略1：query 本身是符号名
                if (GLOBAL_INDEX.symbols.has(query)) {
                    cases.push({ query, expected: query, source: 'exact-name' });
                    continue;
                }

                // 策略2：从 AI 回复里找第一个索引中存在的符号
                const aiText  = turn.aiLines.join(' ');
                const allSyms = [...GLOBAL_INDEX.symbols.keys()];
                const found   = allSyms.find(sym => sym.length > 4 && aiText.includes(sym));
                if (found) {
                    cases.push({ query, expected: found, source: 'ai-response' });
                }
            }
        }

        if (cases.length === 0) {
            return { cases: [], hit1: 'N/A', hit5: 'N/A', hit10: 'N/A', total: 0, verdict: '⚠️  No search_symbol calls found in session' };
        }

        let h1 = 0, h5 = 0, h10 = 0;
        const evaluated: RecallCase[] = [];

        for (const { query, expected, source } of cases) {
            const results = CodeRetriever.search(query, 10);
            const rank    = results.findIndex(r => r.symbolName === expected);
            const inTop1  = rank === 0;
            const inTop5  = rank >= 0 && rank < 5;
            const inTop10 = rank >= 0 && rank < 10;
            if (inTop1)  h1++;
            if (inTop5)  h5++;
            if (inTop10) h10++;
            evaluated.push({ query, expected, source, rank: rank === -1 ? '>10' : String(rank + 1), inTop1, inTop5, inTop10 });
        }

        const n = cases.length;
        return {
            cases: evaluated,
            total: n,
            hit1:  `${(h1  / n * 100).toFixed(1)}%`,
            hit5:  `${(h5  / n * 100).toFixed(1)}%`,
            hit10: `${(h10 / n * 100).toFixed(1)}%`,
            verdict: h1 / n >= 0.7
                ? `✅ Recall@1 = ${(h1 / n * 100).toFixed(1)}% (≥ 70%)`
                : `⚠️  Recall@1 = ${(h1 / n * 100).toFixed(1)}% — fuzzy/BM25 ranking needs tuning`,
        };
    }

    // =========================================================================
    // 2. 同名冲突解析率 — 找出 session 中被查询且在索引有多定义的符号
    //
    // 测试用例自动生成逻辑：
    //   - 收集 session 中所有工具调用涉及的符号名
    //   - 筛选出在 GLOBAL_INDEX.symbols 中有 ≥2 个文件定义的符号
    //   - 用该轮 AI 回复中出现的文件路径作为"期望文件"
    //   - 调用 CodeRetriever.getContext(symbol, callerHint) 验证首位结果
    // =========================================================================

    evaluateAmbiguityFromSession(sessionLog: string): AmbiguitySummary {
        const { turns } = this.parseSession(sessionLog);
        const results: AmbiguityResult[] = [];

        // 找出索引中有多定义的符号（供统计参考）
        const allAmbiguous = [...GLOBAL_INDEX.symbols.entries()]
            .filter(([, p]) => p.size >= 2)
            .sort((a, b) => b[1].size - a[1].size)
            .slice(0, 10)
            .map(([sym, p]) => ({ symbol: sym, definitions: p.size, files: [...p].map(f => f.split('/').pop()!) }));

        for (const turn of turns) {
            const aiText = turn.aiLines.join(' ');

            for (const call of turn.toolCalls) {
                if (call.status !== '✓') continue;
                const sym = call.args.symbolName ?? call.args.query ?? '';
                if (!sym) continue;

                const paths = GLOBAL_INDEX.symbols.get(sym);
                if (!paths || paths.size < 2) continue;  // 只测多定义符号

                // 从 AI 回复中提取文件路径关键词作为期望
                const mentionedFile = [...paths].find(p =>
                    aiText.includes(p.split('/').pop()?.replace('.ts', '') ?? '__never__')
                );
                if (!mentionedFile) continue;  // 无法从 AI 回复确定期望文件

                const contexts = CodeRetriever.getContext(sym);
                const firstCtx = contexts[0] ?? '';
                const expectedKeyword = mentionedFile.split('/').pop()!.replace('.ts', '');
                const resolved = firstCtx.toLowerCase().includes(expectedKeyword.toLowerCase());

                results.push({
                    symbol:           sym,
                    totalDefinitions: paths.size,
                    expectedKeyword,
                    resolved,
                    verdict: resolved
                        ? `✅ correctly prioritised ${expectedKeyword}`
                        : `❌ wrong file returned — expected ${expectedKeyword}`,
                });
            }
        }

        const resolvedCount = results.filter(r => r.resolved).length;
        const rate = results.length ? `${(resolvedCount / results.length * 100).toFixed(1)}%` : 'N/A';

        return {
            results,
            resolvedRate: rate,
            allAmbiguousInIndex: allAmbiguous,
            verdict: results.length === 0
                ? '⚠️  No ambiguous symbols queried in this session'
                : resolvedCount === results.length
                    ? `✅ 100% ambiguity resolved (${resolvedCount}/${results.length})`
                    : `⚠️  ${resolvedCount}/${results.length} resolved — import-graph disambiguation needs improvement`,
        };
    }

    // =========================================================================
    // 3. 阴影变量干扰 — 对 session 中所有搜索结果检查可疑的局部变量泄漏
    //
    // 逻辑：
    //   - 重跑 session 中所有 search_symbol 查询
    //   - 对返回的每个符号，判断是否符合"局部变量"特征：
    //       · 单字母 / 两字母
    //       · 常见临时变量名（result, error, data, item, tmp …）
    //       · 以下划线开头的私有变量（_xxx）
    //   - 如果这类符号出现在 Top-5，说明 AST 未过滤函数作用域变量
    // =========================================================================

    evaluateShadowVarsFromSession(sessionLog: string): ShadowVarSummary {
        const { turns } = this.parseSession(sessionLog);
        const SUSPICIOUS = /^([a-zA-Z]{1,2}|result|error|data|item|tmp|temp|val|res|req|err|cb|fn|_[a-z].*)$/;
        const results: ShadowVarResult[] = [];

        for (const turn of turns) {
            for (const call of turn.toolCalls) {
                if (call.tool !== 'search_symbol' || call.status !== '✓') continue;
                const query = call.args.query as string;
                if (!query) continue;

                const searchResults = CodeRetriever.search(query, 10);
                const top5          = searchResults.slice(0, 5);
                const leaked        = top5.filter(r => SUSPICIOUS.test(r.symbolName));

                results.push({
                    query,
                    top5Symbols:  top5.map(r => r.symbolName),
                    leakedSymbols: leaked.map(r => r.symbolName),
                    hasLeak:       leaked.length > 0,
                    verdict: leaked.length === 0
                        ? '✅ clean'
                        : `❌ ${leaked.length} suspicious symbol(s) in Top-5: ${leaked.map(r => r.symbolName).join(', ')}`,
                });
            }
        }

        // 全局扫描：索引中有多少可疑符号
        const GLOBAL_SUSPICIOUS = [...GLOBAL_INDEX.symbols.keys()]
            .filter(sym => SUSPICIOUS.test(sym));

        const leakCount = results.filter(r => r.hasLeak).length;
        return {
            results,
            globalSuspiciousCount: GLOBAL_SUSPICIOUS.length,
            globalSuspiciousSample: GLOBAL_SUSPICIOUS.slice(0, 15),
            verdict: leakCount === 0 && GLOBAL_SUSPICIOUS.length === 0
                ? '✅ No shadow variable leakage detected'
                : `⚠️  ${leakCount} query result(s) contain suspicious symbols; ${GLOBAL_SUSPICIOUS.length} total in index`,
        };
    }

    // =========================================================================
    // 4. 引用路径空洞 — 对 session 中 find_references 的实际 target 验证 BFS 深度
    //
    // 逻辑：
    //   - 从 session 中提取所有 find_references 调用的 target
    //   - 分别计算 depth-1 / depth-2 / depth-3 的引用文件数
    //   - 如果 depth-2 == depth-1，说明 BFS 未能追踪间接依赖（存在空洞）
    //   - 报告 depth-2 相对 depth-1 的覆盖增长率
    // =========================================================================

    evaluateReferenceDepthFromSession(sessionLog: string): ReferenceDepthSummary {
        const { turns } = this.parseSession(sessionLog);
        const targets   = new Set<string>();

        for (const turn of turns) {
            for (const call of turn.toolCalls) {
                if (call.tool === 'find_references' && call.status === '✓' && call.args.target) {
                    targets.add(call.args.target as string);
                }
            }
        }

        if (targets.size === 0) {
            return {
                results: [],
                hasHoles: false,
                verdict: '⚠️  No find_references calls found in session',
            };
        }

        const results: ReferenceDepthResult[] = [];

        for (const target of targets) {
            const startFiles = this.resolveTarget(target);
            if (startFiles.length === 0) {
                results.push({ target, depth1: 0, depth2: 0, depth3: 0, hasIndirect: false, growth: 'N/A', verdict: '⚠️  target not found' });
                continue;
            }

            const d1 = this.bfs(startFiles, 1);
            const d2 = this.bfs(startFiles, 2);
            const d3 = this.bfs(startFiles, 3);
            for (const f of startFiles) { d1.delete(f); d2.delete(f); d3.delete(f); }

            const growth = d1.size > 0
                ? `+${((d2.size - d1.size) / d1.size * 100).toFixed(0)}%`
                : 'N/A';

            results.push({
                target,
                depth1:      d1.size,
                depth2:      d2.size,
                depth3:      d3.size,
                hasIndirect: d2.size > d1.size,
                growth,
                verdict: d2.size > d1.size
                    ? `✅ depth-2 found ${d2.size - d1.size} more files (${growth})`
                    : d1.size === 0
                        ? '⚠️  no direct references'
                        : '🔴 depth-2 == depth-1 — indirect dependencies not traced',
            });
        }

        const holes = results.filter(r => !r.hasIndirect && r.depth1 > 0);
        return {
            results,
            hasHoles: holes.length > 0,
            verdict:  holes.length === 0
                ? '✅ find_references correctly traces indirect dependencies'
                : `🔴 ${holes.length} target(s) show no depth-2 growth — BFS topology may be incomplete`,
        };
    }

    // =========================================================================
    // PageRank 对比（保留原有功能，但接受从 session 提取的 cases）
    // =========================================================================

    comparePageRankImpact(testCases: Array<{ query: string; expected: string }>) {
        let improved = 0, same = 0, worse = 0;
        for (const { query, expected } of testCases) {
            const withPR    = CodeRetriever.search(query, 20);
            const withoutPR = withPR
                .map(r => ({ ...r, finalScore: r.score }))
                .sort((a: any, b: any) => b.finalScore - a.finalScore);
            const rankWith    = withPR.findIndex(r => r.symbolName === expected);
            const rankWithout = withoutPR.findIndex((r: any) => r.symbolName === expected);
            if (rankWith < rankWithout)       improved++;
            else if (rankWith === rankWithout) same++;
            else                               worse++;
        }
        return { improved, same, worse, total: testCases.length };
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private resolveTarget(target: string): string[] {
        const bySymbol = GLOBAL_INDEX.symbols.get(target);
        if (bySymbol && bySymbol.size > 0) return [...bySymbol];
        if (GLOBAL_INDEX.allFiles.has(target)) return [target];
        const q = target.toLowerCase();
        return [...GLOBAL_INDEX.allFiles].filter(f => f.toLowerCase().includes(q)).slice(0, 5);
    }

    private bfs(startFiles: string[], maxDepth: number): Set<string> {
        const visited = new Set<string>(startFiles);
        const queue: [string, number][] = startFiles.map(f => [f, 0]);
        while (queue.length > 0) {
            const [cur, d] = queue.shift()!;
            if (d >= maxDepth) continue;
            for (const dep of GLOBAL_INDEX.fileDependents.get(cur) ?? []) {
                if (!visited.has(dep)) { visited.add(dep); queue.push([dep, d + 1]); }
            }
        }
        return visited;
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolCall {
    tool:       string;
    args:       Record<string, any>;
    status:     '✓' | '✗';
    resultText: string;
}

interface Turn {
    query:     string;
    toolCalls: ToolCall[];
    aiLines:   string[];
}

interface ParsedSession {
    turns: Turn[];
}

export interface RecallCase {
    query:    string;
    expected: string;
    source:   string;
    rank:     string;
    inTop1:   boolean;
    inTop5:   boolean;
    inTop10:  boolean;
}

export interface RecallSummary {
    cases:   RecallCase[];
    total:   number;
    hit1:    string;
    hit5:    string;
    hit10:   string;
    verdict: string;
}

export interface AmbiguityResult {
    symbol:           string;
    totalDefinitions: number;
    expectedKeyword:  string;
    resolved:         boolean;
    verdict:          string;
}

export interface AmbiguitySummary {
    results:             AmbiguityResult[];
    resolvedRate:        string;
    allAmbiguousInIndex: Array<{ symbol: string; definitions: number; files: string[] }>;
    verdict:             string;
}

export interface ShadowVarResult {
    query:         string;
    top5Symbols:   string[];
    leakedSymbols: string[];
    hasLeak:       boolean;
    verdict:       string;
}

export interface ShadowVarSummary {
    results:                ShadowVarResult[];
    globalSuspiciousCount:  number;
    globalSuspiciousSample: string[];
    verdict:                string;
}

export interface ReferenceDepthResult {
    target:      string;
    depth1:      number;
    depth2:      number;
    depth3:      number;
    hasIndirect: boolean;
    growth:      string;
    verdict:     string;
}

export interface ReferenceDepthSummary {
    results:  ReferenceDepthResult[];
    hasHoles: boolean;
    verdict:  string;
}
