import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodebaseHasher } from './hasher.js';
import { SkeletonGenerator } from './skeleton.js';
import { CentralityAnalyzer } from './centrality.js';
import { LocalDatabase } from '../storage/local-db.js';
import { TARGET_SRC_DIR, OUTPUT_DIR, CACHE_FILE, ANALYSIS_DIR, getOutputPaths } from '../config.js';
import { GLOBAL_INDEX, buildTermIndex } from './state.js';
import { TOOL_DEFINITIONS, handleToolCall } from '../tools/registry.js';

// Re-export for other modules that still import from here
export { GLOBAL_INDEX, splitCamelCase, buildTermIndex } from './state.js';

// 日志由 src/eval/session-recorder.ts 通过 script 录制并生成 PDF，MCP server 只输出到 stderr

// ============================================================================
// 1. 扫描目录：递归获取所有 .ts 文件
// ============================================================================
export function scanDirectory(dir: string): string[] {
    return globSync('**/*.ts', {
        cwd: dir,
        absolute: true,
        ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts', '**/dist/**']
    });
}

// ============================================================================
// 2. 预热：MD5 增量哈希 + AST 脱水，产物写入 output/
//    返回 updatedCount 供调用方决定是否需要重建索引
// ============================================================================
export function preWarmCache(): { updatedCount: number; totalFiles: number } {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    console.error('🚀 Starting Incremental Dehydration...');
    const hasher = new CodebaseHasher(CACHE_FILE);
    const allFiles = scanDirectory(TARGET_SRC_DIR);
    let updatedCount = 0;

    for (const file of allFiles) {
        const { needsUpdate, currentHash } = hasher.shouldUpdate(file);
        if (needsUpdate) {
            try {
                const { skeleton, mapping } = SkeletonGenerator.generate(file);
                const { skeletonPath, mappingPath } = getOutputPaths(file);
                const outDir = path.dirname(skeletonPath);
                if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(skeletonPath, skeleton, 'utf-8');
                fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8');
                hasher.updateRecord(file, currentHash);
                updatedCount++;
            } catch (e) {
                console.error(`❌ Failed to process ${file}:`, e);
            }
        }
    }

    hasher.prune(allFiles);
    hasher.save();
    console.error(`✨ Pre-warm complete. Updated ${updatedCount} / ${allFiles.length} files.`);
    return { updatedCount, totalFiles: allFiles.length };
}

// ============================================================================
// 3. 内存索引：从 output/*.mapping.json 构建 Symbol Map + PageRank
//    结果通过 LocalDatabase 持久化，下次无变更时直接加载跳过重建
// ============================================================================
export function initializeGlobalIndex() {
    console.error('🧠 Building memory-resident index...');
    GLOBAL_INDEX.symbols.clear();
    GLOBAL_INDEX.fileDependents.clear();
    GLOBAL_INDEX.symbolWeights.clear();
    GLOBAL_INDEX.allFiles.clear();

    const mappingFiles = globSync('**/*.mapping.json', { cwd: OUTPUT_DIR, absolute: true, ignore: ['_analysis/**'] });
    for (const mFile of mappingFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(mFile, 'utf-8'));
            const sourcePath: string = data.sourcePath;
            GLOBAL_INDEX.allFiles.add(sourcePath);

            (data.symbols ?? []).forEach((s: any) => {
                if (!GLOBAL_INDEX.symbols.has(s.name)) GLOBAL_INDEX.symbols.set(s.name, new Set());
                GLOBAL_INDEX.symbols.get(s.name)!.add(sourcePath);
            });

            (data.imports ?? []).forEach((imp: any) => {
                if (imp.resolved && imp.resolved !== 'external') {
                    if (!GLOBAL_INDEX.fileDependents.has(imp.resolved)) GLOBAL_INDEX.fileDependents.set(imp.resolved, new Set());
                    GLOBAL_INDEX.fileDependents.get(imp.resolved)!.add(sourcePath);
                }
            });
        } catch (e) {
            console.error(`❌ Failed to load mapping ${mFile}:`, e);
        }
    }

    GLOBAL_INDEX.symbolWeights = CentralityAnalyzer.compute(GLOBAL_INDEX);
    buildTermIndex();
    console.error(`✅ Index ready: ${GLOBAL_INDEX.symbols.size} symbols, ${GLOBAL_INDEX.allFiles.size} files, ${GLOBAL_INDEX.termIndex.size} terms.`);
}

// ============================================================================
// 4. MCP Server 启动入口
// ============================================================================
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });

// 增量预热，拿到变更数量
const { updatedCount } = preWarmCache();

// 若有文件变更或没有持久化的索引缓存，重建并保存；否则直接加载
const db = new LocalDatabase(OUTPUT_DIR);
if (updatedCount > 0 || !db.loadIndex(GLOBAL_INDEX)) {
    initializeGlobalIndex();
    db.saveIndex(GLOBAL_INDEX);
} else {
    buildTermIndex();
    console.error('⚡ Index loaded from cache (no source changes detected).');
}

const server = new Server(
    { name: 'gsoc-rocket-chat-analyzer', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) =>
    handleToolCall(name, args ?? {})
);

await server.connect(new StdioServerTransport());
console.error('✅ MCP Server running on stdio');

const shutdown = () => { process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
