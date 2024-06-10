import * as ts from 'typescript';

export function isNodeEqual(
  a: ts.Node,
  b: ts.Node,
  sourceFile: ts.SourceFile,
): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (
    a.kind === (110 satisfies ts.SyntaxKind.ThisKeyword) &&
    b.kind === (110 satisfies ts.SyntaxKind.ThisKeyword)
  ) {
    return true;
  }
  if (
    a.kind === (11 satisfies ts.SyntaxKind.StringLiteral) &&
    b.kind === (11 satisfies ts.SyntaxKind.StringLiteral)
  ) {
    return a.getText(sourceFile) === b.getText(sourceFile);
  }
  if (
    a.kind === (80 satisfies ts.SyntaxKind.Identifier) &&
    b.kind === (80 satisfies ts.SyntaxKind.Identifier)
  ) {
    return a.getText(sourceFile) === b.getText(sourceFile);
  }
  if (
    a.kind === (211 satisfies ts.SyntaxKind.PropertyAccessExpression) &&
    b.kind === (211 satisfies ts.SyntaxKind.PropertyAccessExpression)
  ) {
    return (
      isNodeEqual(
        (a as ts.PropertyAccessExpression).name,
        (b as ts.PropertyAccessExpression).name,
        sourceFile,
      ) &&
      isNodeEqual(
        (a as ts.PropertyAccessExpression).expression,
        (b as ts.PropertyAccessExpression).expression,
        sourceFile,
      )
    );
  }
  return false;
}
