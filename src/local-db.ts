import * as fs from 'fs';
import * as path from 'path';

export interface SymbolIndex {
    symbols: Record<string, string[]>;
    fileDependents: Record<string, string[]>;
    allFiles: string[];
    callGraph: Record<string, Array<{ caller: string; file: string; edgeType?: string }>>;
}

export class LocalDatabase {
    private indexPath: string;
    private embeddingsPath: string;

    constructor(outputDir: string) {
        this.indexPath = path.join(outputDir, '.global_index.json');
        this.embeddingsPath = path.join(outputDir, '.embeddings_index.json');
    }

    /**
     * 将内存中的 Map/Set 结构序列化并保存到磁盘
     * Embeddings 单独写入 .embeddings_index.json（体积大，避免影响主索引加载速度）
     */
    saveIndex(globalIndex: any) {
        console.error("💾 Saving global index to disk...");
        const data: SymbolIndex = {
            symbols: Object.fromEntries(
                Array.from(globalIndex.symbols.entries()).map(([k, v]: [any, any]) => [k, Array.from(v)])
            ),
            fileDependents: Object.fromEntries(
                Array.from(globalIndex.fileDependents.entries()).map(([k, v]: [any, any]) => [k, Array.from(v)])
            ),
            allFiles: Array.from(globalIndex.allFiles),
            callGraph: Object.fromEntries(globalIndex.callGraph.entries()),
        };

        fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));

        // embeddings 单独存，仅当有数据时写
        if (globalIndex.embeddings?.size > 0) {
            const embData = Object.fromEntries(globalIndex.embeddings.entries());
            fs.writeFileSync(this.embeddingsPath, JSON.stringify(embData));
        }

        console.error("✅ Index persisted successfully.");
    }

    /**
     * 从磁盘加载索引并还原为内存中的 Map/Set
     */
    loadIndex(globalIndex: any): boolean {
        if (!fs.existsSync(this.indexPath)) return false;

        console.error("📂 Loading index from cache...");
        const data: SymbolIndex = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));

        for (const [name, paths] of Object.entries(data.symbols)) {
            globalIndex.symbols.set(name, new Set(paths));
        }
        for (const [p, deps] of Object.entries(data.fileDependents)) {
            globalIndex.fileDependents.set(p, new Set(deps as string[]));
        }
        data.allFiles.forEach((f: string) => globalIndex.allFiles.add(f));
        for (const [callee, callers] of Object.entries(data.callGraph ?? {})) {
            globalIndex.callGraph.set(callee, callers);
        }

        // 加载 embeddings（可选，不存在时不报错）
        if (fs.existsSync(this.embeddingsPath)) {
            try {
                const embData: Record<string, number[]> = JSON.parse(fs.readFileSync(this.embeddingsPath, 'utf-8'));
                for (const [key, vec] of Object.entries(embData)) {
                    globalIndex.embeddings.set(key, vec);
                }
                console.error(`📐 Loaded ${globalIndex.embeddings.size} symbol embeddings.`);
            } catch (e) {
                console.error('⚠️ Failed to load embeddings index:', e);
            }
        }

        return true;
    }

    /**
     * 监听磁盘上的 index 文件，变化时自动热重载到内存
     */
    watchAndReload(globalIndex: any) {
        if (!fs.existsSync(this.indexPath)) return;
        fs.watch(this.indexPath, (event) => {
            if (event !== 'change') return;
            try {
                globalIndex.symbols.clear();
                globalIndex.fileDependents.clear();
                globalIndex.allFiles.clear();
                globalIndex.callGraph.clear();
                globalIndex.embeddings.clear();
                this.loadIndex(globalIndex);
                console.error('🔄 Index hot-reloaded from disk.');
            } catch (e) {
                console.error('⚠️ Failed to hot-reload index:', e);
            }
        });
        console.error('👀 Watching index for changes...');
    }

    clear(outputDir: string) {
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
            console.error("🧹 Local database cleared.");
        }
    }
}
