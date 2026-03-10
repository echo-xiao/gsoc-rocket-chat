import * as fs from 'fs';
import * as path from 'path';

/**
 * Token 压缩率分析：对比原始源码 vs skeleton 的 token 数量
 * 使用字符估算（4 chars ≈ 1 token）避免外部依赖
 */
export class TokenAnalyzer {
    private estTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    analyze(rawCode: string, skeletonCode: string) {
        const rawTokens      = this.estTokens(rawCode);
        const skeletonTokens = this.estTokens(skeletonCode);
        const ratio          = rawTokens / skeletonTokens;
        return {
            rawTokens,
            skeletonTokens,
            compressionRatio: `${ratio.toFixed(2)}x`,
            savedTokens:      rawTokens - skeletonTokens,
            savedPercent:     `${((1 - skeletonTokens / rawTokens) * 100).toFixed(1)}%`,
        };
    }

    analyzeBatch(pairs: Array<{ raw: string; skeleton: string }>) {
        const results  = pairs.map(p => this.analyze(p.raw, p.skeleton));
        const avgRatio = results.reduce((s, r) => s + parseFloat(r.compressionRatio), 0) / results.length;
        return { results, avgCompressionRatio: `${avgRatio.toFixed(2)}x` };
    }

    // =========================================================================
    // Session log 解析（三个评估方法共享）
    // =========================================================================

    parseSession(sessionLog: string): ParsedSession {
        const lines = sessionLog.split('\n');
        const turns: Turn[] = [];
        let current: Turn | null = null;
        let inBox = false;
        let boxLines: string[] = [];
        let currentBoxTool = '';
        let currentBoxArgs: Record<string, any> = {};
        let currentBoxStatus: '✓' | '✗' = '✓';

        for (const line of lines) {
            // User message → new turn
            if (/^ > [^/]/.test(line) && !line.includes('Type your message')) {
                if (current) turns.push(current);
                current = { query: line.replace(/^ > /, '').trim(), toolCalls: [], aiLines: [] };
                continue;
            }

            // Box start
            if (line.startsWith('╭─')) { inBox = true; boxLines = []; continue; }

            // Box end
            if (inBox && line.startsWith('╰─')) {
                inBox = false;
                if (current && currentBoxTool) {
                    current.toolCalls.push({
                        tool:   currentBoxTool,
                        args:   currentBoxArgs,
                        status: currentBoxStatus,
                        resultLines: boxLines.filter(l => /^│ /.test(l)).map(l => l.replace(/^│ /, '').trimEnd()),
                    });
                }
                currentBoxTool = '';
                currentBoxArgs = {};
                continue;
            }

            // Inside box — parse tool call header
            if (inBox) {
                const header = line.match(/^│ ([✓✗])  (\S+) \([^)]+\) (\{.+?)(?:\s{3,}│)?\s*$/);
                if (header) {
                    currentBoxStatus = header[1] as '✓' | '✗';
                    currentBoxTool   = header[2];
                    try { currentBoxArgs = JSON.parse(header[3]); } catch { currentBoxArgs = {}; }
                }
                boxLines.push(line.replace(/^│ ?/, '').trimEnd());
                continue;
            }

            // AI response
            if (line.startsWith('✦ ') && current) {
                current.aiLines.push(line.replace(/^✦ /, ''));
            }
        }
        if (current) turns.push(current);

        return {
            turns,
            allToolCalls: turns.flatMap(t => t.toolCalls),
            allAIText:    turns.map(t => t.aiLines.join(' ')).join(' '),
        };
    }

    // =========================================================================
    // 1. 信噪比评估 (Signal-to-Noise Ratio)
    //    从 session log 找出每次工具调用返回的 skeleton，
    //    计算 AI 后续回复中实际引用了多少比例的标识符
    // =========================================================================

    evaluateSNR(sessionLog: string, outputDir: string, rcSrcDir: string): SNRSummary {
        const session = this.parseSession(sessionLog);
        const results: SNRResult[] = [];

        for (const turn of session.turns) {
            const aiText = turn.aiLines.join(' ');

            for (const call of turn.toolCalls) {
                if (call.status !== '✓') continue;
                const symbolOrFile =
                    call.args.symbolName ?? call.args.filename ?? call.args.query ?? call.args.target ?? '';
                if (!symbolOrFile) continue;

                const skPath = this.resolveSkeletonPath(symbolOrFile, outputDir, rcSrcDir);
                if (!skPath || !fs.existsSync(skPath)) continue;

                const skeleton = fs.readFileSync(skPath, 'utf-8');
                const ids      = this.extractIdentifiers(skeleton);
                if (ids.length === 0) continue;

                const referenced = ids.filter(id => aiText.includes(id));
                const unused     = ids.filter(id => !aiText.includes(id));

                results.push({
                    query:               turn.query.substring(0, 60),
                    tool:                call.tool,
                    symbol:              symbolOrFile,
                    skeletonIdentifiers: ids.length,
                    referencedInAnswer:  referenced.length,
                    snr:                 `${(referenced.length / ids.length * 100).toFixed(1)}%`,
                    unusedTopK:          unused.slice(0, 8),
                });
            }
        }

        const valid  = results.filter(r => parseFloat(r.snr) > 0 || r.skeletonIdentifiers > 0);
        const avgSNR = valid.length
            ? `${(valid.reduce((s, r) => s + parseFloat(r.snr), 0) / valid.length).toFixed(1)}%`
            : 'N/A';
        const fat = valid.filter(r => parseFloat(r.snr) < 30);

        return {
            results,
            avgSNR,
            fatSkeletons: fat,
            verdict: fat.length === 0
                ? '✅ All skeletons SNR ≥ 30%'
                : `🔴 ${fat.length} skeleton(s) with SNR < 30% — consider trimming unused imports/types`,
        };
    }

