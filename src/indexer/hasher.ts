import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GENERATOR_VERSION } from '../config.js';

const VERSION_KEY = '__version__';

export class CodebaseHasher {
    private cachePath: string;
    private hashCache: Record<string, string>;

    constructor(cachePath: string) {
        this.cachePath = cachePath;
        if (fs.existsSync(cachePath)) {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            if (cached[VERSION_KEY] === GENERATOR_VERSION) {
                this.hashCache = cached;
            } else {
                console.error(`⚡ Generator version changed (${cached[VERSION_KEY] ?? 'none'} → ${GENERATOR_VERSION}), clearing hash cache.`);
                this.hashCache = {};
            }
        } else {
            this.hashCache = {};
        }
    }

    /**
     * 获取文件哈希
     */
    static getFileHash(filePath: string): string {
        const buffer = fs.readFileSync(filePath);
        return crypto.createHash('md5').update(buffer).digest('hex');
    }

    /**
     * 检查是否需要更新
     */
    shouldUpdate(filePath: string): { needsUpdate: boolean, currentHash: string } {
        const currentHash = CodebaseHasher.getFileHash(filePath);
        const oldHash = this.hashCache[filePath];
        return {
            needsUpdate: oldHash !== currentHash,
            currentHash
        };
    }

    /**
     * 更新缓存记录
     */
    updateRecord(filePath: string, hash: string) {
        this.hashCache[filePath] = hash;
    }

    /**
     * 清理已经不存在的文件记录，防止缓存膨胀
     */
    prune(allScannedFiles: string[]) {
        const currentFiles = new Set(allScannedFiles);
        let deletedCount = 0;
        for (const cachedFile in this.hashCache) {
            if (cachedFile === VERSION_KEY) continue;
            if (!currentFiles.has(cachedFile)) {
                delete this.hashCache[cachedFile];
                deletedCount++;
            }
        }
        if (deletedCount > 0) {
            console.error(`🧹 Pruned ${deletedCount} obsolete records from cache.`);
        }
    }

    /**
     * 持久化到磁盘
     */
    save() {
        this.hashCache[VERSION_KEY] = GENERATOR_VERSION;
        fs.writeFileSync(this.cachePath, JSON.stringify(this.hashCache, null, 2));
    }
}