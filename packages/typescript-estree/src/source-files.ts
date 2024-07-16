import type * as ts from 'typescript';

export function isSourceFile(code: unknown): code is ts.SourceFile {
  if (typeof code !== 'object' || code == null) {
    return false;
  }

  const maybeSourceFile = code as Partial<ts.SourceFile>;
  return (
    maybeSourceFile.kind === (312 satisfies ts.SyntaxKind.SourceFile) &&
    typeof maybeSourceFile.getFullText === 'function'
  );
}

export function getCodeText(code: ts.SourceFile | string): string {
  return isSourceFile(code) ? code.getFullText(code) : code;
}