    // =========================================================================
    // 2. 重复调用率评估 (Repeat Call Rate)
    //    从 session log 统计同一 symbol/file 被反复请求的次数
    // =========================================================================

    evaluateRepeatCallRate(sessionLog: string): RepeatCallSummary {
        const session = this.parseSession(sessionLog);
        const hits    = new Map<string, { count: number; tools: Set<string>; queries: string[] }>();

        for (const turn of session.turns) {
            for (const call of turn.toolCalls) {
                const key =
                    call.args.symbolName ?? call.args.filename ?? call.args.query ?? call.args.target ?? '';
                if (!key) continue;
                if (!hits.has(key)) hits.set(key, { count: 0, tools: new Set(), queries: [] });
                const entry = hits.get(key)!;
                entry.count++;
                entry.tools.add(call.tool);
                if (!entry.queries.includes(turn.query)) entry.queries.push(turn.query);
            }
        }

        const all      = [...hits.entries()].map(([symbol, { count, tools, queries }]) => ({
            symbol, callCount: count, tools: [...tools], queries, isRepeat: count > 1,
        }));
        const repeated   = all.filter(r => r.isRepeat);
        const repeatRate = all.length
            ? `${(repeated.length / all.length * 100).toFixed(1)}%`
            : 'N/A';

        return {
            totalCalls:      all.reduce((s, r) => s + r.callCount, 0),
            uniqueSymbols:   all.length,
            repeatedSymbols: repeated.length,
            repeatRate,
            hotSymbols:      repeated.sort((a, b) => b.callCount - a.callCount),
            verdict: repeated.length === 0
                ? '✅ No repeated calls — skeleton context is sufficient'
                : repeated.length <= 2
                    ? `⚠️  ${repeated.length} symbol(s) called multiple times — minor skeleton gaps`
                    : `🔴 ${repeated.length} symbol(s) repeated — skeleton missing critical info`,
        };
    }

    // =========================================================================
    // 3. 任务达成成本评估 (Cost per Task)
    //    从 session log 按对话轮次分组，统计每轮实际访问的文件，
    //    对比 skeleton tokens vs 全量源码 tokens，目标节省 ≥ 70%
    // =========================================================================

