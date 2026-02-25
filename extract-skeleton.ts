import { Project, Node, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';

function processFile(filePath: string) {
    if (!fs.existsSync(filePath)) return;

    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(filePath);

    const fileSkeleton: any = {
        sourcePath: path.resolve(filePath),
        fileName: path.basename(filePath),
        symbols: []
    };

    // 1. 处理标准函数
    sourceFile.getFunctions().forEach(fn => {
        const name = fn.getName();
        if (name && fn.getBody()) { // 检查是否有函数体
            fileSkeleton.symbols.push({ type: 'function', name });
            fn.setBodyText('\n    /* [GSOC-REDUCTION]: Implementation omitted. */\n');
        }
    });

    // 2. 处理变量定义的函数 (修复重点：增加防御性检查)
    sourceFile.getVariableDeclarations().forEach(decl => {
        const initializer = decl.getInitializer();
        if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
            // 关键修复：检查 body 是否为 Block (即是否有 {} )
            const body = (initializer as any).getBody();
            if (body && Node.isBlock(body)) {
                const name = decl.getName();
                fileSkeleton.symbols.push({ type: 'variable_function', name });
                (initializer as any).setBodyText('\n    /* [GSOC-REDUCTION]: Implementation omitted. */\n');
            }
        }
    });

    // 3. 处理类方法
    sourceFile.getClasses().forEach(cls => {
        cls.getMethods().forEach(method => {
            const body = method.getBody();
            if (body && Node.isBlock(body)) {
                method.setBodyText('\n    /* [GSOC-REDUCTION]: Implementation omitted. */\n');
            }
        });
    });

    // --- 存储逻辑 ---
    const outputDir = './output';
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    const baseName = path.basename(filePath, '.ts');

    fs.writeFileSync(path.join(outputDir, `${baseName}.skeleton.ts`), sourceFile.getFullText());
    fs.writeFileSync(path.join(outputDir, `${baseName}.mapping.json`), JSON.stringify(fileSkeleton, null, 2));

    console.log(`✅ 完美通关！${baseName} 骨架已生成。`);
}

const targetFile = 'Rocket.Chat/apps/meteor/app/lib/server/functions/sendMessage.ts';
processFile(targetFile);