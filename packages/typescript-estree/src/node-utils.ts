import type * as ts from 'typescript';

import { getModifiers } from './getModifiers';
import { xhtmlEntities } from './jsx/xhtml-entities';
import type { TSESTree, TSNode } from './ts-estree';
import { AST_NODE_TYPES, AST_TOKEN_TYPES } from './ts-estree';
import { typescriptVersionIsAtLeast } from './version-check';

const isAtLeast50 = typescriptVersionIsAtLeast['5.0'];

type LogicalOperatorKind =
  | ts.SyntaxKind.AmpersandAmpersandToken
  | ts.SyntaxKind.BarBarToken
  | ts.SyntaxKind.QuestionQuestionToken;
const LOGICAL_OPERATORS: ReadonlySet<LogicalOperatorKind> = new Set([
  57 satisfies ts.SyntaxKind.BarBarToken,
  56 satisfies ts.SyntaxKind.AmpersandAmpersandToken,
  61 satisfies ts.SyntaxKind.QuestionQuestionToken,
]);

interface TokenToText
  extends TSESTree.PunctuatorTokenToText,
    TSESTree.BinaryOperatorToText {
  [ts.SyntaxKind.ImportKeyword]: 'import';
  [ts.SyntaxKind.NewKeyword]: 'new';
  [ts.SyntaxKind.KeyOfKeyword]: 'keyof';
  [ts.SyntaxKind.ReadonlyKeyword]: 'readonly';
  [ts.SyntaxKind.UniqueKeyword]: 'unique';
}

type AssignmentOperatorKind = keyof TSESTree.AssignmentOperatorToText;
const ASSIGNMENT_OPERATORS: ReadonlySet<AssignmentOperatorKind> = new Set([
  64 satisfies ts.SyntaxKind.EqualsToken,
  65 satisfies ts.SyntaxKind.PlusEqualsToken,
  66 satisfies ts.SyntaxKind.MinusEqualsToken,
  67 satisfies ts.SyntaxKind.AsteriskEqualsToken,
  68 satisfies ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  69 satisfies ts.SyntaxKind.SlashEqualsToken,
  70 satisfies ts.SyntaxKind.PercentEqualsToken,
  71 satisfies ts.SyntaxKind.LessThanLessThanEqualsToken,
  72 satisfies ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  73 satisfies ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  74 satisfies ts.SyntaxKind.AmpersandEqualsToken,
  75 satisfies ts.SyntaxKind.BarEqualsToken,
  76 satisfies ts.SyntaxKind.BarBarEqualsToken,
  77 satisfies ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  78 satisfies ts.SyntaxKind.QuestionQuestionEqualsToken,
  79 satisfies ts.SyntaxKind.CaretEqualsToken,
]);

type BinaryOperatorKind = keyof TSESTree.BinaryOperatorToText;
const BINARY_OPERATORS: ReadonlySet<BinaryOperatorKind> = new Set([
  104 satisfies ts.SyntaxKind.InstanceOfKeyword,
  103 satisfies ts.SyntaxKind.InKeyword,
  43 satisfies ts.SyntaxKind.AsteriskAsteriskToken,
  42 satisfies ts.SyntaxKind.AsteriskToken,
  44 satisfies ts.SyntaxKind.SlashToken,
  45 satisfies ts.SyntaxKind.PercentToken,
  40 satisfies ts.SyntaxKind.PlusToken,
  41 satisfies ts.SyntaxKind.MinusToken,
  51 satisfies ts.SyntaxKind.AmpersandToken,
  52 satisfies ts.SyntaxKind.BarToken,
  53 satisfies ts.SyntaxKind.CaretToken,
  48 satisfies ts.SyntaxKind.LessThanLessThanToken,
  49 satisfies ts.SyntaxKind.GreaterThanGreaterThanToken,
  50 satisfies ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  56 satisfies ts.SyntaxKind.AmpersandAmpersandToken,
  57 satisfies ts.SyntaxKind.BarBarToken,
  30 satisfies ts.SyntaxKind.LessThanToken,
  33 satisfies ts.SyntaxKind.LessThanEqualsToken,
  32 satisfies ts.SyntaxKind.GreaterThanToken,
  34 satisfies ts.SyntaxKind.GreaterThanEqualsToken,
  35 satisfies ts.SyntaxKind.EqualsEqualsToken,
  37 satisfies ts.SyntaxKind.EqualsEqualsEqualsToken,
  38 satisfies ts.SyntaxKind.ExclamationEqualsEqualsToken,
  36 satisfies ts.SyntaxKind.ExclamationEqualsToken,
]);

