import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import cliProgress from 'cli-progress';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodebaseHasher } from './hasher.js';
import { SkeletonGenerator } from './skeleton.js';
import { LocalDatabase } from '../local-db.js';
import { TARGET_SRC_DIR, OUTPUT_DIR, CACHE_FILE, getOutputPaths } from '../config.js';
import { GLOBAL_INDEX } from './state.js';
import { computeAllEmbeddings, loadEmbeddingsIntoIndex } from './embedder.js';
import { TOOL_DEFINITIONS, handleToolCall } from '../registry.js';

// 日志由 src/eval/session-recorder.ts 通过 script 录制并生成 PDF，MCP server 只输出到 stderr

// ============================================================================
// 1. 扫描目录：递归获取所有 .ts 文件
// ============================================================================
export function scanDirectory(dir: string): string[] {
    return globSync('**/*.{ts,tsx}', {
        cwd: dir,
        absolute: true,
        ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx', '**/dist/**']
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

    const bar = new cliProgress.SingleBar({
        format: '  [{bar}] {value}/{total} | {percentage}% | {filename}',
        clearOnComplete: true,
        stream: process.stderr,
    }, cliProgress.Presets.shades_classic);
    bar.start(allFiles.length, 0, { filename: '' });

    for (const file of allFiles) {
        bar.increment({ filename: path.basename(file) });
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

    bar.stop();
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
    GLOBAL_INDEX.allFiles.clear();
    GLOBAL_INDEX.callGraph.clear();

    const mappingFiles = globSync('**/*.mapping.json', { cwd: OUTPUT_DIR, absolute: true, ignore: ['_analysis/**'] });
    for (const mFile of mappingFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(mFile, 'utf-8'));
            const sourcePath: string = data.sourcePath;
            GLOBAL_INDEX.allFiles.add(sourcePath);

            (data.symbols ?? []).forEach((s: any) => {
                if (!GLOBAL_INDEX.symbols.has(s.name)) GLOBAL_INDEX.symbols.set(s.name, new Set());
                GLOBAL_INDEX.symbols.get(s.name)!.add(sourcePath);

                // Build call graph: callee/event -> [{caller, file, edgeType}]
                // Supports both old format (string[]) and new format (CallEdge[])
                (s.calls ?? []).forEach((call: any) => {
                    const name: string = typeof call === 'string' ? call : call.name;
                    const edgeType: string = typeof call === 'string' ? 'call' : (call.edgeType ?? 'call');
                    const event: string | undefined = typeof call === 'object' ? call.event : undefined;

                    if (edgeType === 'event_listen' && event) {
                        // 建虚拟边：eventName → handler
                        // graph(handler, up) 时会显示 eventName 作为触发来源
                        if (!GLOBAL_INDEX.callGraph.has(name)) GLOBAL_INDEX.callGraph.set(name, []);
                        GLOBAL_INDEX.callGraph.get(name)!.push({ caller: event, file: sourcePath, edgeType: 'event_listen' });
                    } else {
                        if (!GLOBAL_INDEX.callGraph.has(name)) GLOBAL_INDEX.callGraph.set(name, []);
                        GLOBAL_INDEX.callGraph.get(name)!.push({ caller: s.name, file: sourcePath, edgeType: edgeType as any });
                    }
                });
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

    console.error(`✅ Index ready: ${GLOBAL_INDEX.symbols.size} symbols, ${GLOBAL_INDEX.allFiles.size} files.`);
}

// ============================================================================
// 4. MCP Server 启动入口
// ============================================================================
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// 每次启动时把 docs/ 里的 md 文件拼接写入 gemini-extension.json 的 agentInstructions
try {
    const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const instructions = fs.readFileSync(path.join(PROJECT_ROOT, 'docs/constitution.md'), 'utf-8').trim();
    const extPath = path.join(PROJECT_ROOT, 'gemini-extension.json');
    const ext = JSON.parse(fs.readFileSync(extPath, 'utf-8'));
    ext.agentInstructions = instructions;
    fs.writeFileSync(extPath, JSON.stringify(ext, null, 2) + '\n');
} catch (e) {
    console.error('⚠️ Failed to update agentInstructions:', e);
}

// 清理已废弃的 _analysis/ 目录
const ANALYSIS_DIR = path.join(OUTPUT_DIR, '_analysis');
if (fs.existsSync(ANALYSIS_DIR)) {
    fs.rmSync(ANALYSIS_DIR, { recursive: true, force: true });
    console.error('🧹 Removed stale _analysis/ directory.');
}

// 增量预热，拿到变更数量
const { updatedCount } = preWarmCache();

// 若有文件变更或没有持久化的索引缓存，重建并保存；否则直接加载
const db = new LocalDatabase(OUTPUT_DIR);
if (updatedCount > 0 || !db.loadIndex(GLOBAL_INDEX)) {
    initializeGlobalIndex();
    db.saveIndex(GLOBAL_INDEX);
} else {
    console.error('⚡ Index loaded from cache (no source changes detected).');
}

// Embedding 计算：增量，仅处理新增/变更的 symbol
// 若 GEMINI_API_KEY 未设置则跳过，不影响主流程
await computeAllEmbeddings();

// --prewarm: 只建索引，不启动 MCP server
if (process.argv.includes('--prewarm')) process.exit(0);

// 监听磁盘 index 变化，prewarm 完成后自动热重载到内存
db.watchAndReload(GLOBAL_INDEX);

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
