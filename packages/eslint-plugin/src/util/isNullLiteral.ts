import * as ts from 'typescript';

export function isNullLiteral(i: ts.Node): i is ts.NullLiteral {
  return i.kind === ts.SyntaxKind.NullKeyword;
}