    evaluateTaskCost(sessionLog: string, rcSrcDir: string, outputDir: string): TaskCostSummary {
        const session = this.parseSession(sessionLog);
        const results: TaskCostResult[] = [];

        for (const turn of session.turns) {
            const accessedFiles = new Set<string>();

            for (const call of turn.toolCalls) {
                if (call.status !== '✓') continue;
                const fileArg = call.args.filename ?? call.args.target ?? '';

                // 从工具参数或返回内容中提取文件路径
                if (fileArg && (fileArg.includes('/') || fileArg.endsWith('.ts'))) {
                    accessedFiles.add(fileArg);
                }
                // 从工具返回内容中提取文件路径（search_mcp_prewarm_cache 等返回路径列表）
                for (const resultLine of call.resultLines) {
                    const pathMatch = resultLine.match(/\/[\w/.-]+\.ts\b/g);
                    if (pathMatch) pathMatch.forEach(p => accessedFiles.add(p));
                }
            }

            if (accessedFiles.size === 0) continue;

            let fullTokens = 0, skelTokens = 0;
            const fileDetails: Array<{ file: string; raw: number; skeleton: number }> = [];

            for (const absPath of accessedFiles) {
                const rel      = absPath.includes('Rocket.Chat/')
                    ? absPath.split('Rocket.Chat/')[1]
                    : path.relative(rcSrcDir, absPath);
                const srcPath  = absPath.startsWith('/') ? absPath : path.join(rcSrcDir, rel);
                const skelPath = path.join(outputDir, rel.replace(/\.ts$/, '.skeleton.ts'));

                const raw  = fs.existsSync(srcPath)  ? this.estTokens(fs.readFileSync(srcPath,  'utf-8')) : 0;
                const skel = fs.existsSync(skelPath)  ? this.estTokens(fs.readFileSync(skelPath, 'utf-8')) : 0;
                fullTokens += raw;
                skelTokens += skel;
                if (raw > 0) fileDetails.push({ file: path.basename(srcPath), raw, skeleton: skel });
            }

            if (fullTokens === 0) continue;
            const saved = skelTokens > 0 ? (1 - skelTokens / fullTokens) * 100 : 0;

            results.push({
                query:            turn.query.substring(0, 70),
                filesAccessed:    accessedFiles.size,
                fullCodeTokens:   fullTokens,
                skeletonTokens:   skelTokens,
                compressionRatio: skelTokens > 0 ? `${(fullTokens / skelTokens).toFixed(2)}x` : 'N/A',
                savedPercent:     `${saved.toFixed(1)}%`,
                meetsTarget:      saved >= 70,
                fileDetails,
            });
        }

        const avgSaved = results.length
            ? `${(results.reduce((s, r) => s + parseFloat(r.savedPercent), 0) / results.length).toFixed(1)}%`
            : 'N/A';
        const failing = results.filter(r => !r.meetsTarget);

        return {
            results,
            avgSaved,
            meetsTarget: failing.length === 0,
            verdict: failing.length === 0
                ? '✅ All turns meet the 70% token-saving target'
                : `⚠️  ${failing.length} turn(s) below 70% — multi-tier indexing needs tightening`,
        };
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private resolveSkeletonPath(sym: string, outputDir: string, rcSrcDir: string): string | null {
        if (sym.includes('/') || sym.endsWith('.ts')) {
            const rel = sym.includes('Rocket.Chat/')
                ? sym.split('Rocket.Chat/')[1]
                : path.relative(rcSrcDir, sym);
            return path.join(outputDir, rel.replace(/\.ts$/, '.skeleton.ts'));
        }
        return this.findSkeletonBySymbol(sym, outputDir);
    }

    private findSkeletonBySymbol(symbol: string, dir: string, depth = 0): string | null {
        if (depth > 6) return null;
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    const found = this.findSkeletonBySymbol(symbol, full, depth + 1);
                    if (found) return found;
                } else if (e.name.endsWith('.skeleton.ts')) {
                    const c = fs.readFileSync(full, 'utf-8');
                    if (c.includes(`function ${symbol}`) || c.includes(`class ${symbol}`) ||
                        c.includes(`const ${symbol}`)    || c.includes(`export { ${symbol}`)) {
                        return full;
                    }
                }
            }
        } catch { /* skip */ }
        return null;
    }

    private extractIdentifiers(skeleton: string): string[] {
        const SKIP = new Set([
            'import', 'export', 'from', 'const', 'let', 'var', 'function', 'class',
            'interface', 'type', 'return', 'async', 'await', 'void', 'string', 'number',
            'boolean', 'null', 'undefined', 'true', 'false', 'new', 'this', 'extends',
            'implements', 'readonly', 'private', 'public', 'protected', 'static',
            'abstract', 'default', 'throw', 'catch', 'finally', 'switch', 'case',
            'break', 'continue', 'Promise', 'Array', 'Record', 'Partial', 'Required',
        ]);
        const raw = skeleton.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g) ?? [];
        return [...new Set(raw.filter(id => !SKIP.has(id)))];
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolCall {
    tool:        string;
    args:        Record<string, any>;
    status:      '✓' | '✗';
    resultLines: string[];
}

interface Turn {
    query:     string;
    toolCalls: ToolCall[];
    aiLines:   string[];
}

interface ParsedSession {
    turns:        Turn[];
    allToolCalls: ToolCall[];
    allAIText:    string;
}

export interface SNRResult {
    query:               string;
    tool:                string;
    symbol:              string;
    skeletonIdentifiers: number;
    referencedInAnswer:  number;
    snr:                 string;
    unusedTopK:          string[];
}

export interface SNRSummary {
    results:     SNRResult[];
    avgSNR:      string;
    fatSkeletons: SNRResult[];
    verdict:     string;
}

export interface RepeatCallEntry {
    symbol:    string;
    callCount: number;
    tools:     string[];
    queries:   string[];
    isRepeat:  boolean;
}

export interface RepeatCallSummary {
    totalCalls:      number;
    uniqueSymbols:   number;
    repeatedSymbols: number;
    repeatRate:      string;
    hotSymbols:      RepeatCallEntry[];
    verdict:         string;
}

export interface TaskCostResult {
    query:            string;
    filesAccessed:    number;
    fullCodeTokens:   number;
    skeletonTokens:   number;
    compressionRatio: string;
    savedPercent:     string;
    meetsTarget:      boolean;
    fileDetails:      Array<{ file: string; raw: number; skeleton: number }>;
}

export interface TaskCostSummary {
    results:     TaskCostResult[];
    avgSaved:    string;
    meetsTarget: boolean;
    verdict:     string;
}