type DeclarationKind = TSESTree.VariableDeclaration['kind'];

/**
 * Returns true if the given ts.Token is the assignment operator
 * @param operator the operator token
 */
function isAssignmentOperator(
  operator: ts.BinaryOperatorToken,
): operator is ts.Token<AssignmentOperatorKind> {
  return (ASSIGNMENT_OPERATORS as ReadonlySet<ts.SyntaxKind>).has(
    operator.kind,
  );
}

/**
 * Returns true if the given ts.Token is a logical operator
 * @param operator the operator token
 * @returns is a logical operator
 */
export function isLogicalOperator(
  operator: ts.BinaryOperatorToken,
): operator is ts.Token<LogicalOperatorKind> {
  return (LOGICAL_OPERATORS as ReadonlySet<ts.SyntaxKind>).has(operator.kind);
}

export function isESTreeBinaryOperator(
  operator: ts.BinaryOperatorToken,
): operator is ts.Token<BinaryOperatorKind> {
  return (BINARY_OPERATORS as ReadonlySet<ts.SyntaxKind>).has(operator.kind);
}

type TokenForTokenKind<T extends ts.SyntaxKind> = T extends keyof TokenToText
  ? TokenToText[T]
  : string | undefined;
/**
 * Returns the string form of the given TSToken SyntaxKind
 * @param kind the token's SyntaxKind
 * @returns the token applicable token as a string
 */
export function getTextForTokenKind<T extends ts.SyntaxKind>(
  ts: typeof import('typescript'),
  kind: T,
): TokenForTokenKind<T> {
  return ts.tokenToString(kind) as T extends keyof TokenToText
    ? TokenToText[T]
    : string | undefined;
}

/**
 * Returns true if the given ts.Node is a valid ESTree class member
 * @param node TypeScript AST node
 * @returns is valid ESTree class member
 */
export function isESTreeClassMember(node: ts.Node): boolean {
  return node.kind !== (240 satisfies ts.SyntaxKind.SemicolonClassElement);
}

/**
 * Checks if a ts.Node has a modifier
 * @param modifierKind TypeScript SyntaxKind modifier
 * @param node TypeScript AST node
 * @returns has the modifier specified
 */
export function hasModifier(
  ts: typeof import('typescript'),
  modifierKind: ts.KeywordSyntaxKind,
  node: ts.Node,
): boolean {
  const modifiers = getModifiers(ts, node);
  return modifiers?.some(modifier => modifier.kind === modifierKind) === true;
}

/**
 * Get last last modifier in ast
 * @param node TypeScript AST node
 * @returns returns last modifier if present or null
 */
export function getLastModifier(
  ts: typeof import('typescript'),
  node: ts.Node,
): ts.Modifier | null {
  const modifiers = getModifiers(ts, node);
  if (modifiers == null) {
    return null;
  }
  return modifiers[modifiers.length - 1] ?? null;
}

/**
 * Returns true if the given ts.Token is a comma
 * @param token the TypeScript token
 * @returns is comma
 */
export function isComma(
  token: ts.Node,
): token is ts.Token<ts.SyntaxKind.CommaToken> {
  return token.kind === (28 satisfies ts.SyntaxKind.CommaToken);
}

/**
 * Returns true if the given ts.Node is a comment
 * @param node the TypeScript node
 * @returns is comment
 */
export function isComment(node: ts.Node): boolean {
  return (
    node.kind === (2 satisfies ts.SyntaxKind.SingleLineCommentTrivia) ||
    node.kind === (3 satisfies ts.SyntaxKind.MultiLineCommentTrivia)
  );
}

/**
 * Returns true if the given ts.Node is a JSDoc comment
 * @param node the TypeScript node
 */
