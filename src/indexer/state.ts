/**
 * 全局索引状态 —— 独立模块，打破 index.ts ↔ registry.ts 的循环依赖。
 * index.ts 和 registry.ts 都从这里 import，互不依赖。
 */

export const GLOBAL_INDEX = {
    symbols: new Map<string, Set<string>>(),        // 符号名 -> 定义文件路径
    fileDependents: new Map<string, Set<string>>(), // 文件 -> 哪些文件引用了它
    symbolWeights: new Map<string, number>(),       // 符号 -> PageRank 权重
    allFiles: new Set<string>(),
    termIndex: new Map<string, Set<string>>()       // 拆词 term -> 匹配的符号名集合（BM25 倒排索引）
};

/** 将 camelCase / PascalCase 符号名拆成小写 term 数组 */
export function splitCamelCase(name: string): string[] {
    return name
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .trim()
        .split(/[\s_\-]+/)
        .filter(t => t.length > 1);
}

/** 从 symbols Map 重建 termIndex（可在 loadIndex 后调用） */
export function buildTermIndex() {
    GLOBAL_INDEX.termIndex.clear();
    for (const symbolName of GLOBAL_INDEX.symbols.keys()) {
        for (const term of splitCamelCase(symbolName)) {
            if (!GLOBAL_INDEX.termIndex.has(term)) GLOBAL_INDEX.termIndex.set(term, new Set());
            GLOBAL_INDEX.termIndex.get(term)!.add(symbolName);
        }
    }
}
