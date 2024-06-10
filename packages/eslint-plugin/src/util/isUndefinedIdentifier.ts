import * as ts from 'typescript';

export function isUndefinedIdentifier(i: ts.Node) {
  return i.kind === ts.SyntaxKind.UndefinedKeyword;
}
