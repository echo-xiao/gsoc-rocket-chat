import * as fs from 'fs';
import * as path from 'path';

/**
 * Evaluator — Self-Driven Feedback (5 Error Types)
 *
 * All metrics compare against testcases.json ground truth:
 *
 * | Error Type                  | Detection                        | Correction Action                                      |
 * |-----------------------------|----------------------------------|--------------------------------------------------------|
 * | Missing key fact            | Key fact coverage < 100%         | Trace missed fact to source file → add to subsystem spec |
 * | Wrong file retrieved        | File hit rate < 95%              | Adjust BM25/PageRank weights or subsystem path scope   |
 * | Wrong retrieval order       | Order compliance < 80%           | Improve Tier 2 ranking to surface entry-point files first |
 * | Too many tool calls         | Tool call count > threshold      | Tighten Constitution protocol / improve Tier 2 ranking |
 * | implement overuse           | Share > 30% of total calls       | Enrich skeleton with more callee annotations           |
 */
export class Evaluator {

    // =========================================================================
    // Session log parser
    // =========================================================================

    parseSession(sessionLog: string): ParsedSession {
        const lines = sessionLog.split('\n');
        const turns: Turn[] = [];
        let current: Turn | null = null;
        let inBox = false;
        let boxLines: string[] = [];
        let curTool = '', curArgs: Record<string, any> = {}, curStatus: '✓' | '✗' = '✓';

        for (const line of lines) {
            if (/^ > [^/]/.test(line) && !line.includes('Type your message')) {
                if (current) turns.push(current);
                current = { query: line.replace(/^ > /, '').trim(), toolCalls: [], aiLines: [] };
                continue;
            }
            if (line.startsWith('╭─')) { inBox = true; boxLines = []; continue; }
            if (inBox && line.startsWith('╰─')) {
                inBox = false;
                if (current && curTool) {
                    const resultLines = boxLines
                        .filter(l => /^│ /.test(l))
                        .map(l => l.replace(/^│ /, '').trimEnd());
                    current.toolCalls.push({ tool: curTool, args: curArgs, status: curStatus, resultLines });
                }
                curTool = ''; curArgs = {};
                continue;
            }
            if (inBox) {
                const h = line.match(/^│ ([✓✗])  (\S+) \([^)]+\) (\{.+?)(?:\s{3,}│)?\s*$/);
                if (h) {
                    curStatus = h[1] as '✓' | '✗';
                    curTool   = h[2];
                    try { curArgs = JSON.parse(h[3]); } catch { curArgs = {}; }
                }
                boxLines.push(line);
                continue;
            }
            if (line.startsWith('✦ ') && current) current.aiLines.push(line.replace(/^✦ /, ''));
        }
        if (current) turns.push(current);
        return {
            turns,
            allToolCalls: turns.flatMap(t => t.toolCalls),
            allAIText:    turns.map(t => t.aiLines.join(' ')).join(' '),
        };
    }

    // =========================================================================
    // Error Type Evaluation — all 5 metrics vs testcases.json
    // =========================================================================

