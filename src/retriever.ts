import fuzzysort from 'fuzzysort';
import * as fs from 'fs';
import { Project } from 'ts-morph';
import { GLOBAL_INDEX } from './indexer/state.js';
import { getOutputPaths } from './config.js';

const PATH_HINTS: Array<{ keywords: string[]; segment: string }> = [
    { keywords: ['client', 'ui', 'component', 'react'], segment: 'client' },
    { keywords: ['server', 'backend', 'method'],        segment: 'server' },
    { keywords: ['api', 'rest', 'endpoint', 'route'],   segment: 'api/server' },
    { keywords: ['package', 'shared', 'model'],         segment: 'packages' },
    { keywords: ['enterprise', 'ee', 'premium'],        segment: 'ee/' },
];

export class CodeRetriever {
    /**
     * Fuzzy symbol search with path-context reranking.
     * Returns top 5 results.
     */
    static search(query: string, limit = 5, layer?: string): any[] {
        const symbolList = Array.from(GLOBAL_INDEX.symbols.keys());
        const fuzzyResults = fuzzysort.go(query, symbolList, { threshold: -3000, limit: 50 });

        // Explicit layer parameter → deterministic segment boost (0.5), overrides keyword inference
        const q = query.toLowerCase();
        const layerSegment = layer ? `/${layer}/` : null;
        const inferredSegments = PATH_HINTS
            .filter(h => h.keywords.some(k => q.includes(k)))
            .map(h => h.segment);

        return fuzzyResults
            .map(res => {
                const rawScore = Math.max(0, 1 + res.score / 3000);
                // Penalize when query is much shorter than target: fuzzysort treats "api" as a
                // valid subsequence of "applyDepartmentRestrictionsPatch", giving a misleadingly
                // high score. Require the query to cover at least 40% of the target length.
                const lengthRatio = query.length / res.target.length;
                const baseScore = lengthRatio < 0.4 ? rawScore * (lengthRatio / 0.4) : rawScore;
                const paths = Array.from(GLOBAL_INDEX.symbols.get(res.target) ?? []);
                let pathBonus = 0;
                if (layerSegment && paths.some(p => p.includes(layerSegment))) {
                    pathBonus = 0.5; // explicit layer → strong boost
                } else if (inferredSegments.length > 0 && paths.some(p => inferredSegments.some(s => p.includes(s)))) {
                    pathBonus = 0.3; // inferred from query keywords → soft boost
                }
                const finalScore = baseScore + pathBonus;
                return { symbolName: res.target, paths, score: baseScore, finalScore };
            })
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, limit);
    }

    /**
     * Build read_symbol_details context:
     * 1. Disambiguate by caller import graph
     * 2. Return primary skeleton + up to 5 callee skeletons
     */
    static getContext(symbolName: string, callerFile?: string): string[] {
        const paths = GLOBAL_INDEX.symbols.get(symbolName);
        if (!paths) return [];

        let sortedPaths = Array.from(paths);

        // 若 filename 精确匹配某个 symbol path，只返回该文件
        if (callerFile) {
            const q = callerFile.toLowerCase().replace(/\.tsx?$/, '');
            const exactMatch = sortedPaths.find(p =>
                p.toLowerCase().replace(/\.tsx?$/, '').endsWith(q)
            );
            if (exactMatch) sortedPaths = [exactMatch];
        }

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
                    sortedPaths.sort((a, b) => (importedPaths.has(a) ? 0 : 1) - (importedPaths.has(b) ? 0 : 1));
                } catch { /* ignore */ }
            }
        }

        const results: string[] = [];
        const included = new Set<string>();
        const calleeSymbols = new Set<string>();

        for (const sourcePath of sortedPaths) {
            const { skeletonPath, mappingPath } = getOutputPaths(sourcePath);
            if (fs.existsSync(skeletonPath) && !included.has(skeletonPath)) {
                results.push(fs.readFileSync(skeletonPath, 'utf-8'));
                included.add(skeletonPath);
            }
            if (fs.existsSync(mappingPath)) {
                try {
                    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
                    const sym = (mapping.symbols ?? []).find(
                        (s: any) => s.name === symbolName || s.qualifiedName?.endsWith(`.${symbolName}`)
                    );
                    sym?.calls?.forEach((c: string) => calleeSymbols.add(c));
                } catch { /* ignore */ }
            }
        }

        let calleeCount = 0;
        for (const callee of calleeSymbols) {
            if (calleeCount >= 5) break;
            for (const calleePath of GLOBAL_INDEX.symbols.get(callee) ?? []) {
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

    /**
     * 从原始源文件中提取指定 symbol 的实际实现代码。
     * 返回 { text: 实现代码, filePath: 源文件路径 }，找不到返回 null。
     */
    static getImplementation(symbolName: string, preferredFile?: string): { text: string; filePath: string } | null {
        const paths = GLOBAL_INDEX.symbols.get(symbolName);
        if (!paths || paths.size === 0) return null;

        let sortedPaths = Array.from(paths);

        // 精确文件匹配
        if (preferredFile) {
            const q = preferredFile.toLowerCase().replace(/\.tsx?$/, '');
            const exact = sortedPaths.find(p => p.toLowerCase().replace(/\.tsx?$/, '').endsWith(q));
            if (exact) sortedPaths = [exact];
        }

        for (const filePath of sortedPaths) {
            try {
                const project = new Project({ skipAddingFilesFromTsConfig: true });
                const sourceFile = project.addSourceFileAtPath(filePath);
                let text: string | null = null;

                // 函数声明
                for (const fn of sourceFile.getFunctions()) {
                    if (fn.getName() === symbolName) { text = fn.getFullText().trim(); break; }
                }

                // 变量声明（箭头函数 / const fn = ...）
                if (!text) {
                    for (const v of sourceFile.getVariableDeclarations()) {
                        if (v.getName() === symbolName) {
                            text = v.getVariableStatement()?.getFullText().trim() ?? v.getFullText().trim();
                            break;
                        }
                    }
                }

                // 类
                if (!text) {
                    for (const cls of sourceFile.getClasses()) {
                        if (cls.getName() === symbolName) { text = cls.getFullText().trim(); break; }
                    }
                }

                // 接口 / 类型别名
                if (!text) {
                    for (const iface of sourceFile.getInterfaces()) {
                        if (iface.getName() === symbolName) { text = iface.getFullText().trim(); break; }
                    }
                }
                if (!text) {
                    for (const t of sourceFile.getTypeAliases()) {
                        if (t.getName() === symbolName) { text = t.getFullText().trim(); break; }
                    }
                }

                sourceFile.forget();
                if (text) return { text, filePath };
            } catch { /* 跳过解析失败的文件 */ }
        }

        return null;
    }
}
