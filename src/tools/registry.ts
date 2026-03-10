import * as fs from 'fs';
import * as path from 'path';
import { CodeRetriever } from '../pipeline/retriever.js';
import { CodeReranker } from '../pipeline/reranker.js';
import { GLOBAL_INDEX } from '../indexer/state.js';
import { OUTPUT_DIR, TARGET_SRC_DIR, ANALYSIS_DIR, getOutputPaths } from '../config.js';
import { globSync } from 'glob';

// ============================================================================
// Session 追踪：记录本次 gemini 会话中的工具调用情况，用于评估指标
// ============================================================================
const SESSION = {
    startTime: Date.now(),
    calls: [] as Array<{ tool: string; symbol?: string; tokensReturned: number; ts: number }>,
    symbolHits: new Map<string, number>(),   // 符号 -> 被调用次数（重复调用率）
    totalSkeletonTokens: 0                   // 累计返回的 skeleton token 估算数
};

function trackCall(tool: string, response: string, symbol?: string) {
    const tokens = Math.ceil(response.length / 4); // 粗估：4 字符 ≈ 1 token
    SESSION.calls.push({ tool, symbol, tokensReturned: tokens, ts: Date.now() });
    SESSION.totalSkeletonTokens += tokens;
    if (symbol) {
        SESSION.symbolHits.set(symbol, (SESSION.symbolHits.get(symbol) ?? 0) + 1);
    }
    // 写入 log，供事后分析
    console.error(`[TOOL_CALL] tool=${tool} symbol=${symbol ?? '-'} tokens=${tokens} ts=${new Date().toISOString()}`);
}

// 进程退出时写 session 摘要到 log
process.on('exit', () => {
    const duration = ((Date.now() - SESSION.startTime) / 1000).toFixed(1);
    const repeated = Array.from(SESSION.symbolHits.values()).filter(c => c > 1).length;
    const total = SESSION.symbolHits.size;
    const hotSymbols = Array.from(SESSION.symbolHits.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([s, c]) => `${s}(×${c})`).join(', ');

    console.error([
        '',
        '=== SESSION SUMMARY ===',
        `duration        : ${duration}s`,
        `total_calls     : ${SESSION.calls.length}`,
        `skeleton_tokens : ${SESSION.totalSkeletonTokens}`,
        `repeat_rate     : ${total > 0 ? (repeated / total * 100).toFixed(1) : 0}% (${repeated}/${total})`,
        `hot_symbols     : ${hotSymbols || 'none'}`,
        '======================',
    ].join('\n'));
});

// ============================================================================
// 工具定义（与 gemini-extension.json 保持一致）
// ============================================================================
export const TOOL_DEFINITIONS = [
    {
        name: "search_symbol",
        description: "【首选符号定位工具】在 Rocket.Chat 全量索引中查找函数、类、变量的定义位置。输入符号名（如 updateMessage、sendMessage、RoomType），立即返回定义所在的文件路径。比 SearchText/grep 更快更准，支持模糊匹配。查找任何符号定义时必须优先使用此工具。",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "搜索关键词（类名、方法名、功能描述）" }
            },
            required: ["query"]
        }
    },
    {
        name: "search_mcp_prewarm_cache",
        description: "【首选路径搜索工具】在已索引的 Rocket.Chat 源码中搜索文件或目录路径。输入文件名片段（如 'sendMessage' 或 'app/lib/server'），返回所有匹配的绝对路径。比内置 FindFiles/ReadFolder 快且准确。",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "文件名或路径片段" }
            },
            required: ["query"]
        }
    },
    {
        name: "get_file_skeleton",
        description: "查看脱水骨架：快速理解文件的导出结构和类型签名，无需读取完整源码。",
        inputSchema: {
            type: "object",
            properties: {
                filename: { type: "string", description: "文件名或绝对路径" }
            },
            required: ["filename"]
        }
    },
    {
        name: "read_symbol_details",
        description: "深度探测：读取某个符号的完整上下文（含 callee skeleton），结果同时写入 output/{symbolName}.md 供后续积累分析。",
        inputSchema: {
            type: "object",
            properties: {
                symbolName: { type: "string", description: "符号名称（如 sendMessage）" },
                filename: { type: "string", description: "可选：优先匹配的文件路径" }
            },
            required: ["symbolName"]
        }
    },
    {
        name: "get_codebase_topology",
        description: "获取全局拓扑：查看 PageRank 核心权重和文件依赖关系，理解整体架构。",
        inputSchema: {
            type: "object",
            properties: {
                filename: { type: "string", description: "可选：指定文件，返回引用该文件的所有依赖者" },
                topK: { type: "number", description: "返回 Top K 核心符号（默认 20）" }
            },
            required: []
        }
    },
    {
        name: "find_references",
        description: "【分析依赖关系】查找所有 import 或依赖某个文件/符号的文件列表。当需要分析某个目录或文件的 import 依赖、被哪些模块引用时，优先使用此工具，无需手动搜索 import 语句。",
        inputSchema: {
            type: "object",
            properties: {
                target: { type: "string", description: "文件路径或符号名称" }
            },
            required: ["target"]
        }
    },
    {
        name: "get_system_config",
        description: "获取系统配置：索引状态、压缩率统计、工具路由规则。",
        inputSchema: {
            type: "object",
            properties: {},
            required: []
        }
    }
];

