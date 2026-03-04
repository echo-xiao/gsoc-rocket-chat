import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Project, Node } from 'ts-morph';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cliProgress from 'cli-progress';
import { execFileSync } from 'child_process';

// ============================================================================
// 1. Path, Configuration & Model Routing
// ============================================================================
const TARGET_SRC_DIR = path.resolve('./Rocket.Chat/apps/meteor');
const OUTPUT_DIR = path.resolve('./output');
const CACHE_FILE = path.join(OUTPUT_DIR, '.hash_cache.json');
const ROUTING_CONFIG_PATH = path.resolve('./.gemini/routing_config.json');
const routingData = fs.existsSync(ROUTING_CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(ROUTING_CONFIG_PATH, 'utf-8'))
    : { routing: {}, tool_assignments: {} };


const GLOBAL_INDEX = {
    symbols: new Map<string, Set<string>>(),       // 符号名 -> 定义它的绝对路径集合
    fileDependents: new Map<string, Set<string>>(), // 文件路径 -> 哪些文件 import 了它 (用于 BFS)
    allFiles: new Set<string>()
};

function resolveRocketChatPath(currentFilePath: string, importModule: string): string {
    if (importModule.startsWith('meteor/')) return `meteor-internal:${importModule.replace('meteor/', '')}`;
    if (importModule.startsWith('@rocket.chat/')) return path.resolve('./Rocket.Chat/packages', importModule.replace('@rocket.chat/', ''));
    if (importModule.startsWith('.')) {
        const resolved = path.resolve(path.dirname(currentFilePath), importModule);
        return fs.existsSync(`${resolved}.ts`) ? `${resolved}.ts` : resolved;
    }
    return importModule;
}

function getFileHash(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('md5');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

// ============================================================================
// 2. AST-Mutation Skeleton Generator (Based on ts-morph node manipulation)
// ============================================================================
class AstMutationGenerator {
    static generate(filePath: string): { skeleton: string, mapping: any } {
        const project = new Project();
        const sourceFile = project.addSourceFileAtPath(filePath);

        const mapping: any = {
            sourcePath: path.resolve(filePath),
            fileName: path.basename(filePath),
            imports: [],
            symbols: []
        };

        // Extract Import relationships (for topology graph and reference tracking)
        sourceFile.getImportDeclarations().forEach(imp => {
            const module = imp.getModuleSpecifierValue();
            const resolved = resolveRocketChatPath(filePath, module);
            mapping.imports.push({ module, resolved });
        });

        // 1. Process standard functions
        sourceFile.getFunctions().forEach(fn => {
            const name = fn.getName();
            if (name && fn.getBody()) {
                mapping.symbols.push({ type: 'function', name });
                fn.setBodyText('\n    /* [GSOC-REDUCTION]: Implementation omitted. */\n');
            }
        });

        // 2. Process functions defined via variables (arrow functions/function expressions)
        sourceFile.getVariableDeclarations().forEach(decl => {
            const initializer = decl.getInitializer();
            if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
                const body = (initializer as any).getBody();
                if (body && Node.isBlock(body)) {
                    const name = decl.getName();
                    mapping.symbols.push({ type: 'variable_function', name });
                    (initializer as any).setBodyText('\n    /* [GSOC-REDUCTION]: Implementation omitted. */\n');
                }
            }
        });

        // 3. Process classes and methods
        sourceFile.getClasses().forEach(cls => {
            const className = cls.getName();
            if (className) mapping.symbols.push({ type: 'class', name: className });

            cls.getMethods().forEach(method => {
                const body = method.getBody();
                if (body && Node.isBlock(body)) {
                    const methodName = method.getName();
                    mapping.symbols.push({ type: 'method', name: `${className}.${methodName}` });
                    method.setBodyText('\n    /* [GSOC-REDUCTION]: Implementation omitted. */\n');
                }
            });
        });

        return { skeleton: sourceFile.getFullText(), mapping };
    }
}

