import { Project } from 'ts-morph';
import * as fs from 'fs';

export function getSymbolDetails(symbolName: string, mappingFilePath: string): string {
    if (!fs.existsSync(mappingFilePath)) return "Error: Mapping file not found";
    const mapping = JSON.parse(fs.readFileSync(mappingFilePath, 'utf-8'));

    const project = new Project();
    const sourceFile = project.addSourceFileAtPath(mapping.sourcePath);

    // 尝试在函数、变量或类中查找
    const fn = sourceFile.getFunction(symbolName) || sourceFile.getVariableDeclaration(symbolName);
    if (fn) return fn.getText();

    for (const cls of sourceFile.getClasses()) {
        const method = cls.getMethod(symbolName);
        if (method) return method.getText();
    }

    return `Symbol ${symbolName} not found in original source.`;
}