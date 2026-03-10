export enum SearchIntent {
    DEFINITION = "definition",    // 找定义（在哪，是什么）
    IMPLEMENTATION = "implementation", // 找实现（怎么写，逻辑）
    UNKNOWN = "unknown"
}

export class CodeReranker {
    /**
     * 意图识别：分析用户 Query 的关键词
     */
    private static detectIntent(query: string): SearchIntent {
        const q = query.toLowerCase();
        if (q.includes("where") || q.includes("what is") || q.includes("define")) {
            return SearchIntent.DEFINITION;
        }
        if (q.includes("how") || q.includes("implement") || q.includes("logic") || q.includes("work")) {
            return SearchIntent.IMPLEMENTATION;
        }
        return SearchIntent.UNKNOWN;
    }

    /**
     * 精排重排逻辑
     */
    static rerank(query: string, candidates: any[]): any[] {
        const intent = this.detectIntent(query);

        return candidates.map(cand => {
            let intentBonus = 0;

            // 根据意图动态调权
            if (intent === SearchIntent.DEFINITION) {
                // 如果是找定义，偏向于底层核心（PageRank 权重高的）
                intentBonus = cand.centrality * 2.0;
            } else if (intent === SearchIntent.IMPLEMENTATION) {
                // 如果是找实现，偏向于业务逻辑（这里可以结合文件名关键词，如 controller/service）
                const isLogicFile = /service|controller|handler/i.test(cand.paths[0]);
                intentBonus = isLogicFile ? 0.5 : 0;
            }

            // 最终得分公式：相似度得分 + 权重分 + 意图加成
            const finalScore = cand.score + intentBonus;

            return { ...cand, finalScore, intentDetected: intent };
        })
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, 5); // 只保留最精准的 Top 5
    }
}