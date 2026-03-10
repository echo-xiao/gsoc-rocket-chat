import Graph from 'graphology';
import graphologyMetrics from 'graphology-metrics';
const pagerank = graphologyMetrics.centrality.pagerank;

/**
 * 核心逻辑：
 * 1. 节点 (Node)：代码文件 或 具体的 Symbol
 * 2. 边 (Edge)：Import 关系 (A 引用 B，则 B 获得来自 A 的权重投递)
 */
export class CentralityAnalyzer {
    static compute(globalIndex: any): Map<string, number> {
        const graph = new Graph({ directed: true });

        console.error("🕸️  Building Dependency Graph...");

        // 1. 添加所有文件作为节点
        globalIndex.allFiles.forEach((file: string) => {
            if (!graph.hasNode(file)) graph.addNode(file);
        });

        // 2. 添加引用边 (File-level Topology)
        // 注意：在 PageRank 中，被引用的次数越多，权重越高
        globalIndex.fileDependents.forEach((dependents: Set<string>, providerPath: string) => {
            if (!graph.hasNode(providerPath)) graph.addNode(providerPath);

            dependents.forEach(depPath => {
                if (!graph.hasNode(depPath)) graph.addNode(depPath);
                // A import B => 建立 A -> B 的边，B 的 PageRank 会升高
                if (!graph.hasEdge(depPath, providerPath)) {
                    graph.addEdge(depPath, providerPath);
                }
            });
        });

        // 3. 运行 PageRank 算法
        // d (damping factor) 通常取 0.85
        console.error("🧮 Running PageRank algorithm...");
        const fileScores = pagerank(graph, { attributes: { centrality: 'pagerank' } });

        // 4. 将文件权重映射回 Symbol
        const symbolWeights = new Map<string, number>();
        globalIndex.symbols.forEach((paths: Set<string>, symbolName: string) => {
            let maxScore = 0;
            paths.forEach(p => {
                const score = fileScores[p] || 0;
                if (score > maxScore) maxScore = score;
            });
            symbolWeights.set(symbolName, maxScore);
        });

        return symbolWeights;
    }
}