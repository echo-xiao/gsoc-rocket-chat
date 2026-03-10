import fuzzysort from 'fuzzysort';
import * as fs from 'fs';
import * as path from 'path';
import { GLOBAL_INDEX, splitCamelCase } from '../indexer/state.js';
import { OUTPUT_DIR, getOutputPaths } from '../config.js';

export class CodeRetriever {
    /**
     * 混合检索：fuzzy 字符匹配 + BM25-like term 倒排索引，双路合并后 PageRank 加权
     */
    static search(query: string, limit: number = 50): any[] {
        const symbolList = Array.from(GLOBAL_INDEX.symbols.keys());

        // 路1：fuzzysort 字符级模糊匹配
        const fuzzyResults = fuzzysort.go(query, symbolList, { threshold: -3000, limit: 100 });
        const fuzzyMap = new Map<string, number>();
        for (const res of fuzzyResults) {
            fuzzyMap.set(res.target, Math.max(0, 1 + res.score / 3000));
        }

        // 路2：BM25-like term 倒排索引（camelCase 拆词）
        const queryTerms = Array.from(new Set([
            ...splitCamelCase(query),
            ...query.toLowerCase().split(/\s+/).filter(t => t.length > 1)
        ]));

        const termScoreMap = new Map<string, number>();
        for (const term of queryTerms) {
            for (const symbolName of Array.from(GLOBAL_INDEX.termIndex.get(term) ?? [])) {
                termScoreMap.set(symbolName, (termScoreMap.get(symbolName) ?? 0) + 1);
            }
        }

        // 合并双路结果
        const allSymbols = new Set([...fuzzyMap.keys(), ...termScoreMap.keys()]);
        const merged: any[] = [];

        for (const symbolName of Array.from(allSymbols)) {
            const fuzzyScore = fuzzyMap.get(symbolName) ?? 0;
            const termScore = queryTerms.length > 0
                ? (termScoreMap.get(symbolName) ?? 0) / queryTerms.length
                : 0;
            const centralityScore = GLOBAL_INDEX.symbolWeights.get(symbolName) ?? 0;
            const hasBoth = fuzzyScore > 0 && termScore > 0;
            const finalScore = hasBoth
                ? fuzzyScore * 0.5 + termScore * 0.3 + centralityScore * 0.2
                : fuzzyScore > 0
                    ? fuzzyScore * 0.7 + centralityScore * 0.3
                    : termScore * 0.6 + centralityScore * 0.4;

            merged.push({
                symbolName,
                paths: Array.from(GLOBAL_INDEX.symbols.get(symbolName) ?? []),
                score: finalScore,
                centrality: centralityScore,
                finalScore
            });
        }

        return merged.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);
    }

    /**
     * 获取增强上下文（函数调用级 Context Construction）：
     *
     * 1. 歧义解析：当同名符号存在于多个文件时，根据 callerFile 的 import 关系优先排序
     * 2. 主 skeleton：目标符号所在文件的 skeleton
     * 3. 函数调用级 callee：从 mapping.calls 找到被调用的函数，拉取其 skeleton
     *    → 实现"A 调用 B → 同时看到 B 的签名"的逻辑闭环
     */
    static getContext(symbolName: string, callerFile?: string): string[] {
        const paths = GLOBAL_INDEX.symbols.get(symbolName);
        if (!paths) return [];

        let sortedPaths = Array.from(paths);

        // ── 歧义解析：根据调用方 import 关系优先排序 ──────────────────────────
        if (callerFile && sortedPaths.length > 1) {
            const callerMappingPath = getOutputPaths(callerFile).mappingPath;
            if (fs.existsSync(callerMappingPath)) {
                try {
                    const callerMapping = JSON.parse(fs.readFileSync(callerMappingPath, 'utf-8'));
                    const importedPaths = new Set<string>(
                        (callerMapping.imports ?? [])
                            .filter((imp: any) => imp.resolved && imp.resolved !== 'external')
                            .map((imp: any) => imp.resolved)
                    );
                    // 调用方有 import 的文件排最前
                    sortedPaths.sort((a, b) => {
                        const aRank = importedPaths.has(a) ? 0 : 1;
                        const bRank = importedPaths.has(b) ? 0 : 1;
                        return aRank - bRank;
                    });
                } catch { /* ignore */ }
            }
        }

        const results: string[] = [];
        const included = new Set<string>();
        const calleeSymbols = new Set<string>(); // 被调用的函数名，待追踪

        // ── 主 skeleton + 提取 callee 调用列表 ───────────────────────────────
        for (const sourcePath of sortedPaths) {
            const { skeletonPath, mappingPath } = getOutputPaths(sourcePath);

            if (fs.existsSync(skeletonPath) && !included.has(skeletonPath)) {
                results.push(fs.readFileSync(skeletonPath, 'utf-8'));
                included.add(skeletonPath);
            }

            // 从 mapping 找到该符号的 calls 数组
            if (fs.existsSync(mappingPath)) {
                try {
                    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
                    const sym = (mapping.symbols ?? []).find(
                        (s: any) => s.name === symbolName || s.qualifiedName?.endsWith(`.${symbolName}`)
                    );
                    if (sym?.calls) {
                        sym.calls.forEach((c: string) => calleeSymbols.add(c));
                    }
                } catch { /* ignore */ }
            }
        }

        // ── 函数调用级 callee skeleton（最多 5 个，防止 token 爆炸）────────────
        let calleeCount = 0;
        for (const callee of Array.from(calleeSymbols)) {
            if (calleeCount >= 5) break;
            const calleePaths = GLOBAL_INDEX.symbols.get(callee);
            if (!calleePaths) continue;

            for (const calleePath of Array.from(calleePaths)) {
                const calleeSkeletonPath = getOutputPaths(calleePath).skeletonPath;
                if (fs.existsSync(calleeSkeletonPath) && !included.has(calleeSkeletonPath)) {
                    results.push(fs.readFileSync(calleeSkeletonPath, 'utf-8'));
                    included.add(calleeSkeletonPath);
                    calleeCount++;
                    break;
                }
            }
        }

        return results;
    }
}
