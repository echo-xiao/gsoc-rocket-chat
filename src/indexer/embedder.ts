import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { globSync } from 'glob';
import { EMBEDDING_CACHE_FILE, EMBEDDING_VERSION, OUTPUT_DIR, TARGET_SRC_DIR } from '../config.js';
import { GLOBAL_INDEX } from './state.js';

const EMBEDDING_MODEL = 'gemini-embedding-001'; // v1beta 可用模型
const BATCH_SIZE = 100;          // Gemini batchEmbedContents 最大 100 条
const RATE_LIMIT_DELAY_MS = 1200; // 批次间基础延迟（~50 batch/min，留出 QPS 余量）
const SAVE_EVERY = 500;         // 每处理 N 个 symbol 写一次盘（断点续传）
const MAX_DIMS = 768;           // 截取前 N 维：3072→768，4x 压缩，检索质量损失 <5%

const VERSION_KEY = '__version__';

/**
 * 从 skeleton 文件中提取指定行号附近的签名文本（约 8 行）
 * 用于生成有意义的 symbol embedding
 */
const MAX_EMBED_CHARS = 1500; // Gemini embedding 上限约 2048 token，保守截断

function extractSymbolContext(skeletonPath: string, lineNumber: number, symbolName: string, relFilePath: string): string {
    try {
        if (fs.existsSync(skeletonPath)) {
            const lines = fs.readFileSync(skeletonPath, 'utf-8').split('\n');
            const start = Math.max(0, lineNumber - 1);
            const end = Math.min(lines.length, start + 8);
            const snippet = lines.slice(start, end).join('\n').trim();
            const full = `symbol: ${symbolName}\nfile: ${relFilePath}\n${snippet}`;
            return full.length > MAX_EMBED_CHARS ? full.slice(0, MAX_EMBED_CHARS) : full;
        }
    } catch { /* ignore */ }
    return `symbol: ${symbolName}\nfile: ${relFilePath}`;
}

/**
 * 加载 embedding 缓存，若版本不匹配则清空
 */
function loadCache(): Record<string, number[]> {
    if (!fs.existsSync(EMBEDDING_CACHE_FILE)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(EMBEDDING_CACHE_FILE, 'utf-8'));
        if (raw[VERSION_KEY] !== EMBEDDING_VERSION) {
            console.error(`⚡ Embedding version changed, clearing embedding cache.`);
            return {};
        }
        const { [VERSION_KEY]: _, ...rest } = raw;
        return rest as Record<string, number[]>;
    } catch {
        return {};
    }
}

function saveCache(cache: Record<string, number[]>) {
    const data = { [VERSION_KEY]: EMBEDDING_VERSION, ...cache };
    fs.writeFileSync(EMBEDDING_CACHE_FILE, JSON.stringify(data));
}

/**
 * 批量调用 Gemini text-embedding-004，带简单指数退避重试
 */
/** 从 429 错误信息中解析 API 建议的 retryDelay（秒） */
function parseRetryDelay(errMessage: string): number {
    const match = errMessage.match(/retry[^\d]*(\d+(?:\.\d+)?)\s*s/i);
    return match ? Math.ceil(parseFloat(match[1])) * 1000 : 0;
}

async function batchEmbed(model: any, texts: string[]): Promise<number[][]> {
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const result = await model.batchEmbedContents({
                requests: texts.map(text => ({
                    content: { parts: [{ text }], role: 'user' },
                    taskType: 'RETRIEVAL_DOCUMENT',
                })),
            });
            return result.embeddings.map((e: any) => (e.values as number[]).slice(0, MAX_DIMS));
        } catch (e: any) {
            if (attempt < maxRetries - 1) {
                // 429: 使用 API 返回的 retryDelay，否则指数退避
                const suggested = e?.message ? parseRetryDelay(e.message) : 0;
                const delay = suggested > 0 ? suggested + 1000 : 5000 * Math.pow(2, attempt);
                console.error(`⚠️ Embedding batch failed (attempt ${attempt + 1}), retrying in ${Math.round(delay / 1000)}s: ${e?.message?.slice(0, 120)}`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw e;
            }
        }
    }
    return [];
}

/**
 * 主入口：扫描所有 mapping.json，为每个 symbol 计算 embedding（增量）
 * 结果写入 EMBEDDING_CACHE_FILE 并加载到 GLOBAL_INDEX.embeddings
 */