function isJSDocComment(node: ts.Node): node is ts.JSDoc {
  // eslint-disable-next-line deprecation/deprecation -- ts.SyntaxKind.JSDoc was only added in TS4.7 so we can't use it yet
  return node.kind === (327 satisfies ts.SyntaxKind.JSDocComment);
}

/**
 * Returns the binary expression type of the given ts.Token
 * @param operator the operator token
 * @returns the binary expression type
 */
export function getBinaryExpressionType(
  ts: typeof import('typescript'),
  operator: ts.BinaryOperatorToken,
):
  | {
      type: AST_NODE_TYPES.AssignmentExpression;
      operator: TokenForTokenKind<AssignmentOperatorKind>;
    }
  | {
      type: AST_NODE_TYPES.BinaryExpression;
      operator: TokenForTokenKind<BinaryOperatorKind>;
    }
  | {
      type: AST_NODE_TYPES.LogicalExpression;
      operator: TokenForTokenKind<LogicalOperatorKind>;
    } {
  if (isAssignmentOperator(operator)) {
    return {
      type: AST_NODE_TYPES.AssignmentExpression,
      operator: getTextForTokenKind(ts, operator.kind),
    };
  } else if (isLogicalOperator(operator)) {
    return {
      type: AST_NODE_TYPES.LogicalExpression,
      operator: getTextForTokenKind(ts, operator.kind),
    };
  } else if (isESTreeBinaryOperator(operator)) {
    return {
      type: AST_NODE_TYPES.BinaryExpression,
      operator: getTextForTokenKind(ts, operator.kind),
    };
  }

  throw new Error(
    `Unexpected binary operator ${ts.tokenToString(operator.kind)}`,
  );
}

/**
 * Returns line and column data for the given positions,
 * @param pos position to check
 * @param ast the AST object
 * @returns line and column
 */
export function getLineAndCharacterFor(
  pos: number,
  ast: ts.SourceFile,
): TSESTree.Position {
  const loc = ast.getLineAndCharacterOfPosition(pos);
  return {
    line: loc.line + 1,
    column: loc.character,
  };
}

/**
 * Returns line and column data for the given start and end positions,
 * for the given AST
 * @param range start end data
 * @param ast   the AST object
 * @returns the loc data
 */
export function getLocFor(
  range: TSESTree.Range,
  ast: ts.SourceFile,
): TSESTree.SourceLocation {
  const [start, end] = range.map(pos => getLineAndCharacterFor(pos, ast));
  return { start, end };
}

/**
 * Check whatever node can contain directive
 * @returns returns true if node can contain directive
 */