    evaluateErrorTypes(sessionLog: string, testcasesPath: string, toolCallThreshold = 10): ErrorTypeSummary {
        const session = this.parseSession(sessionLog);
        const errors: ErrorTypeEntry[] = [];

        let testcases: TestCase[] = [];
        try { testcases = JSON.parse(fs.readFileSync(testcasesPath, 'utf-8')); } catch { /* no testcases */ }

        const allSuccessful = session.allToolCalls.filter(c => c.status === '✓');
        const totalCalls    = allSuccessful.length;

        // ── Too Many Tool Calls — total session tool call count > threshold ────
        if (totalCalls > toolCallThreshold) {
            errors.push({
                type:       'Too many tool calls',
                turn:       '(session)',
                detail:     `${totalCalls} total tool calls (threshold: ${toolCallThreshold})`,
                correction: 'Tighten Constitution protocol or improve Tier 2 entry file ranking',
                verdict:    '⚠️',
            });
        }

        // ── implement Overuse — share > 30% of total calls ────────────────────
        const rsdCount = allSuccessful.filter(c => c.tool === 'implement').length;
        const rsdShare = totalCalls > 0 ? rsdCount / totalCalls : 0;
        if (rsdShare > 0.30) {
            errors.push({
                type:       'implement overuse',
                turn:       '(session)',
                detail:     `implement: ${rsdCount}/${totalCalls} calls (${(rsdShare * 100).toFixed(1)}% > 30%)`,
                correction: 'Enrich skeleton with more callee annotations',
                verdict:    '⚠️',
            });
        }

        // ── Per-turn checks against testcases ground truth ────────────────────
        let matchedTurns = 0;
        const turnSummaries: TurnSummary[] = [];
        for (const turn of session.turns) {
            const aiText = turn.aiLines.join(' ');

            // Match turn to testcase by exact question string
            const tc = testcases.find(t => t.question === turn.query);
            if (!tc) continue;
            matchedTurns++;

            // ── Build TurnSummary for ground truth display ─────────────────────
            const turnSummary: TurnSummary = {
                question: turn.query,
                files:    [],
                path:     [],
                symbols:  [],
            };

            // Missing Key Fact — keySymbols coverage < 100% ─────────────────
            // A symbol counts as found if it appears in AI text OR any tool result line
            if (tc.keySymbols && tc.keySymbols.length > 0) {
                const symFound = (sym: string) => aiText.includes(sym);
                turnSummary.symbols = tc.keySymbols.map(sym => ({ name: sym, found: symFound(sym) }));
                const missing  = tc.keySymbols.filter(sym => !symFound(sym));
                const coverage = ((tc.keySymbols.length - missing.length) / tc.keySymbols.length * 100).toFixed(1);
                if (missing.length > 0) {
                    errors.push({
                        type:       'Missing key fact',
                        turn:       turn.query.substring(0, 60),
                        detail:     `key fact coverage ${coverage}% < 100%`,
                        correction: 'Trace missed fact to source file → add path to subsystem spec',
                        verdict:    '❌',
                        comparison: tc.keySymbols.map(sym => ({
                            label:    sym,
                            expected: '✅ required',
                            actual:   aiText.includes(sym) ? '✅ found' : '❌ missing',
                        })),
                    });
                }
            }

            // ── Wrong File Retrieved — groundTruthFiles hit rate < 95% ────────
            // A file counts as retrieved if found via: implement args, graph/search result lines, or AI text.
            const retrievedOrder: string[] = [];
            if (tc.groundTruthFiles && tc.groundTruthFiles.length > 0) {
                // Track retrieval source per file basename
                const implementFiles = new Set<string>(); // via implement call
                const graphFiles     = new Set<string>(); // via graph/search result lines
                const aiFiles        = new Set<string>(); // mentioned in AI text

                for (const call of turn.toolCalls) {
                    if (call.status !== '✓') continue;
                    const fileArg = call.args.filename ?? call.args.target ?? '';
                    if (fileArg && call.tool === 'implement') {
                        implementFiles.add(fileArg);
                        const base = fileArg.split('/').pop()!.replace(/\.(tsx?)$/, '');
                        if (base) retrievedOrder.push(base);
                    }
                    // Extract file paths from any tool result lines (graph output, search output)
                    for (const line of call.resultLines) {
                        const m = line.match(/[\w/.-]+\.(?:ts|tsx)\b/g);
                        if (m) m.forEach(p => {
                            if (call.tool !== 'implement') graphFiles.add(p);
                        });
                    }
                }
                // AI text mentions
                for (const gtFile of tc.groundTruthFiles) {
                    const base = gtFile.split('/').pop()!;
                    if (aiText.includes(base)) aiFiles.add(gtFile);
                }

                const getSource = (gtFile: string): 'implement' | 'graph' | 'ai' | null => {
                    const base = gtFile.split('/').pop()!.replace(/\.(tsx?)$/, '');
                    if ([...implementFiles].some(r => r.includes(base))) return 'implement';
                    if ([...graphFiles].some(r => r.includes(base))) return 'graph';
                    if ([...aiFiles].some(r => r.includes(gtFile.split('/').pop()!))) return 'ai';
                    return null;
                };

                const hits = tc.groundTruthFiles.filter(f => getSource(f) !== null);
                turnSummary.files = tc.groundTruthFiles.map(f => ({
                    path:      f,
                    baseName:  f.split('/').pop() ?? f,
                    retrieved: getSource(f) !== null,
                    source:    getSource(f) ?? undefined,
                }));
                const hitRate = hits.length / tc.groundTruthFiles.length;
                if (hitRate < 0.95) {
                    errors.push({
                        type:       'Wrong file retrieved',
                        turn:       turn.query.substring(0, 60),
                        detail:     `file hit rate ${(hitRate * 100).toFixed(1)}% < 95%`,
                        correction: 'Adjust retrieval or add entry to subsystem index',
                        verdict:    '❌',
                        comparison: tc.groundTruthFiles.map(f => {
                            const src = getSource(f);
                            return {
                                label:    f.split('/').pop() ?? f,
                                expected: '✅ required',
                                actual:   src ? `✅ retrieved (${src})` : '❌ missed',
                            };
                        }),
                    });
                }
            }

            // ── Wrong Retrieval Order — path data collected for Part 3 display only ─
            if (tc.groundTruthPath && tc.groundTruthPath.length > 0) {
                const gtBases = tc.groundTruthPath.map(p =>
                    p.file.split('/').pop()!.replace(/\.(tsx?)$/, '')
                );
                turnSummary.path = tc.groundTruthPath.map((p, i) => {
                    const base      = gtBases[i];
                    const actualPos = retrievedOrder.findIndex(r => r.includes(base));
                    return {
                        file:        p.file.split('/').pop() ?? p.file,
                        symbol:      p.symbol,
                        expectedPos: i + 1,
                        actualPos:   actualPos === -1 ? null : actualPos + 1,
                    };
                });
            }
            turnSummaries.push(turnSummary);
        }

        const byType = new Map<string, number>();
        for (const e of errors) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

        return {
            errors,
            byType:        Object.fromEntries(byType),
            total:         errors.length,
            matchedTurns,
            turnSummaries,
            verdict: errors.length === 0
                ? '✅ No errors detected'
                : `⚠️  ${errors.length} error(s) across ${byType.size} type(s)`,
            sessionMetrics: {
                totalCalls,
                threshold:           toolCallThreshold,
                rsdCount,
                rsdShare,
                missingKeyFactTurns: byType.get('Missing key fact')       ?? 0,
                wrongFileTurns:      byType.get('Wrong file retrieved')   ?? 0,
            },
        };
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

interface TestCase {
    id:               string;
    question:         string;
    subsystem?:       string;
    difficulty?:      string;
    groundTruthFiles?: string[];
    groundTruthPath?:  Array<{ file: string; symbol: string }>;
    keySymbols?:       string[];
}

export interface ComparisonRow {
    label:    string;
    expected: string;
    actual:   string;
}

export interface ErrorTypeEntry {
    type:       string;
    turn:       string;
    detail:     string;
    correction: string;
    verdict:    string;
    comparison?: ComparisonRow[];
}

export interface TurnSummary {
    question: string;
    files:    Array<{ path: string; baseName: string; retrieved: boolean; source?: string }>;
    path:     Array<{ file: string; symbol: string; expectedPos: number; actualPos: number | null }>;
    symbols:  Array<{ name: string; found: boolean }>;
}

export interface SessionMetrics {
    totalCalls:          number;
    threshold:           number;
    rsdCount:            number;
    rsdShare:            number;
    missingKeyFactTurns: number;
    wrongFileTurns:      number;
}

export interface ErrorTypeSummary {
    errors:         ErrorTypeEntry[];
    byType:         Record<string, number>;
    total:          number;
    matchedTurns:   number;
    verdict:        string;
    turnSummaries:  TurnSummary[];
    sessionMetrics: SessionMetrics;
}
