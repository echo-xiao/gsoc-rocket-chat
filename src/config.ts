import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 项目根目录（src/ 或 dist/ 的上一层）
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Rocket.Chat 源码根目录
export const TARGET_SRC_DIR = path.join(PROJECT_ROOT, 'Rocket.Chat');
// 所有生成产物输出目录（skeleton / mapping / index）
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
// 增量哈希缓存文件
export const CACHE_FILE = path.join(OUTPUT_DIR, '.hash_cache.json');
// Embedding 缓存文件（symbol embedding vectors）
export const EMBEDDING_CACHE_FILE = path.join(OUTPUT_DIR, '.embedding_cache.json');
// Skeleton 生成器版本：skeleton.ts 逻辑有变化时递增，触发全量重建
export const GENERATOR_VERSION = '7';
// Embedding 版本：embedder.ts 逻辑有变化时递增，触发全量重新计算
export const EMBEDDING_VERSION = '2'; // 768-dim truncated embeddings
// 日志目录
export const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

/**
 * 根据源文件绝对路径，计算对应的 output 层次路径。
 * 例如: Rocket.Chat/apps/meteor/server/lib/foo.ts
 *   → output/apps/meteor/server/lib/foo.skeleton.ts
 *   → output/apps/meteor/server/lib/foo.mapping.json
 */
export function getOutputPaths(sourceFile: string): { skeletonPath: string; mappingPath: string } {
    const rel = path.relative(TARGET_SRC_DIR, sourceFile).replace(/\.tsx?$/, '');
    return {
        skeletonPath: path.join(OUTPUT_DIR, rel + '.skeleton.ts'),
        mappingPath: path.join(OUTPUT_DIR, rel + '.mapping.json'),
    };
}