export function canContainDirective(
  node:
    | ts.Block
    | ts.ClassStaticBlockDeclaration
    | ts.ModuleBlock
    | ts.SourceFile,
): boolean {
  if (node.kind === (241 satisfies ts.SyntaxKind.Block)) {
    switch (node.parent.kind) {
      case 176 satisfies ts.SyntaxKind.Constructor:
      case 177 satisfies ts.SyntaxKind.GetAccessor:
      case 178 satisfies ts.SyntaxKind.SetAccessor:
      case 219 satisfies ts.SyntaxKind.ArrowFunction:
      case 218 satisfies ts.SyntaxKind.FunctionExpression:
      case 262 satisfies ts.SyntaxKind.FunctionDeclaration:
      case 174 satisfies ts.SyntaxKind.MethodDeclaration:
        return true;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Returns range for the given ts.Node
 * @param node the ts.Node or ts.Token
 * @param ast the AST object
 * @returns the range data
 */
export function getRange(
  node: Pick<ts.Node, 'getEnd' | 'getStart'>,
  ast: ts.SourceFile,
): [number, number] {
  return [node.getStart(ast), node.getEnd()];
}

/**
 * Returns true if a given ts.Node is a token
 * @param node the ts.Node
 * @returns is a token
 */
function isToken(node: ts.Node): node is ts.Token<ts.TokenSyntaxKind> {
  return (
    node.kind >= (0 satisfies ts.SyntaxKind.FirstToken) &&
    node.kind <= (165 satisfies ts.SyntaxKind.LastToken)
  );
}

/**
 * Returns true if a given ts.Node is a JSX token
 * @param node ts.Node to be checked
 * @returns is a JSX token
 */
export function isJSXToken(node: ts.Node): boolean {
  return (
    node.kind >= (284 satisfies ts.SyntaxKind.JsxElement) &&
    node.kind <= (291 satisfies ts.SyntaxKind.JsxAttribute)
  );
}

/**
 * Returns the declaration kind of the given ts.Node
 * @param node TypeScript AST node
 * @returns declaration kind
 */
export function getDeclarationKind(
  node: ts.VariableDeclarationList,
): DeclarationKind {
  if (node.flags & (1 satisfies ts.NodeFlags.Let)) {
    return 'let';
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  if (
    (node.flags & (6 satisfies ts.NodeFlags.AwaitUsing)) ===
    (6 satisfies ts.NodeFlags.AwaitUsing)
  ) {
    return 'await using';
  }
  if (node.flags & (2 satisfies ts.NodeFlags.Const)) {
    return 'const';
  }
  if (node.flags & (4 satisfies ts.NodeFlags.Using)) {
    return 'using';
  }
  return 'var';
}

/**
 * Gets a ts.Node's accessibility level
 * @param node The ts.Node
 * @returns accessibility "public", "protected", "private", or null
 */
export function getTSNodeAccessibility(
  ts: typeof import('typescript'),
  node: ts.Node,
): 'private' | 'protected' | 'public' | undefined {
  const modifiers = getModifiers(ts, node);
  if (modifiers == null) {
    return undefined;
  }
  for (const modifier of modifiers) {
    switch (modifier.kind) {
      case ts.SyntaxKind.PublicKeyword:
        return 'public';
      case ts.SyntaxKind.ProtectedKeyword:
        return 'protected';
      case ts.SyntaxKind.PrivateKeyword:
        return 'private';
      default:
        break;
    }
  }
  return undefined;
}

/**
 * Finds the next token based on the previous one and its parent
 * Had to copy this from TS instead of using TS's version because theirs doesn't pass the ast to getChildren
 * @param previousToken The previous TSToken
 * @param parent The parent TSNode
 * @param ast The TS AST
 * @returns the next TSToken
 */
export function findNextToken(
  ts: typeof import('typescript'),
  previousToken: ts.TextRange,
  parent: ts.Node,
  ast: ts.SourceFile,
): ts.Node | undefined {
  return find(parent);

  function find(n: ts.Node): ts.Node | undefined {
    if (ts.isToken(n) && n.pos === previousToken.end) {
      // this is token that starts at the end of previous token - return it
      return n;
    }
    return firstDefined(n.getChildren(ast), (child: ts.Node) => {
      const shouldDiveInChildNode =
        // previous token is enclosed somewhere in the child
        (child.pos <= previousToken.pos && child.end > previousToken.end) ||
        // previous token ends exactly at the beginning of child
        child.pos === previousToken.end;
      return shouldDiveInChildNode && nodeHasTokens(child, ast)
        ? find(child)
        : undefined;
    });
  }
}

/**
 * Find the first matching ancestor based on the given predicate function.
 * @param node The current ts.Node
 * @param predicate The predicate function to apply to each checked ancestor
 * @returns a matching parent ts.Node
 */
export function findFirstMatchingAncestor(
  node: ts.Node,
  predicate: (node: ts.Node) => boolean,
): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (predicate(current)) {
      return current;
    }
    current = current.parent as ts.Node | undefined;
  }
  return undefined;
}

/**
 * Returns true if a given ts.Node has a JSX token within its hierarchy
 * @param node ts.Node to be checked
 * @returns has JSX ancestor
 */
export function hasJSXAncestor(node: ts.Node): boolean {
  return !!findFirstMatchingAncestor(node, isJSXToken);
}

/**
 * Unescape the text content of string literals, e.g. &amp; -> &
 * @param text The escaped string literal text.
 * @returns The unescaped string literal text.
 */
export function unescapeStringLiteralText(text: string): string {
  return text.replace(/&(?:#\d+|#x[\da-fA-F]+|[0-9a-zA-Z]+);/g, entity => {
    const item = entity.slice(1, -1);
    if (item[0] === '#') {
      const codePoint =
        item[1] === 'x'
          ? parseInt(item.slice(2), 16)
          : parseInt(item.slice(1), 10);
      return codePoint > 0x10ffff // RangeError: Invalid code point
        ? entity
        : String.fromCodePoint(codePoint);
    }
    return xhtmlEntities[item] || entity;
  });
}

/**
 * Returns true if a given ts.Node is a computed property
 * @param node ts.Node to be checked
 * @returns is Computed Property
 */
export function isComputedProperty(
  node: ts.Node,
): node is ts.ComputedPropertyName {
  return node.kind === (167 satisfies ts.SyntaxKind.ComputedPropertyName);
}

/**
 * Returns true if a given ts.Node is optional (has QuestionToken)
 * @param node ts.Node to be checked
 * @returns is Optional
 */
export function isOptional(node: {
  questionToken?: ts.QuestionToken;
}): boolean {
  return !!node.questionToken;
}

/**
 * Returns true if the node is an optional chain node
 */
export function isChainExpression(
  node: TSESTree.Node,
): node is TSESTree.ChainExpression {
  return node.type === AST_NODE_TYPES.ChainExpression;
}

/**
 * Returns true of the child of property access expression is an optional chain
 */
export function isChildUnwrappableOptionalChain(
  node:
    | ts.CallExpression
    | ts.ElementAccessExpression
    | ts.NonNullExpression
    | ts.PropertyAccessExpression,
  child: TSESTree.Node,
): boolean {
  return (
    isChainExpression(child) &&
    // (x?.y).z is semantically different, and as such .z is no longer optional
    node.expression.kind !==
      (217 satisfies ts.SyntaxKind.ParenthesizedExpression)
  );
}

/**
 * Returns the type of a given ts.Token
 * @param token the ts.Token
 * @returns the token type
 */
export function getTokenType(
  ts: typeof import('typescript'),
  token: ts.Identifier | ts.Token<ts.SyntaxKind>,
): Exclude<AST_TOKEN_TYPES, AST_TOKEN_TYPES.Block | AST_TOKEN_TYPES.Line> {
  let keywordKind: ts.SyntaxKind | undefined;
  if (isAtLeast50 && token.kind === ts.SyntaxKind.Identifier) {
    keywordKind = ts.identifierToKeywordKind(token as ts.Identifier);
  } else if ('originalKeywordKind' in token) {
    // eslint-disable-next-line deprecation/deprecation -- intentional fallback for older TS versions
    keywordKind = token.originalKeywordKind;
  }
  if (keywordKind) {
    if (keywordKind === ts.SyntaxKind.NullKeyword) {
      return AST_TOKEN_TYPES.Null;
    } else if (
      keywordKind >= ts.SyntaxKind.FirstFutureReservedWord &&
      keywordKind <= ts.SyntaxKind.LastKeyword
    ) {
      return AST_TOKEN_TYPES.Identifier;
    }
    return AST_TOKEN_TYPES.Keyword;
  }

  if (
    token.kind >= ts.SyntaxKind.FirstKeyword &&
    token.kind <= ts.SyntaxKind.LastFutureReservedWord
  ) {
    if (
      token.kind === ts.SyntaxKind.FalseKeyword ||
      token.kind === ts.SyntaxKind.TrueKeyword
    ) {
      return AST_TOKEN_TYPES.Boolean;
    }

    return AST_TOKEN_TYPES.Keyword;
  }

  if (
    token.kind >= ts.SyntaxKind.FirstPunctuation &&
    token.kind <= ts.SyntaxKind.LastPunctuation
  ) {
    return AST_TOKEN_TYPES.Punctuator;
  }

  if (
    token.kind >= ts.SyntaxKind.NoSubstitutionTemplateLiteral &&
    token.kind <= ts.SyntaxKind.TemplateTail
  ) {
    return AST_TOKEN_TYPES.Template;
  }

  switch (token.kind) {
    case ts.SyntaxKind.NumericLiteral:
      return AST_TOKEN_TYPES.Numeric;

    case ts.SyntaxKind.JsxText:
      return AST_TOKEN_TYPES.JSXText;

    case ts.SyntaxKind.StringLiteral:
      // A TypeScript-StringLiteral token with a TypeScript-JsxAttribute or TypeScript-JsxElement parent,
      // must actually be an ESTree-JSXText token
      if (
        token.parent.kind === ts.SyntaxKind.JsxAttribute ||
        token.parent.kind === ts.SyntaxKind.JsxElement
      ) {
        return AST_TOKEN_TYPES.JSXText;
      }

      return AST_TOKEN_TYPES.String;

    case ts.SyntaxKind.RegularExpressionLiteral:
      return AST_TOKEN_TYPES.RegularExpression;

    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.ConstructorKeyword:
    case ts.SyntaxKind.GetKeyword:
    case ts.SyntaxKind.SetKeyword:

    // intentional fallthrough
    default:
  }

  // Some JSX tokens have to be determined based on their parent
  if (token.kind === ts.SyntaxKind.Identifier) {
    if (isJSXToken(token.parent)) {
      return AST_TOKEN_TYPES.JSXIdentifier;
    }

    if (
      token.parent.kind === ts.SyntaxKind.PropertyAccessExpression &&
      hasJSXAncestor(token)
    ) {
      return AST_TOKEN_TYPES.JSXIdentifier;
    }
  }

  return AST_TOKEN_TYPES.Identifier;
}

/**
 * Extends and formats a given ts.Token, for a given AST
 * @param token the ts.Token
 * @param ast   the AST object
 * @returns the converted Token
 */
export function convertToken(
  ts: typeof import('typescript'),
  token: ts.Token<ts.TokenSyntaxKind>,
  ast: ts.SourceFile,
): TSESTree.Token {
  const start =
    token.kind === ts.SyntaxKind.JsxText
      ? token.getFullStart()
      : token.getStart(ast);
  const end = token.getEnd();
  const value = ast.text.slice(start, end);
  const tokenType = getTokenType(ts, token);
  const range: TSESTree.Range = [start, end];
  const loc = getLocFor(range, ast);

  if (tokenType === AST_TOKEN_TYPES.RegularExpression) {
    return {
      type: tokenType,
      value,
      range,
      loc,
      regex: {
        pattern: value.slice(1, value.lastIndexOf('/')),
        flags: value.slice(value.lastIndexOf('/') + 1),
      },
    };
  }
  // @ts-expect-error TS is complaining about `value` not being the correct
  // type but it is
  return {
    type: tokenType,
    value,
    range,
    loc,
  };
}

/**
 * Converts all tokens for the given AST
 * @param ast the AST object
 * @returns the converted Tokens
 */
export function convertTokens(
  ts: typeof import('typescript'),
  ast: ts.SourceFile,
): TSESTree.Token[] {
  const result: TSESTree.Token[] = [];
  /**
   * @param node the ts.Node
   */
  function walk(node: ts.Node): void {
    // TypeScript generates tokens for types in JSDoc blocks. Comment tokens
    // and their children should not be walked or added to the resulting tokens list.
    if (isComment(node) || isJSDocComment(node)) {
      return;
    }

    if (isToken(node) && node.kind !== ts.SyntaxKind.EndOfFileToken) {
      result.push(convertToken(ts, node, ast));
    } else {
      node.getChildren(ast).forEach(walk);
    }
  }
  walk(ast);
  return result;
}

export class TSError extends Error {
  constructor(
    message: string,
    public readonly fileName: string,
    public readonly location: {
      start: {
        line: number;
        column: number;
        offset: number;
      };
      end: {
        line: number;
        column: number;
        offset: number;
      };
    },
  ) {
    super(message);
    Object.defineProperty(this, 'name', {
      value: new.target.name,
      enumerable: false,
      configurable: true,
    });
  }

  // For old version of ESLint https://github.com/typescript-eslint/typescript-eslint/pull/6556#discussion_r1123237311
  get index(): number {
    return this.location.start.offset;
  }

  // https://github.com/eslint/eslint/blob/b09a512107249a4eb19ef5a37b0bd672266eafdb/lib/linter/linter.js#L853
  get lineNumber(): number {
    return this.location.start.line;
  }

  // https://github.com/eslint/eslint/blob/b09a512107249a4eb19ef5a37b0bd672266eafdb/lib/linter/linter.js#L854
  get column(): number {
    return this.location.start.column;
  }
}

/**
 * @param message the error message
 * @param ast the AST object
 * @param startIndex the index at which the error starts
 * @param endIndex the index at which the error ends
 * @returns converted error object
 */
export function createError(
  message: string,
  ast: ts.SourceFile,
  startIndex: number,
  endIndex: number = startIndex,
): TSError {
  const [start, end] = [startIndex, endIndex].map(offset => {
    const { line, character: column } =
      ast.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, column, offset };
  });
  return new TSError(message, ast.fileName, { start, end });
}

export function nodeHasIllegalDecorators(
  node: ts.Node,
): node is ts.Node & { illegalDecorators: ts.Node[] } {
  return !!(
    'illegalDecorators' in node &&
    (node.illegalDecorators as unknown[] | undefined)?.length
  );
}

/**
 * @param n the TSNode
 * @param ast the TS AST
 */
export function nodeHasTokens(n: ts.Node, ast: ts.SourceFile): boolean {
  // If we have a token or node that has a non-zero width, it must have tokens.
  // Note: getWidth() does not take trivia into account.
  return n.kind === (1 satisfies ts.SyntaxKind.EndOfFileToken)
    ? !!(n as ts.JSDocContainer).jsDoc
    : n.getWidth(ast) !== 0;
}

/**
 * Like `forEach`, but suitable for use with numbers and strings (which may be falsy).
 */
export function firstDefined<T, U>(
  array: readonly T[] | undefined,
  callback: (element: T, index: number) => U | undefined,
): U | undefined {
  if (array === undefined) {
    return undefined;
  }

  for (let i = 0; i < array.length; i++) {
    const result = callback(array[i], i);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

export function identifierIsThisKeyword(
  ts: typeof import('typescript'),
  id: ts.Identifier,
): boolean {
  return (
    // eslint-disable-next-line deprecation/deprecation -- intentional for older TS versions
    (isAtLeast50 ? ts.identifierToKeywordKind(id) : id.originalKeywordKind) ===
    ts.SyntaxKind.ThisKeyword
  );
}

export function isThisIdentifier(
  ts: typeof import('typescript'),
  node: ts.Node | undefined,
): node is ts.Identifier {
  return (
    !!node &&
    node.kind === ts.SyntaxKind.Identifier &&
    identifierIsThisKeyword(ts, node as ts.Identifier)
  );
}

export function isThisInTypeQuery(
  ts: typeof import('typescript'),
  node: ts.Node,
): boolean {
  if (!isThisIdentifier(ts, node)) {
    return false;
  }

  while (ts.isQualifiedName(node.parent) && node.parent.left === node) {
    node = node.parent;
  }

  return node.parent.kind === ts.SyntaxKind.TypeQuery;
}

// `ts.nodeIsMissing`
function nodeIsMissing(node: ts.Node | undefined): boolean {
  if (node === undefined) {
    return true;
  }
  return (
    node.pos === node.end &&
    node.pos >= 0 &&
    node.kind !== (1 satisfies ts.SyntaxKind.EndOfFileToken)
  );
}

// `ts.nodeIsPresent`
export function nodeIsPresent(node: ts.Node | undefined): node is ts.Node {
  return !nodeIsMissing(node);
}

// `ts.getContainingFunction`
export function getContainingFunction(
  ts: typeof import('typescript'),
  node: ts.Node,
): ts.SignatureDeclaration | undefined {
  return ts.findAncestor(node.parent, ts.isFunctionLike);
}

// `ts.hasAbstractModifier`
function hasAbstractModifier(
  ts: typeof import('typescript'),
  node: ts.Node,
): boolean {
  return hasModifier(ts, ts.SyntaxKind.AbstractKeyword, node);
}

// `ts.getThisParameter`
function getThisParameter(
  ts: typeof import('typescript'),
  signature: ts.SignatureDeclaration,
): ts.ParameterDeclaration | null {
  if (signature.parameters.length && !ts.isJSDocSignature(signature)) {
    const thisParameter = signature.parameters[0];
    if (parameterIsThisKeyword(ts, thisParameter)) {
      return thisParameter;
    }
  }

  return null;
}

// `ts.parameterIsThisKeyword`
function parameterIsThisKeyword(
  ts: typeof import('typescript'),
  parameter: ts.ParameterDeclaration,
): boolean {
  return isThisIdentifier(ts, parameter.name);
}

// Rewrite version of `ts.nodeCanBeDecorated`
// Returns `true` for both `useLegacyDecorators: true` and `useLegacyDecorators: false`
export function nodeCanBeDecorated(
  ts: typeof import('typescript'),
  node: TSNode,
): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.ClassDeclaration:
      return true;
    case ts.SyntaxKind.ClassExpression:
      // `ts.nodeCanBeDecorated` returns `false` if `useLegacyDecorators: true`
      return true;
    case ts.SyntaxKind.PropertyDeclaration: {
      const { parent } = node;

      // `ts.nodeCanBeDecorated` uses this if `useLegacyDecorators: true`
      if (ts.isClassDeclaration(parent)) {
        return true;
      }

      // `ts.nodeCanBeDecorated` uses this if `useLegacyDecorators: false`
      if (ts.isClassLike(parent) && !hasAbstractModifier(ts, node)) {
        return true;
      }

      return false;
    }
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.MethodDeclaration: {
      const { parent } = node;
      // In `ts.nodeCanBeDecorated`
      // when `useLegacyDecorators: true` uses `ts.isClassDeclaration`
      // when `useLegacyDecorators: true` uses `ts.isClassLike`
      return (
        Boolean(node.body) &&
        (ts.isClassDeclaration(parent) || ts.isClassLike(parent))
      );
    }
    case ts.SyntaxKind.Parameter: {
      // `ts.nodeCanBeDecorated` returns `false` if `useLegacyDecorators: false`

      const { parent } = node;
      const grandparent = parent.parent;

      return (
        Boolean(parent) &&
        'body' in parent &&
        Boolean(parent.body) &&
        (parent.kind === ts.SyntaxKind.Constructor ||
          parent.kind === ts.SyntaxKind.MethodDeclaration ||
          parent.kind === ts.SyntaxKind.SetAccessor) &&
        getThisParameter(ts, parent) !== node &&
        Boolean(grandparent) &&
        grandparent.kind === ts.SyntaxKind.ClassDeclaration
      );
    }
  }

  return false;
}

export function isValidAssignmentTarget(node: ts.Node): boolean {
  switch (node.kind) {
    case 80 satisfies ts.SyntaxKind.Identifier:
      return true;
    case 211 satisfies ts.SyntaxKind.PropertyAccessExpression:
    case 212 satisfies ts.SyntaxKind.ElementAccessExpression:
      if (node.flags & (64 satisfies ts.NodeFlags.OptionalChain)) {
        return false;
      }
      return true;
    case 217 satisfies ts.SyntaxKind.ParenthesizedExpression:
    case 216 satisfies ts.SyntaxKind.TypeAssertionExpression:
    case 234 satisfies ts.SyntaxKind.AsExpression:
    case 238 satisfies ts.SyntaxKind.SatisfiesExpression:
    case 235 satisfies ts.SyntaxKind.NonNullExpression:
      return isValidAssignmentTarget(
        (
          node as
            | ts.ParenthesizedExpression
            | ts.AssertionExpression
            | ts.SatisfiesExpression
            | ts.NonNullExpression
        ).expression,
      );
    default:
      return false;
  }
}

export function getNamespaceModifiers(
  ts: typeof import('typescript'),
  node: ts.ModuleDeclaration,
): ts.Modifier[] | undefined {
  // For following nested namespaces, use modifiers given to the topmost namespace
  //   export declare namespace foo.bar.baz {}
  let modifiers = getModifiers(ts, node);
  let moduleDeclaration = node;
  while (
    (!modifiers || modifiers.length === 0) &&
    ts.isModuleDeclaration(moduleDeclaration.parent)
  ) {
    const parentModifiers = getModifiers(ts, moduleDeclaration.parent);
    if (parentModifiers?.length) {
      modifiers = parentModifiers;
    }
    moduleDeclaration = moduleDeclaration.parent;
  }
  return modifiers;
}
