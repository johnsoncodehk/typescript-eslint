import type { Rule } from '@tsslint/types';
import * as tsutils from 'ts-api-utils';
import type * as ts from 'typescript';

import {
  getConstrainedTypeAtLocation,
  getContextualType,
  getDeclaration,
  isNullableType,
  isTypeFlagSet,
  nullThrows,
  NullThrowsReasons,
} from '../util';

/**
 * Disallow type assertions that do not change the type of an expression
 */
export function create(
  options: {
    /** A list of type names to ignore. */
    typesToIgnore?: string[];
  } = {},
): Rule {
  return ({
    typescript: ts,
    sourceFile,
    languageService,
    reportSuggestion: report,
  }) => {
    const program = languageService.getProgram()!;
    const checker = program.getTypeChecker();
    const compilerOptions = program.getCompilerOptions();

    /**
     * Returns true if there's a chance the variable has been used before a value has been assigned to it
     */
    function isPossiblyUsedBeforeAssigned(node: ts.Expression): boolean {
      const declaration = getDeclaration(checker, node);
      if (!declaration) {
        // don't know what the declaration is for some reason, so just assume the worst
        return true;
      }

      if (
        // non-strict mode doesn't care about used before assigned errors
        tsutils.isStrictCompilerOptionEnabled(
          compilerOptions,
          'strictNullChecks',
        ) &&
        // ignore class properties as they are compile time guarded
        // also ignore function arguments as they can't be used before defined
        ts.isVariableDeclaration(declaration) &&
        // is it `const x!: number`
        declaration.initializer === undefined &&
        declaration.exclamationToken === undefined &&
        declaration.type !== undefined
      ) {
        // check if the defined variable type has changed since assignment
        const declarationType = checker.getTypeFromTypeNode(declaration.type);
        const type = getConstrainedTypeAtLocation(checker, node);
        if (
          declarationType === type &&
          // `declare`s are never narrowed, so never skip them
          !(
            ts.isVariableStatement(declaration.parent.parent) &&
            declaration.parent.parent.modifiers?.some(
              mod => mod.kind === ts.SyntaxKind.DeclareKeyword,
            )
          )
        ) {
          // possibly used before assigned, so just skip it
          // better to false negative and skip it, than false positive and fix to compile erroring code
          //
          // no better way to figure this out right now
          // https://github.com/Microsoft/TypeScript/issues/31124
          return true;
        }
      }
      return false;
    }

    function isConstAssertion(node: ts.TypeNode): boolean {
      return (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.escapedText === 'const'
      );
    }

    function isImplicitlyNarrowedConstDeclaration({
      expression,
      parent,
    }: ts.AsExpression | ts.TypeAssertion): boolean {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const maybeDeclarationNode = parent.parent!;
      const isTemplateLiteralWithExpressions =
        ts.isTemplateExpression(expression) &&
        expression.templateSpans.length !== 0;
      return (
        ts.isVariableDeclarationList(maybeDeclarationNode) &&
        !!(maybeDeclarationNode.flags & ts.NodeFlags.Const) &&
        /**
         * Even on `const` variable declarations, template literals with expressions can sometimes be widened without a type assertion.
         * @see https://github.com/typescript-eslint/typescript-eslint/issues/8737
         */
        !isTemplateLiteralWithExpressions
      );
    }

    function isTypeUnchanged(uncast: ts.Type, cast: ts.Type): boolean {
      if (uncast === cast) {
        return true;
      }

      if (
        isTypeFlagSet(uncast, ts.TypeFlags.Undefined) &&
        isTypeFlagSet(cast, ts.TypeFlags.Undefined) &&
        tsutils.isCompilerOptionEnabled(
          compilerOptions,
          'exactOptionalPropertyTypes',
        )
      ) {
        const uncastParts = tsutils
          .unionTypeParts(uncast)
          .filter(part => !isTypeFlagSet(part, ts.TypeFlags.Undefined));

        const castParts = tsutils
          .unionTypeParts(cast)
          .filter(part => !isTypeFlagSet(part, ts.TypeFlags.Undefined));

        if (uncastParts.length !== castParts.length) {
          return false;
        }

        const uncastPartsSet = new Set(uncastParts);
        return castParts.every(part => uncastPartsSet.has(part));
      }

      return false;
    }

    const visitor = {
      TSNonNullExpression(node: ts.NonNullExpression): void {
        if (
          ts.isBinaryExpression(node.parent) &&
          node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          if (node.parent.left === node) {
            report(
              'This assertion is unnecessary since the receiver accepts the original type of the expression.',
              node.getStart(sourceFile),
              node.getEnd(),
            ).withFix('[No Description]', () => [
              {
                fileName: sourceFile.fileName,
                textChanges: [
                  {
                    newText: '',
                    span: {
                      start: node.expression.getEnd(),
                      length: node.getEnd() - node.expression.getEnd(),
                    },
                  },
                ],
              },
            ]);
          }
          // for all other = assignments we ignore non-null checks
          // this is because non-null assertions can change the type-flow of the code
          // so whilst they might be unnecessary for the assignment - they are necessary
          // for following code
          return;
        }

        const originalNode = node;

        const type = getConstrainedTypeAtLocation(checker, node.expression);

        if (!isNullableType(type) && !isTypeFlagSet(type, ts.TypeFlags.Void)) {
          if (
            ts.isIdentifier(node.expression) &&
            isPossiblyUsedBeforeAssigned(node.expression)
          ) {
            return;
          }

          report(
            'This assertion is unnecessary since it does not change the type of the expression.',
            node.getStart(sourceFile),
            node.getEnd(),
          ).withFix('[No Description]', () => [
            {
              fileName: sourceFile.fileName,
              textChanges: [
                {
                  newText: '',
                  span: {
                    start: node.getEnd() - 1,
                    length: 1,
                  },
                },
              ],
            },
          ]);
        } else {
          // we know it's a nullable type
          // so figure out if the variable is used in a place that accepts nullable types

          const contextualType = getContextualType(checker, originalNode);
          if (contextualType) {
            // in strict mode you can't assign null to undefined, so we have to make sure that
            // the two types share a nullable type
            const typeIncludesUndefined = isTypeFlagSet(
              type,
              ts.TypeFlags.Undefined,
            );
            const typeIncludesNull = isTypeFlagSet(type, ts.TypeFlags.Null);
            const typeIncludesVoid = isTypeFlagSet(type, ts.TypeFlags.Void);

            const contextualTypeIncludesUndefined = isTypeFlagSet(
              contextualType,
              ts.TypeFlags.Undefined,
            );
            const contextualTypeIncludesNull = isTypeFlagSet(
              contextualType,
              ts.TypeFlags.Null,
            );
            const contextualTypeIncludesVoid = isTypeFlagSet(
              contextualType,
              ts.TypeFlags.Void,
            );

            // make sure that the parent accepts the same types
            // i.e. assigning `string | null | undefined` to `string | undefined` is invalid
            const isValidUndefined = typeIncludesUndefined
              ? contextualTypeIncludesUndefined
              : true;
            const isValidNull = typeIncludesNull
              ? contextualTypeIncludesNull
              : true;
            const isValidVoid = typeIncludesVoid
              ? contextualTypeIncludesVoid
              : true;

            if (isValidUndefined && isValidNull && isValidVoid) {
              report(
                'This assertion is unnecessary since the receiver accepts the original type of the expression.',
                node.getStart(sourceFile),
                node.getEnd(),
              ).withFix('[No Description]', () => [
                {
                  fileName: sourceFile.fileName,
                  textChanges: [
                    {
                      newText: '',
                      span: {
                        start: node.expression.getEnd(),
                        length: node.getEnd() - node.expression.getEnd(),
                      },
                    },
                  ],
                },
              ]);
            }
          }
        }
      },
      'TSAsExpression, TSTypeAssertion'(
        node: ts.AsExpression | ts.TypeAssertion,
      ): void {
        if (
          options.typesToIgnore?.includes(
            checker.typeToString(checker.getTypeFromTypeNode(node.type)),
          )
        ) {
          return;
        }

        const castType = checker.getTypeAtLocation(node);
        const uncastType = checker.getTypeAtLocation(node.expression);
        const typeIsUnchanged = isTypeUnchanged(uncastType, castType);

        const wouldSameTypeBeInferred = castType.isLiteral()
          ? isImplicitlyNarrowedConstDeclaration(node)
          : !isConstAssertion(node.type);

        if (typeIsUnchanged && wouldSameTypeBeInferred) {
          report(
            'This assertion is unnecessary since it does not change the type of the expression.',
            node.getStart(sourceFile),
            node.getEnd(),
          ).withFix('[No Description]', () => {
            if (ts.isTypeAssertionExpression(node)) {
              const openingAngleBracket = getTokenBefore(node.type, sourceFile);
              nullThrows(
                openingAngleBracket.kind === ts.SyntaxKind.LessThanToken
                  ? openingAngleBracket
                  : undefined,
                NullThrowsReasons.MissingToken('<', 'type annotation'),
              );
              const closingAngleBracket = getTokenAfter(node.type, sourceFile);
              nullThrows(
                openingAngleBracket.kind === ts.SyntaxKind.GreaterThanToken
                  ? openingAngleBracket
                  : undefined,
                NullThrowsReasons.MissingToken('>', 'type annotation'),
              );

              // < ( number ) > ( 3 + 5 )
              // ^---remove---^
              return [
                {
                  fileName: sourceFile.fileName,
                  textChanges: [
                    {
                      newText: '',
                      span: {
                        start: openingAngleBracket.getStart(sourceFile),
                        length:
                          closingAngleBracket.getEnd() -
                          openingAngleBracket.getStart(sourceFile),
                      },
                    },
                  ],
                },
              ];
            }
            // `as` is always present in TSAsExpression
            const asToken = getTokenAfter(node.expression, sourceFile);
            nullThrows(
              asToken.kind === ts.SyntaxKind.AsKeyword ? asToken : undefined,
              NullThrowsReasons.MissingToken('>', 'type annotation'),
            );

            // ( 3 + 5 )  as  number
            //          ^--remove--^
            return [
              {
                fileName: sourceFile.fileName,
                textChanges: [
                  {
                    newText: '',
                    span: {
                      start: asToken.getFullStart(),
                      length: node.getEnd() - asToken.getFullStart(),
                    },
                  },
                ],
              },
            ];
          });
        }

        // TODO - add contextually unnecessary check for this
      },
    };

    sourceFile.forEachChild(function cb(node) {
      if (ts.isNonNullExpression(node)) {
        visitor.TSNonNullExpression(node);
      } else if (
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node)
      ) {
        visitor['TSAsExpression, TSTypeAssertion'](node);
      }

      node.forEachChild(cb);
    });
  };
}

function getTokenBefore(node: ts.Node, sourceFile: ts.SourceFile) {
  const children = node.parent.getChildren(sourceFile);
  return children[children.indexOf(node) - 1];
}

function getTokenAfter(node: ts.Node, sourceFile: ts.SourceFile) {
  const children = node.parent.getChildren(sourceFile);
  return children[children.indexOf(node) + 1];
}
