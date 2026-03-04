"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
var stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
var types_js_1 = require("@modelcontextprotocol/sdk/types.js");
var ts_morph_1 = require("ts-morph");
var fs = require("fs");
var path = require("path");
var cliProgress = require("cli-progress");
// ============================================================================
// 1. Path and Configuration
// ============================================================================
var ROOT_DIR = path.resolve('./Rocket.Chat');
var OUTPUT_DIR = path.resolve('./output');
function getSafeFilename(sourcePath) {
    return path.relative(ROOT_DIR, sourcePath).replace(/[/\\]/g, '___').replace(/\.ts$/, '');
}
function resolveRocketChatPath(currentFilePath, importModule) {
    if (importModule.startsWith('meteor/')) {
        return "meteor-internal:".concat(importModule.replace('meteor/', ''));
    }
    if (importModule.startsWith('@rocket.chat/')) {
        return path.resolve(ROOT_DIR, 'packages', importModule.replace('@rocket.chat/', ''));
    }
    if (importModule.startsWith('.')) {
        var resolved = path.resolve(path.dirname(currentFilePath), importModule);
        return fs.existsSync("".concat(resolved, ".ts")) ? "".concat(resolved, ".ts") : resolved;
    }
    return importModule;
}
// ============================================================================
// 2. Normal Codebase Indexer (Only mapping, no more weird skeleton strings)
// ============================================================================
var CodebaseIndexer = /** @class */ (function () {
    function CodebaseIndexer() {
    }
    CodebaseIndexer.index = function (filePath) {
        var project = new ts_morph_1.Project();
        var sourceFile = project.addSourceFileAtPath(filePath);
        var mapping = { sourcePath: filePath, imports: [], symbols: [] };
        // 1. 提取依赖关系 (用于拓扑图)
        sourceFile.getImportDeclarations().forEach(function (imp) {
            var module = imp.getModuleSpecifierValue();
            mapping.imports.push(resolveRocketChatPath(filePath, module));
        });
        // 2. 提取导出的符号名 (用于搜索定位，不改变代码实体)
        sourceFile.getFunctions().forEach(function (fn) {
            var name = fn.getName();
            if (name && fn.isExported())
                mapping.symbols.push({ name: name, type: 'function' });
        });
        sourceFile.getClasses().forEach(function (cls) {
            var className = cls.getName();
            if (className && cls.isExported()) {
                mapping.symbols.push({ name: className, type: 'class' });
                cls.getMethods().forEach(function (m) {
                    mapping.symbols.push({ name: "".concat(className, ".").concat(m.getName()), type: 'method' });
                });
            }
        });
        return mapping;
    };
    return CodebaseIndexer;
}());
// ============================================================================
// 3. Pre-warming System Startup
// ============================================================================
function preWarmWithProgress() {
    if (!fs.existsSync(OUTPUT_DIR))
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    var allFiles = [];
    var scan = function (d) {
        if (!fs.existsSync(d))
            return;
        fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
            var p = path.join(d, e.name);
            if (e.isDirectory() && !['node_modules', 'dist', '.git', 'tests', 'build'].includes(e.name))
                scan(p);
            else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts'))
                allFiles.push(p);
        });
    };
    scan(ROOT_DIR);
    var bar = new cliProgress.SingleBar({
        format: '🚀 Rocket.Chat Indexing Progress |' + '{bar}' + '| {percentage}% || {value}/{total} 文件',
        barCompleteChar: '\u2588', barIncompleteChar: '\u2591'
    });
    bar.start(allFiles.length, 0);
    allFiles.forEach(function (f, i) {
        try {
            // 现在只生成轻量级的 JSON mapping，抛弃了容易出错的 skeleton.ts
            var mapping = CodebaseIndexer.index(f);
            var safeName = getSafeFilename(f);
            fs.writeFileSync(path.join(OUTPUT_DIR, "".concat(safeName, ".mapping.json")), JSON.stringify(mapping));
        }
        catch (_a) { }
        bar.update(i + 1);
    });
    bar.stop();
}
// ============================================================================
// 4. MCP Tool Exposure (Clean & Standard Tools)
// ============================================================================
var server = new index_js_1.Server({ name: "rocket-chat-gsoc-analyzer", version: "4.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(types_js_1.ListToolsRequestSchema, function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        return [2 /*return*/, ({
                tools: [
                    {
                        name: "get_local_topology",
                        description: "Retrieve the dependency topology starting from a specific entry file up to a defined depth.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                entryFile: { type: "string", description: "The filename or path to start tracing from (e.g., 'FederationMatrix.ts')" },
                                depth: { type: "number", description: "Max depth to trace dependencies (default: 2, max: 4)" }
                            },
                            required: ["entryFile"]
                        }
                    },
                    {
                        name: "read_file",
                        description: "Read the standard full content of a specific file.",
                        inputSchema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] }
                    },
                    {
                        name: "search_symbol",
                        description: "Quickly locate symbol paths within the Monorepo.",
                        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
                    },
                    {
                        name: "read_symbol_details",
                        description: "Deep probe: Read the actual implementation logic (AST node) for a specific class or function.",
                        inputSchema: { type: "object", properties: { filename: { type: "string" }, symbolName: { type: "string" } }, required: ["filename", "symbolName"] }
                    }
                ]
            })];
    });
}); });
server.setRequestHandler(types_js_1.CallToolRequestSchema, function (request) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, name, args, findMappingByFile, _b, entryFile, _c, depth, maxDepth_1, startNode, visited_1, traverse_1, tree, filename, target, directPath, query_1, results, _d, filename, symbolName, target, project, sourceFile, node, _e, clsName, methodName;
    var _f;
    return __generator(this, function (_g) {
        _a = request.params, name = _a.name, args = _a.arguments;
        findMappingByFile = function (filename) {
            var mappings = fs.readdirSync(OUTPUT_DIR).filter(function (f) { return f.endsWith('.mapping.json'); });
            for (var _i = 0, mappings_1 = mappings; _i < mappings_1.length; _i++) {
                var m = mappings_1[_i];
                var data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, m), 'utf-8'));
                if (data.sourcePath.endsWith(filename) || data.sourcePath.includes(filename)) {
                    return { sourcePath: data.sourcePath, safeName: m.replace('.mapping.json', ''), data: data };
                }
            }
            return null;
        };
        if (name === "get_local_topology") {
            _b = args, entryFile = _b.entryFile, _c = _b.depth, depth = _c === void 0 ? 2 : _c;
            maxDepth_1 = Math.min(depth, 4);
            startNode = findMappingByFile(entryFile);
            if (!startNode)
                return [2 /*return*/, { content: [{ type: "text", text: "Entry file ".concat(entryFile, " not found.") }], isError: true }];
            visited_1 = new Set();
            traverse_1 = function (currentPath, currentDepth) {
                if (currentDepth > maxDepth_1 || visited_1.has(currentPath))
                    return currentPath;
                visited_1.add(currentPath);
                var currentNode = findMappingByFile(path.basename(currentPath));
                if (!currentNode)
                    return currentPath;
                var node = { _path: currentPath };
                var imports = currentNode.data.imports || [];
                if (imports.length > 0 && currentDepth < maxDepth_1) {
                    node.imports = imports.map(function (imp) { return traverse_1(imp, currentDepth + 1); });
                }
                return node;
            };
            tree = traverse_1(startNode.sourcePath, 0);
            return [2 /*return*/, { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] }];
        }
        if (name === "read_file") {
            filename = args.filename;
            target = findMappingByFile(filename);
            if (!target) {
                directPath = path.resolve(ROOT_DIR, filename);
                if (fs.existsSync(directPath))
                    return [2 /*return*/, { content: [{ type: "text", text: fs.readFileSync(directPath, 'utf-8') }] }];
                return [2 /*return*/, { content: [{ type: "text", text: "File not found." }], isError: true }];
            }
            return [2 /*return*/, { content: [{ type: "text", text: fs.readFileSync(target.sourcePath, 'utf-8') }] }];
        }
        if (name === "search_symbol") {
            query_1 = args.query;
            results = fs.readdirSync(OUTPUT_DIR)
                .filter(function (f) { return f.endsWith('.mapping.json'); })
                .map(function (f) { return JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf-8')); })
                .filter(function (m) { return m.symbols.some(function (s) { return s.name.includes(query_1); }); })
                .map(function (m) { return "Symbol [".concat(query_1, "] -> Located at: ").concat(m.sourcePath); });
            return [2 /*return*/, { content: [{ type: "text", text: results.join('\n') || "No matching symbols found." }] }];
        }
        if (name === "read_symbol_details") {
            _d = args, filename = _d.filename, symbolName = _d.symbolName;
            target = findMappingByFile(filename);
            if (!target)
                return [2 /*return*/, { content: [{ type: "text", text: "Cannot locate file mapping." }], isError: true }];
            project = new ts_morph_1.Project();
            sourceFile = project.addSourceFileAtPath(target.sourcePath);
            node = sourceFile.getFunction(symbolName) || sourceFile.getClass(symbolName);
            if (!node && symbolName.includes('.')) {
                _e = symbolName.split('.'), clsName = _e[0], methodName = _e[1];
                node = (_f = sourceFile.getClass(clsName)) === null || _f === void 0 ? void 0 : _f.getMethod(methodName);
            }
            return [2 /*return*/, { content: [{ type: "text", text: node ? node.getText() : "Symbol not found in AST." }] }];
        }
        throw new Error("Tool not found");
    });
}); });
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var isForceSync, transport;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    isForceSync = process.argv.includes('--force');
                    if (isForceSync) {
                        console.error("🧹 [Force Refresh] Clearing up old indexes...");
                        if (fs.existsSync(OUTPUT_DIR))
                            fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
                        console.error("✨ Cleanup complete.");
                    }
                    console.error("🤫 [System Startup] Executing silent codebase indexing...");
                    preWarmWithProgress();
                    transport = new stdio_js_1.StdioServerTransport();
                    return [4 /*yield*/, server.connect(transport)];
                case 1:
                    _a.sent();
                    console.error("🚀 [GSOC-EXTENSION] Normal Analyzer Service ready.");
                    return [2 /*return*/];
            }
        });
    });
}
main().catch(function (error) {
    console.error("Fatal error starting server:", error);
    process.exit(1);
});