// ============================================================================
// 3. Pre-warming System (Incremental Hashing)
// ============================================================================
function preWarmWithProgress() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    let hashCache: Record<string, string> = {};
    if (fs.existsSync(CACHE_FILE)) {
        hashCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }

    const allFiles: string[] = [];
    const scan = (d: string) => {
        if (!fs.existsSync(d)) return;
        fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory() && !['node_modules', 'dist', '.git', 'tests'].includes(e.name)) scan(p);
            else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) allFiles.push(p);
        });
    };
    scan(TARGET_SRC_DIR);

    const bar = new cliProgress.SingleBar({
        format: '🚀 Incremental Dehydration |{bar}| {percentage}% || {value}/{total} files',
        barCompleteChar: '\u2588', barIncompleteChar: '\u2591',
        stream: process.stderr
    });

    bar.start(allFiles.length, 0);
    let updatedCount = 0;

    allFiles.forEach((f, i) => {
        try {
            const currentHash = getFileHash(f);
            if (hashCache[f] !== currentHash) {
                const { skeleton, mapping } = AstMutationGenerator.generate(f);
                const base = path.basename(f, '.ts');
                fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.skeleton.ts`), skeleton);
                fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.mapping.json`), JSON.stringify(mapping, null, 2));
                hashCache[f] = currentHash;
                updatedCount++;
            }
        } catch (e) {
            // Ignore file errors caused by AST parsing exceptions
        }
        bar.update(i + 1);
    });
    bar.stop();

    fs.writeFileSync(CACHE_FILE, JSON.stringify(hashCache, null, 2));
    console.error(`✨ Incremental update complete. Updated ${updatedCount} files.`);
}



    // 2. 修正初始化函数 (处理 TS2339 & TS2345)
    function initializeGlobalIndex() {
        console.error("🧠 Building memory index...");
        if (!fs.existsSync(OUTPUT_DIR)) return;

        const mappings = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mapping.json'));
        mappings.forEach(mFile => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, mFile), 'utf-8'));
                const sourcePath = data.sourcePath;
                GLOBAL_INDEX.allFiles.add(sourcePath);

                // 索引符号定义 (使用 Set 方法)
                data.symbols?.forEach((s: any) => {
                    if (!GLOBAL_INDEX.symbols.has(s.name)) {
                        GLOBAL_INDEX.symbols.set(s.name, new Set());
                    }
                    GLOBAL_INDEX.symbols.get(s.name)!.add(sourcePath);
                });

                // 建立文件级拓扑依赖图 (用于 find_references 的 BFS 剪枝)
                data.imports?.forEach((imp: any) => {
                    if (imp.resolved && imp.resolved !== 'unknown') {
                        if (!GLOBAL_INDEX.fileDependents.has(imp.resolved)) {
                            GLOBAL_INDEX.fileDependents.set(imp.resolved, new Set());
                        }
                        GLOBAL_INDEX.fileDependents.get(imp.resolved)!.add(sourcePath);
                    }
                });
            } catch (e) {
                console.error(`❌ Failed to load index ${mFile}:`, e);
            }
        });
        console.error(`✅ Index buildup complete: ${GLOBAL_INDEX.symbols.size} symbols, ${GLOBAL_INDEX.fileDependents.size} topology edges.`);
    }



