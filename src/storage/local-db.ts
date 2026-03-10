import * as fs from 'fs';
import * as path from 'path';

export interface SymbolIndex {
    symbols: Record<string, string[]>;       // 符号名 -> 文件路径数组
    fileDependents: Record<string, string[]>; // 文件路径 -> 依赖者路径数组
    symbolWeights: Record<string, number>;    // 符号 -> PageRank 权重
    allFiles: string[];
}

export class LocalDatabase {
    private indexPath: string;

    constructor(outputDir: string) {
        this.indexPath = path.join(outputDir, '.global_index.json');
    }

    /**
     * 将内存中的 Map/Set 结构序列化并保存到磁盘
     */
    saveIndex(globalIndex: any) {
        console.error("💾 Saving global index to disk...");
        const data: SymbolIndex = {
            symbols: Object.fromEntries(
                Array.from(globalIndex.symbols.entries()).map(([k, v]) => [k, Array.from(v)])
            ),
            fileDependents: Object.fromEntries(
                Array.from(globalIndex.fileDependents.entries()).map(([k, v]) => [k, Array.from(v)])
            ),
            symbolWeights: Object.fromEntries(globalIndex.symbolWeights.entries()),
            allFiles: Array.from(globalIndex.allFiles)
        };

        fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
        console.error("✅ Index persisted successfully.");
    }

    /**
     * 从磁盘加载索引并还原为内存中的 Map/Set
     */
    loadIndex(globalIndex: any): boolean {
        if (!fs.existsSync(this.indexPath)) return false;

        console.error("📂 Loading index from cache...");
        const data: SymbolIndex = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));

        // 还原 Symbols Map
        for (const [name, paths] of Object.entries(data.symbols)) {
            globalIndex.symbols.set(name, new Set(paths));
        }

        // 还原 Dependents Map
        for (const [path, deps] of Object.entries(data.fileDependents)) {
            globalIndex.fileDependents.set(path, new Set(deps));
        }

        // 还原 Weights
        for (const [symbol, weight] of Object.entries(data.symbolWeights)) {
            globalIndex.symbolWeights.set(symbol, weight);
        }

        // 还原文件列表
        data.allFiles.forEach(f => globalIndex.allFiles.add(f));

        return true;
    }

    /**
     * 清理所有索引产物
     */
    clear(outputDir: string) {
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
            console.error("🧹 Local database cleared.");
        }
    }
}