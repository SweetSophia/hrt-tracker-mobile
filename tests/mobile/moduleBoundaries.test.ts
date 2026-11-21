import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const forbidden = new Set([
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'navigator',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'Capacitor',
    'CompressionStream',
    'DecompressionStream',
]);

// Follow runtime imports/re-exports (including dynamic imports). Type-only React
// declarations are erased and do not make their importing module platform code.
function boundary(entry: string, externals: ReadonlySet<string> = new Set()) {
    const visited = new Set<string>();
    const violations: string[] = [];
    function visit(file: string) {
        if (visited.has(file)) return;
        visited.add(file);
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const label = relative(root, file);
        function dependency(name: string) {
            if (!name.startsWith('.')) {
                if (!externals.has(name)) violations.push(`${label}: external ${name}`);
                return;
            }
            const resolved = ts.resolveModuleName(
                name,
                file,
                { moduleResolution: ts.ModuleResolutionKind.Bundler },
                ts.sys,
            ).resolvedModule?.resolvedFileName;
            if (!resolved) throw new Error(`Unresolved import ${name} in ${label}`);
            visit(resolved);
        }
        function walk(node: ts.Node) {
            if (ts.isImportDeclaration(node)) {
                const clause = node.importClause;
                if (clause?.isTypeOnly) return;
                if (
                    clause &&
                    !clause.name &&
                    clause.namedBindings &&
                    ts.isNamedImports(clause.namedBindings) &&
                    clause.namedBindings.elements.every(e => e.isTypeOnly)
                )
                    return;
                dependency((node.moduleSpecifier as ts.StringLiteral).text);
                return;
            }
            if (ts.isExportDeclaration(node)) {
                if (node.isTypeOnly) return;
                if (
                    node.exportClause &&
                    ts.isNamedExports(node.exportClause) &&
                    node.exportClause.elements.every(e => e.isTypeOnly)
                )
                    return;
                if (node.moduleSpecifier) dependency((node.moduleSpecifier as ts.StringLiteral).text);
                return;
            }
            if (
                ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
            ) {
                const arg = node.arguments[0];
                if (arg && ts.isStringLiteral(arg)) dependency(arg.text);
                else violations.push(`${label}: nonliteral import`);
            }
            if (ts.isIdentifier(node) && forbidden.has(node.text)) violations.push(`${label}: ${node.text}`);
            ts.forEachChild(node, walk);
        }
        walk(source);
    }
    visit(resolve(root, entry));
    return { violations, files: [...visited].map(file => relative(root, file)) };
}

it('keeps the entire engine runtime dependency graph platform independent', () => {
    const graph = boundary('src/domain/engine.ts');
    expect(graph.violations).toEqual([]);
    expect(graph.files).toContain('shbg.ts');
    expect(graph.files).not.toContain('src/domain/crypto.ts');
});

it('detects the compatibility barrel crypto boundary transitively', () => {
    expect(boundary('logic.ts').violations.length).toBeGreaterThan(0);
});

it('keeps record planning independent of UI and platform adapters', () => {
    const graph = boundary(
        'src/records/index.ts',
        new Set(['uuid', '@noble/hashes/sha2.js', '@noble/hashes/utils.js']),
    );
    expect(graph.violations).toEqual([]);
    expect(graph.files).not.toContain('src/domain/crypto.ts');
});

it('keeps the controller independent of React, storage implementations and native plugins', () => {
    expect(boundary('src/application/recordController.ts', new Set(['uuid'])).violations).toEqual([]);
    expect(boundary('src/platform/contracts.ts').violations).toEqual([]);
});