// ============================================================================
// 工具分发器
// ============================================================================
export async function handleToolCall(name: string, args: any): Promise<any> {
    switch (name) {

        case "search_symbol": {
            const { query } = args;
            if (!query) return err("缺少参数: query");

            // 1. grep-first：精确匹配符号名（最快路径）
            const exactMatch = GLOBAL_INDEX.symbols.get(query);
            if (exactMatch && exactMatch.size > 0) {
                const paths = Array.from(exactMatch);
                return ok(`🎯 精确匹配 "${query}":\n${paths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
            }

            // 2. 前缀匹配（grep-like，无歧义时直接返回）
            const q = query.toLowerCase();
            const prefixHits = Array.from(GLOBAL_INDEX.symbols.keys())
                .filter(k => k.toLowerCase().startsWith(q))
                .slice(0, 5);
            if (prefixHits.length === 1) {
                const paths = Array.from(GLOBAL_INDEX.symbols.get(prefixHits[0]) ?? []);
                return ok(`🔍 前缀匹配 "${prefixHits[0]}":\n${paths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
            }

            // 3. 回退：fuzzy + BM25 双路搜索 + 意图重排
            const candidates = CodeRetriever.search(query, 50);
            const ranked = CodeReranker.rerank(query, candidates);
            if (ranked.length === 0) return ok("未找到匹配的符号，请尝试其他关键词。");
            const text = [
                prefixHits.length > 1 ? `💡 前缀候选: ${prefixHits.join(', ')}\n` : '',
                ranked.map((r, i) =>
                    `${i + 1}. [Score: ${r.finalScore.toFixed(4)}] [PageRank: ${r.centrality.toFixed(4)}] ${r.symbolName}\n   → ${r.paths[0] ?? 'unknown'}`
                ).join('\n')
            ].join('');
            return ok(text);
        }

        case "search_mcp_prewarm_cache": {
            const { query } = args;
            if (!query) return err("缺少参数: query");
            const q = query.toLowerCase();
            const matches = Array.from(GLOBAL_INDEX.allFiles)
                .filter(f => f.toLowerCase().includes(q))
                .slice(0, 30);
            return ok(matches.length > 0
                ? matches.join('\n')
                : `未在缓存中找到包含 "${query}" 的文件路径`
            );
        }

        case "get_file_skeleton": {
            const { filename } = args;
            if (!filename) return err("缺少参数: filename");

            // 在已索引的源文件中查找匹配项
            const q = filename.toLowerCase().replace(/\.ts$/, '');
            const matched = Array.from(GLOBAL_INDEX.allFiles).find(f => {
                const rel = f.toLowerCase().replace(/\.ts$/, '');
                return rel.endsWith(q) || path.basename(rel) === q;
            });
            if (!matched) return err(`未找到匹配 "${filename}" 的已索引文件。`);

            const skeletonPath = getOutputPaths(matched).skeletonPath;
            if (!fs.existsSync(skeletonPath)) {
                return err(`skeleton 文件不存在: ${skeletonPath}`);
            }
            return ok(fs.readFileSync(skeletonPath, 'utf-8'));
        }

        case "read_symbol_details": {
            const { symbolName, filename } = args;
            if (!symbolName) return err("缺少参数: symbolName");

            const mdPath = path.join(ANALYSIS_DIR, `${symbolName}.md`);

            // 找到该符号对应的 skeleton 文件（用于判断源码是否变更）
            const symbolPaths = GLOBAL_INDEX.symbols.get(symbolName);
            const firstSourcePath = symbolPaths ? Array.from(symbolPaths)[0] : null;
            const skeletonPath = firstSourcePath
                ? getOutputPaths(firstSourcePath).skeletonPath
                : null;

            // 源码未变 → 直接返回缓存的 md
            if (
                fs.existsSync(mdPath) &&
                skeletonPath && fs.existsSync(skeletonPath) &&
                fs.statSync(mdPath).mtimeMs >= fs.statSync(skeletonPath).mtimeMs
            ) {
                console.error(`📄 Returning cached md for ${symbolName}`);
                const cached = fs.readFileSync(mdPath, 'utf-8');
                trackCall(name, cached, symbolName);
                return ok(cached);
            }

            // 源码有变更或 md 不存在 → 重新生成
            // 传入 filename 作为 callerFile，用于同名符号歧义解析
            const contexts = CodeRetriever.getContext(symbolName, filename);
            if (contexts.length === 0) {
                return ok(`未找到符号 "${symbolName}"，请先用 search_symbol 确认名称。`);
            }

            const primary = filename
                ? (contexts.find(c => c.includes(path.basename(filename, '.ts'))) ?? contexts[0])
                : contexts[0];

            const mdContent = [
                `# Symbol: ${symbolName}`,
                `*Generated: ${new Date().toISOString()}*`,
                '',
                contexts.join('\n\n---\n\n')
            ].join('\n');

            fs.writeFileSync(mdPath, mdContent, 'utf-8');
            console.error(`📝 Regenerated md for ${symbolName} (source changed)`);

            trackCall(name, primary, symbolName);
            return ok(primary);
        }

        case "get_codebase_topology": {
            const { filename, topK = 20 } = args;
            if (filename) {
                const dependents = GLOBAL_INDEX.fileDependents.get(filename);
                if (!dependents || dependents.size === 0) return ok(`没有文件引用 ${filename}`);
                return ok(`📌 ${filename} 被以下 ${dependents.size} 个文件引用：\n\n${Array.from(dependents).join('\n')}`);
            }
            const top = Array.from(GLOBAL_INDEX.symbolWeights.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, topK)
                .map(([sym, w], i) => {
                    const file = Array.from(GLOBAL_INDEX.symbols.get(sym) ?? [])[0] ?? 'unknown';
                    return `${i + 1}. [PageRank: ${w.toFixed(6)}] ${sym}\n   → ${file}`;
                }).join('\n');
            return ok(top || "索引尚未构建，请先运行 preWarmCache。");
        }

        case "find_references": {
            const { target, depth = 2 } = args;
            if (!target) return err("缺少参数: target");

            // 解析 target：支持符号名（先找到其文件）或直接文件路径
            let startFiles: string[] = [];

            const bySymbol = GLOBAL_INDEX.symbols.get(target);
            if (bySymbol && bySymbol.size > 0) {
                startFiles = Array.from(bySymbol);
            } else if (GLOBAL_INDEX.fileDependents.has(target) || GLOBAL_INDEX.allFiles.has(target)) {
                startFiles = [target];
            } else {
                // 模糊路径匹配
                const q = target.toLowerCase();
                startFiles = Array.from(GLOBAL_INDEX.allFiles).filter(f => f.toLowerCase().includes(q));
            }

            if (startFiles.length === 0) {
                return ok(`未找到与 "${target}" 相关的文件或符号`);
            }

            // BFS 多层引用追踪
            const maxDepth = Math.min(Math.max(1, depth), 5); // 最多 5 层
            const visited = new Map<string, number>(); // file -> 层级
            const queue: [string, number][] = startFiles.map(f => [f, 0]);

            while (queue.length > 0) {
                const [current, d] = queue.shift()!;
                if (d >= maxDepth || visited.has(current)) continue;
                visited.set(current, d);
                const deps = GLOBAL_INDEX.fileDependents.get(current) ?? new Set();
                for (const dep of Array.from(deps)) {
                    if (!visited.has(dep)) queue.push([dep, d + 1]);
                }
            }

            // 移除起始文件本身，按层级分组输出
            for (const f of startFiles) visited.delete(f);

            if (visited.size === 0) {
                return ok(`没有文件引用 "${target}"`);
            }

            const byDepth = new Map<number, string[]>();
            for (const [file, d] of Array.from(visited.entries())) {
                if (!byDepth.has(d)) byDepth.set(d, []);
                byDepth.get(d)!.push(file);
            }

            const lines = [`📎 "${target}" 的引用链（共 ${visited.size} 个文件，深度 ${maxDepth}）：`];
            for (let d = 1; d <= maxDepth; d++) {
                const files = byDepth.get(d);
                if (files && files.length > 0) {
                    lines.push(`\n[深度 ${d}]`);
                    files.forEach(f => lines.push(`  ${f}`));
                }
            }
            return ok(lines.join('\n'));
        }

        case "get_system_config": {
            // 计算 token 压缩率（采样 output/ 中前 5 个 skeleton 文件）
            let tokenStats = '无可用 skeleton 文件进行压缩率分析';
            let totalRaw = 0, totalSkeleton = 0;
            try {
                const skeletonFiles = globSync('**/*.skeleton.ts', {
                    cwd: OUTPUT_DIR, absolute: true, ignore: ['_analysis/**']
                }).slice(0, 5);

                if (skeletonFiles.length > 0) {
                    const estTokens = (s: string) => Math.ceil(s.length / 4);

                    for (const sf of skeletonFiles) {
                        const skeletonContent = fs.readFileSync(sf, 'utf-8');
                        // 从 mapping 找到原始文件路径
                        const mappingPath = sf.replace('.skeleton.ts', '.mapping.json');
                        if (fs.existsSync(mappingPath)) {
                            const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
                            if (fs.existsSync(mapping.sourcePath)) {
                                const rawContent = fs.readFileSync(mapping.sourcePath, 'utf-8');
                                totalRaw += estTokens(rawContent);
                                totalSkeleton += estTokens(skeletonContent);
                            }
                        }
                    }

                    if (totalSkeleton > 0) {
                        tokenStats = `avg compression: ${(totalRaw / totalSkeleton).toFixed(2)}x (${totalRaw} → ${totalSkeleton} tokens, saved ${totalRaw - totalSkeleton} tokens)`;
                    }
                }
            } catch (e) {
                tokenStats = `token analysis error: ${e}`;
            }

            // ── 评估指标：基于 SESSION 追踪 ─────────────────────────────────────
            const totalSymbols = SESSION.symbolHits.size;
            const repeatedSymbols = Array.from(SESSION.symbolHits.values()).filter(c => c > 1).length;
            const repeatCallRate = totalSymbols > 0
                ? `${(repeatedSymbols / totalSymbols * 100).toFixed(1)}% (${repeatedSymbols}/${totalSymbols} symbols repeated)`
                : 'N/A (no symbol calls yet)';

            const hotSymbols = Array.from(SESSION.symbolHits.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([sym, count]) => `${sym} (×${count})`);

            const sessionDurationMin = ((Date.now() - SESSION.startTime) / 60000).toFixed(1);

            return ok(JSON.stringify({
                targetSrcDir: TARGET_SRC_DIR,
                outputDir: OUTPUT_DIR,
                indexedFiles: GLOBAL_INDEX.allFiles.size,
                indexedSymbols: GLOBAL_INDEX.symbols.size,
                tokenCompression: tokenStats,
                evaluation: {
                    sessionDuration: `${sessionDurationMin} min`,
                    totalToolCalls: SESSION.calls.length,
                    totalSkeletonTokensReturned: SESSION.totalSkeletonTokens,
                    // 重复调用率：AI 是否反复调用同一符号（高 = skeleton 信息不足）
                    repeatCallRate,
                    // 热点符号：最频繁被查询的符号
                    hotSymbols: hotSymbols.length > 0 ? hotSymbols : ['none yet'],
                    // 任务成本对比：skeleton token vs 估算的全量源码 token
                    costComparison: totalSkeleton > 0
                        ? `skeleton: ~${SESSION.totalSkeletonTokens} tokens returned this session (${(totalRaw / totalSkeleton).toFixed(2)}x compression vs raw)`
                        : `skeleton: ~${SESSION.totalSkeletonTokens} tokens returned this session`
                },
                routing: {
                    "search_mcp_prewarm_cache": "gemini-2.5-flash-lite",
                    "get_file_skeleton": "gemini-2.5-flash-lite",
                    "read_symbol_details": "gemini-2.5-pro",
                    "get_codebase_topology": "gemini-2.5-flash-lite",
                    "search_symbol": "gemini-2.5-flash-lite",
                    "find_references": "gemini-2.5-flash-lite",
                    "get_system_config": "gemini-2.5-flash-lite"
                }
            }, null, 2));
        }

        default:
            return err(`未知工具: ${name}`);
    }
}

function ok(text: string) { return { content: [{ type: "text", text }] }; }
function err(text: string) { return { content: [{ type: "text", text }], isError: true }; }
