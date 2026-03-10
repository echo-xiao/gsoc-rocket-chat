import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from 'fs';
import * as path from 'path';

// 假设使用简单的余弦相似度进行内存检索，或者集成 HNSW
export class CodeVectorStore {
    private model: any;
    private vectors: Map<string, { vector: number[], metadata: any }> = new Map();

    constructor(apiKey: string) {
        const genAI = new GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({ model: "text-embedding-004" });
    }

    /**
     * 将代码符号转化为向量并存储
     * 这里建议存储脱水后的 Skeleton，因为原始源码太长且噪声多
     */
    async addSymbol(symbolName: string, skeleton: string, filePath: string) {
        try {
            // 对符号名 + 骨架进行 Embedding
            const textToEmbed = `Symbol: ${symbolName}\nContext: ${skeleton.slice(0, 1000)}`;
            const result = await this.model.embedContent(textToEmbed);
            const vector = result.embedding.values;

            this.vectors.set(symbolName, {
                vector,
                metadata: { symbolName, filePath }
            });
        } catch (e) {
            console.error(`❌ Embedding failed for ${symbolName}:`, e);
        }
    }

    /**
     * 语义搜索：根据 Query 寻找最接近的符号
     */
    async search(query: string, limit: number = 5) {
        const queryResult = await this.model.embedContent(query);
        const queryVector = queryResult.embedding.values;

        const results = Array.from(this.vectors.values()).map(item => ({
            ...item.metadata,
            similarity: this.cosineSimilarity(queryVector, item.vector)
        }));

        // 按相似度排序
        return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
        const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
        const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
        return dotProduct / (magA * magB);
    }

    /**
     * 持久化向量数据
     */
    save(outputPath: string) {
        const data = Array.from(this.vectors.entries());
        fs.writeFileSync(outputPath, JSON.stringify(data));
    }
}