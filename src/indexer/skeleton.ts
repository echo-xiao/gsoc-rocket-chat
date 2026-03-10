import { Project, Node, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

// 系统内置函数，不作为 callee 追踪
const BUILTIN_IGNORE = new Set([
    'console', 'Math', 'Object', 'Array', 'String', 'Number', 'JSON',
    'Promise', 'Error', 'setTimeout', 'clearTimeout', 'setInterval',
    'parseInt', 'parseFloat', 'require', 'import', 'super', 'toString'
]);

export class SkeletonGenerator {
    static generate(filePath: string): { skeleton: string, mapping: any } {
        const project = new Project({ skipAddingFilesFromTsConfig: true });
        const sourceFile = project.addSourceFileAtPath(filePath);

        const mapping: any = {
            sourcePath: filePath,
            symbols: [],
            imports: []
        };

        this.processImports(sourceFile, filePath, mapping);

        // 注意顺序：先提取调用关系（函数体存在时），再剥离函数体
        this.processClasses(sourceFile, mapping);
        this.processFunctions(sourceFile, mapping);
        this.processInterfacesAndTypes(sourceFile, mapping);
        this.processEnums(sourceFile, mapping);

        const skeletonMd = this.convertToMarkdown(sourceFile, filePath);
        sourceFile.forget();

        return { skeleton: skeletonMd, mapping };
    }

    /**
     * 在函数体被剥离前，提取其中的函数调用名（call expressions）
     * 用于构建函数调用级别的 Context（A 调 B → 拉取 B 的 skeleton）
     */
    private static extractCalls(node: any): string[] {
        const calls = new Set<string>();
        try {
            node.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call: any) => {
                const expr = call.getExpression();
                let name: string | null = null;

                if (Node.isPropertyAccessExpression(expr)) {
                    name = expr.getName(); // this.sendMessage → sendMessage
                } else if (Node.isIdentifier(expr)) {
                    name = expr.getText();
                }

                if (name && name.length > 1 && !BUILTIN_IGNORE.has(name)) {
                    calls.add(name);
                }
            });
        } catch { /* 忽略 AST 解析错误 */ }
        return Array.from(calls);
    }

    private static processImports(sourceFile: SourceFile, filePath: string, mapping: any) {
        const dir = path.dirname(filePath);

        sourceFile.getImportDeclarations().forEach(imp => {
            const moduleSpecifier = imp.getModuleSpecifierValue();
            if (moduleSpecifier.startsWith('.')) {
                const base = path.resolve(dir, moduleSpecifier);
                const candidates = [
                    base + '.ts',
                    base + '/index.ts',
                    base.replace(/\.js$/, '.ts'),
                ];
                const resolved = candidates.find(c => fs.existsSync(c)) ?? base + '.ts';
                mapping.imports.push({ module: moduleSpecifier, resolved });
            } else {
                mapping.imports.push({ module: moduleSpecifier, resolved: 'external' });
            }
        });
    }

    private static processClasses(sourceFile: SourceFile, mapping: any) {
        sourceFile.getClasses().forEach(cls => {
            const className = cls.getName();
            if (!className) return;

            mapping.symbols.push({ type: 'class', name: className, line: cls.getStartLineNumber() });

            // 方法级别：提取调用 → 剥离函数体
            cls.getMethods().forEach(method => {
                const methodName = method.getName();
                const calls = this.extractCalls(method); // 剥离前提取！
                mapping.symbols.push({
                    type: 'method',
                    name: methodName,
                    qualifiedName: `${className}.${methodName}`,
                    line: method.getStartLineNumber(),
                    calls
                });
                if (method.getBody()) {
                    method.setBodyText('/* Implementation Hidden */');
                }
            });

            cls.getConstructors().forEach(ctor => {
                const calls = this.extractCalls(ctor);
                mapping.symbols.push({
                    type: 'method',
                    name: 'constructor',
                    qualifiedName: `${className}.constructor`,
                    line: ctor.getStartLineNumber(),
                    calls
                });
                if (ctor.getBody()) {
                    ctor.setBodyText('/* Implementation Hidden */');
                }
            });
        });
    }

    private static processFunctions(sourceFile: SourceFile, mapping: any) {
        sourceFile.getFunctions().forEach(fn => {
            const name = fn.getName();
            if (name && fn.getBody()) {
                const calls = this.extractCalls(fn); // 剥离前提取！
                mapping.symbols.push({ type: 'function', name, line: fn.getStartLineNumber(), calls });
                fn.setBodyText('/* Implementation Hidden */');
            }
        });

        sourceFile.getVariableDeclarations().forEach(v => {
            const initializer = v.getInitializer();
            if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
                const calls = this.extractCalls(initializer); // 剥离前提取！
                mapping.symbols.push({
                    type: 'variable_function',
                    name: v.getName(),
                    line: v.getStartLineNumber(),
                    calls
                });
                try {
                    (initializer as any).setBodyText('/* Implementation Hidden */');
                } catch { /* Skip expression-body arrows - can't strip concise body */ }
            }
        });
    }

    private static processInterfacesAndTypes(sourceFile: SourceFile, mapping: any) {
        sourceFile.getInterfaces().forEach(i => {
            mapping.symbols.push({ type: 'interface', name: i.getName(), line: i.getStartLineNumber() });
        });
        sourceFile.getTypeAliases().forEach(t => {
            mapping.symbols.push({ type: 'type', name: t.getName(), line: t.getStartLineNumber() });
        });
    }

    private static processEnums(sourceFile: SourceFile, mapping: any) {
        sourceFile.getEnums().forEach(e => {
            mapping.symbols.push({ type: 'enum', name: e.getName(), line: e.getStartLineNumber() });
        });
    }

    private static convertToMarkdown(sourceFile: SourceFile, filePath: string): string {
        const relativePath = filePath.split('Rocket.Chat/')[1] || filePath;
        return `## File: ${relativePath}\n\n\`\`\`typescript\n${sourceFile.getFullText()}\n\`\`\``;
    }
}