// ============================================================================
// 4. MCP Tools Exposure
// ============================================================================
const server = new Server(
    { name: "rocket-chat-gsoc-analyzer", version: "5.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Helper function: Dynamically generate descriptions with model tags based on external config
    const getDesc = (toolName: string, baseDesc: string) => {
        const type = routingData.tool_assignments?.[toolName] || "standard";
        const modelName = routingData.routing?.[type] || "gemini-2.5-flash"; // fallback
        return `[Routing: ${modelName}] ${baseDesc}`;
    };

    return {
        tools: [
            {
                name: "get_system_config",
                description: getDesc("get_system_config", "Retrieve the system configuration and LLM routing rules."),
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "search_mcp_prewarm_cache",
                description: getDesc("search_mcp_prewarm_cache", "CRITICAL: Search for file/directory paths in the lightning-fast prewarm cache. DO NOT use built-in find tools."),
                inputSchema: {
                    type: "object",
                    properties: {
                        keyword: { type: "string", description: "Directory or file keyword, e.g., 'app/lib/server/functions'." }
                    },
                    required: ["keyword"]
                }
            },
            {
                name: "search_symbol",
                description: getDesc("search_symbol", "Quickly locate the exact file path where a specific symbol is defined."),
                inputSchema: {
                    type: "object",
                    properties: { query: { type: "string", description: "The exact name of the symbol." } },
                    required: ["query"]
                }
            },
            {
                name: "find_references",
                description: getDesc("find_references", "Find all files that import or depend on a specific module or symbol."),
                inputSchema: {
                    type: "object",
                    properties: { targetModuleOrSymbol: { type: "string", description: "The target module/symbol name." } },
                    required: ["targetModuleOrSymbol"]
                }
            },
            {
                name: "get_codebase_topology",
                description: getDesc("get_codebase_topology", "Read the global dependency topology. Supports JSON or Mermaid format."),
                inputSchema: {
                    type: "object",
                    properties: { format: { type: "string", enum: ["json", "mermaid"] } }
                }
            },
            {
                name: "get_file_skeleton",
                description: getDesc("get_file_skeleton", "View zero-bloat, stripped-down skeleton code to understand exported structures."),
                inputSchema: {
                    type: "object",
                    properties: { filename: { type: "string", description: "The exact file path." } },
                    required: ["filename"]
                }
            },
            {
                name: "read_symbol_details",
                description: getDesc("read_symbol_details", "CRITICAL PROBE: Read the actual, detailed implementation logic of a symbol. Required for complex logic analysis."),
                inputSchema: {
                    type: "object",
                    properties: {
                        filename: { type: "string", description: "The exact file path." },
                        symbolName: { type: "string", description: "The function or class name." },
                        startLine: { type: "number", description: "Line number to start reading from (for pagination)." }
                    },
                    required: ["filename", "symbolName"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const mappings = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mapping.json'));

    if (name === "get_system_config") {
        return { content: [{ type: "text", text: JSON.stringify(routingData, null, 2) }] };
    }

    if (name === "search_mcp_prewarm_cache") {
        const { keyword } = args as any;
        if (!fs.existsSync(OUTPUT_DIR)) return { content: [{ type: "text", text: "Cache directory not found." }] }; // 防止目录缺失崩溃

        const results = mappings
            .map(m => {
                try {
                    // 增加 try-catch 防止坏文件导致整机崩溃
                    return JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, m), 'utf-8')).sourcePath;
                } catch (e) {
                    return null;
                }
            })
            .filter(p => p && p.toLowerCase().includes(keyword.toLowerCase()));

        return { content: [{ type: "text", text: results.join('\n') || "No matching files found." }] };
    }

    if (name === "find_references") {
        const { targetModuleOrSymbol } = args as any;
        const sanitizedQuery = targetModuleOrSymbol.replace(/[^a-zA-Z0-9_.-]/g, '');
        const LIMIT = 15;

        // 1. 确定符号定义的原始文件（从内存索引读取）
        const originFiles = Array.from(GLOBAL_INDEX.symbols.get(sanitizedQuery) || []);
        if (originFiles.length === 0) {
            return { content: [{ type: "text", text: `未找到 "${targetModuleOrSymbol}" 的定义源。` }] };
        }

        // 2. BFS 拓扑剪枝：只检查可能 import 了这些源文件的文件
        const candidateFiles = new Set<string>(originFiles);
        const queue = [...originFiles];
        const visited = new Set<string>(queue);

        while (queue.length > 0) {
            const currentFile = queue.shift()!;
            const dependents = GLOBAL_INDEX.fileDependents.get(currentFile) || new Set<string>();
            for (const dep of dependents) {
                if (!visited.has(dep)) {
                    visited.add(dep);
                    queue.push(dep);
                    candidateFiles.add(dep);
                }
            }
        }

        // 3. 正则匹配并返回结果
        const actualReferences: string[] = [];
        const regex = new RegExp(`\\b${sanitizedQuery}\\b`);

        for (const filePath of candidateFiles) {
            if (!fs.existsSync(filePath)) continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            if (regex.test(content)) {
                actualReferences.push(path.relative(process.cwd(), filePath));
            }
        }

        const results = actualReferences.slice(0, LIMIT);
        let responseText = `找到 ${actualReferences.length} 处引用。显示前 ${results.length} 处：\n- ${results.join('\n- ')}`;

        if (actualReferences.length > LIMIT) {
            responseText += `\n\n⚠️ 结果过多，已截断以节省 Token。`;
        }

        return { content: [{ type: "text", text: responseText }] };
    }




    if (name === "get_codebase_topology") {
        const { format } = args as any;
        const data = mappings.map(m => JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, m), 'utf-8')));

        if (format === 'mermaid') {
            let mermaidGraph = "graph TD;\n";
            data.forEach(node => {
                const sourceBase = path.basename(node.sourcePath, '.ts');
                node.imports?.forEach((imp: any) => {
                    const targetBase = path.basename(imp.resolved, '.ts');
                    mermaidGraph += `  ${sourceBase} --> ${targetBase};\n`;
                });
            });
            return { content: [{ type: "text", text: mermaidGraph }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "get_file_skeleton") {
        const { filename } = args as any;
        const file = path.join(OUTPUT_DIR, `${path.basename(filename, '.ts')}.skeleton.ts`);
        return fs.existsSync(file) ? { content: [{ type: "text", text: fs.readFileSync(file, 'utf-8') }] } : { content: [{ type: "text", text: "Skeleton file not found." }], isError: true };
    }

    if (name === "search_symbol") {
        const { query } = args as any;
        const sanitizedQuery = query.replace(/[^a-zA-Z0-9_.-]/g, ''); // 安全过滤
        const LIMIT = 15;

        try {
            // 1. 使用 Grep 快速锁定可能包含定义的文件路径
            const grepResults = execFileSync('grep', [
                '-rl',
                '--include=*.ts',
                '--include=*.tsx',
                sanitizedQuery,
                '.'
            ], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 });

            const candidateFiles = grepResults.split('\n').filter(Boolean);
            const definitionFiles: string[] = [];

            // 2. 只对这些文件进行 AST 精确匹配
            const project = new Project({ skipAddingFilesFromTsConfig: true });

            for (const relPath of candidateFiles.slice(0, 50)) { // 限制验身文件数防止超时
                const absPath = path.resolve(process.cwd(), relPath);
                if (!fs.existsSync(absPath)) continue;

                const sourceFile = project.addSourceFileAtPath(absPath);

                // 精准判定是否为定义（而非调用）
                const isDefinedHere =
                    sourceFile.getFunction(sanitizedQuery) ||
                    sourceFile.getVariableDeclaration(sanitizedQuery) ||
                    sourceFile.getClass(sanitizedQuery) ||
                    sourceFile.getInterface(sanitizedQuery);

                if (isDefinedHere) {
                    definitionFiles.push(relPath);
                }

                sourceFile.forget(); // 释放内存
            }

            if (definitionFiles.length === 0) {
                return { content: [{ type: "text", text: `Keyword "${query}" found, but no explicit definition identified.` }] };
            }

            const results = definitionFiles.slice(0, LIMIT);
            return { content: [{ type: "text", text: `✅ Defined in:\n- ${results.join('\n- ')}` }] };

        } catch (e: any) {
            if (e.status === 1) return { content: [{ type: "text", text: "Symbol not found." }] };
            return { content: [{ type: "text", text: `Search failed: ${e.message}`, isError: true }] };
        }
    }

    if (name === "read_symbol_details") {
        const { filename, symbolName, startLine = 0 } = args as any;
        const mapFile = path.join(OUTPUT_DIR, `${path.basename(filename, '.ts')}.mapping.json`);
        if (!fs.existsSync(mapFile)) return { content: [{ type: "text", text: "Unable to locate mapping file." }], isError: true };

        const sourcePath = JSON.parse(fs.readFileSync(mapFile, 'utf-8')).sourcePath;
        const project = new Project();
        const sourceFile = project.addSourceFileAtPath(sourcePath);
        const node = sourceFile.getFunction(symbolName) || sourceFile.getClass(symbolName) || sourceFile.getVariableDeclaration(symbolName);

        if (!node) return { content: [{ type: "text", text: "Specified Symbol not found." }] };

        const PAGE_SIZE = 50;
        const fullTextLines = node.getText().split('\n');
        const chunk = fullTextLines.slice(startLine, startLine + PAGE_SIZE).join('\n');
        const totalLines = fullTextLines.length;

        let responseText = `/* --- PRO MODE DETAILED LOGIC (Lines ${startLine} to ${Math.min(startLine + PAGE_SIZE, totalLines)} of ${totalLines}) --- */\n${chunk}\n`;

        if (startLine + PAGE_SIZE < totalLines) {
            responseText += `\n/* ⚠️ Code truncated. More content remains. Call tool with startLine=${startLine + PAGE_SIZE} to read the next 50 lines. */`;
        }

        return { content: [{ type: "text", text: responseText }] };
    }

    throw new Error("Tool not found");
});

async function main() {
    const isForceSync = process.argv.includes('--force');

    if (isForceSync) {
        console.error("🧹 [Force Refresh] Cleaning old artifacts...");
        if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }

    // 顺序：先执行增量预热生成文件，再加载进内存索引
    preWarmWithProgress();
    initializeGlobalIndex();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 [GSOC-EXTENSION] Ready.");
}

// 必须显式调用 main 才能让程序跑起来
main().catch((err) => {
    console.error("Fatal error during startup:", err);
    process.exit(1);
});