export async function computeAllEmbeddings(): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('⚠️ GEMINI_API_KEY not set, skipping embedding computation.');
        return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

    const cache = loadCache();
    const mappingFiles = globSync('**/*.mapping.json', { cwd: OUTPUT_DIR, absolute: true, ignore: ['_analysis/**'] });

    // 收集需要计算的 (key, text) 对
    const todo: Array<{ key: string; text: string }> = [];

    for (const mFile of mappingFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(mFile, 'utf-8'));
            const sourcePath: string = data.sourcePath;
            const relPath = sourcePath.split('Rocket.Chat/')[1] || sourcePath;
            const rel = path.relative(TARGET_SRC_DIR, sourcePath).replace(/\.tsx?$/, '');
            const skeletonPath = path.join(OUTPUT_DIR, rel + '.skeleton.ts');

            for (const sym of (data.symbols ?? [])) {
                if (!sym.name) continue;
                const key = `${sym.name}@${sourcePath}`;
                if (cache[key]) continue; // 已有缓存，跳过

                const text = extractSymbolContext(skeletonPath, sym.line ?? 1, sym.name, relPath);
                todo.push({ key, text });
            }
        } catch { /* ignore bad mapping files */ }
    }

    if (todo.length === 0) {
        console.error('✅ Embeddings up to date, loading from cache.');
        loadEmbeddingsIntoIndex(cache);
        return;
    }

    console.error(`🧮 Computing embeddings for ${todo.length} symbols (batch size ${BATCH_SIZE})...`);
    console.error(`   ⏸  Safe to Ctrl+C at any time — progress is saved every ${SAVE_EVERY} symbols.`);
    let processed = 0;

    // 断点保护：SIGINT 时先写盘再退出
    const onInterrupt = () => {
        console.error('\n⏸  Interrupted — saving embedding progress...');
        saveCache(cache);
        console.error(`✅ Saved ${Object.keys(cache).length} embeddings. Resume anytime.`);
        process.exit(0);
    };
    process.once('SIGINT', onInterrupt);

    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        const batch = todo.slice(i, i + BATCH_SIZE);
        try {
            const vectors = await batchEmbed(model, batch.map(b => b.text));
            for (let j = 0; j < batch.length; j++) {
                if (vectors[j]) cache[batch[j].key] = vectors[j];
            }
            processed += batch.length;
        } catch (e: any) {
            console.error(`❌ Embedding batch failed permanently: ${e?.message}`);
        }

        // saveCache 移到 try 块外，避免序列化错误被误报为 batch 失败
        const shouldSave = processed % SAVE_EVERY === 0 || i + BATCH_SIZE >= todo.length;
        if (shouldSave) {
            console.error(`  ${processed}/${todo.length} symbols embedded...`);
            try {
                saveCache(cache);
            } catch (e: any) {
                console.error(`⚠️ Failed to save embedding cache: ${e?.message}`);
            }
        }

        if (i + BATCH_SIZE < todo.length) {
            await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
        }
    }

    process.removeListener('SIGINT', onInterrupt);
    saveCache(cache);
    loadEmbeddingsIntoIndex(cache);
    console.error(`✨ Embeddings ready: ${Object.keys(cache).length} symbols indexed.`);
}

/**
 * 将 embedding 缓存加载进内存索引（不重新计算）
 */
export function loadEmbeddingsIntoIndex(cache?: Record<string, number[]>) {
    const data = cache ?? loadCache();
    GLOBAL_INDEX.embeddings.clear();
    for (const [key, vec] of Object.entries(data)) {
        if (key !== VERSION_KEY) GLOBAL_INDEX.embeddings.set(key, vec);
    }
    if (GLOBAL_INDEX.embeddings.size > 0) {
        console.error(`📐 Loaded ${GLOBAL_INDEX.embeddings.size} symbol embeddings into index.`);
    }
}

/**
 * 计算单个文本的 embedding（用于 query 时实时计算）
 */
export async function embedQuery(text: string): Promise<number[] | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
        const result = await model.embedContent({
            content: { parts: [{ text }], role: 'user' },
            taskType: 'RETRIEVAL_QUERY',
        } as any);
        return (result.embedding.values as number[]).slice(0, MAX_DIMS);
    } catch {
        return null;
    }
}

/**
 * 余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
