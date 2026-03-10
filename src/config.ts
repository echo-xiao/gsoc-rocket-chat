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
// 日志目录
export const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
// 分析产物目录（read_symbol_details 生成的 .md 文件）
export const ANALYSIS_DIR = path.join(OUTPUT_DIR, '_analysis');

/**
 * 根据源文件绝对路径，计算对应的 output 层次路径。
 * 例如: Rocket.Chat/apps/meteor/server/lib/foo.ts
 *   → output/apps/meteor/server/lib/foo.skeleton.ts
 *   → output/apps/meteor/server/lib/foo.mapping.json
 */
export function getOutputPaths(sourceFile: string): { skeletonPath: string; mappingPath: string } {
    const rel = path.relative(TARGET_SRC_DIR, sourceFile).replace(/\.ts$/, '');
    return {
        skeletonPath: path.join(OUTPUT_DIR, rel + '.skeleton.ts'),
        mappingPath: path.join(OUTPUT_DIR, rel + '.mapping.json'),
    };
}
