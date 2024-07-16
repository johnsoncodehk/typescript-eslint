// There's lots of funny stuff due to the typing of ts.Node
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import type * as ts from 'typescript';

import { getDecorators, getModifiers } from './getModifiers';
import type { TSError } from './node-utils';
import {
  canContainDirective,
  createError,
  findNextToken,
  getBinaryExpressionType,
  getContainingFunction,
  getDeclarationKind,
  getLastModifier,
  getLineAndCharacterFor,
  getLocFor,
  getNamespaceModifiers,
  getRange,
  getTextForTokenKind,
  getTSNodeAccessibility,
  hasModifier,
  isChainExpression,
  isChildUnwrappableOptionalChain,
  isComma,
  isComputedProperty,
  isESTreeClassMember,
  isOptional,
  isThisInTypeQuery,
  isValidAssignmentTarget,
  nodeCanBeDecorated,
  nodeHasIllegalDecorators,
  nodeIsPresent,
  unescapeStringLiteralText,
} from './node-utils';
import type {
  ParserWeakMap,
  ParserWeakMapESTreeToTSNode,
} from './parser-options';
import type { SemanticOrSyntacticError } from './semantic-or-syntactic-errors';
import type { TSESTree, TSESTreeToTSNode, TSNode } from './ts-estree';
import { AST_NODE_TYPES } from './ts-estree';

export interface ConverterOptions {
  allowInvalidAST?: boolean;
  errorOnUnknownASTType?: boolean;
  shouldPreserveNodeMaps?: boolean;
  suppressDeprecatedPropertyWarnings?: boolean;
}

/**
 * Extends and formats a given error object
 * @param error the error object
 * @returns converted error object
 */
export function convertError(
  error: SemanticOrSyntacticError | ts.DiagnosticWithLocation,
): TSError {
  return createError(
    ('message' in error && error.message) || (error.messageText as string),
    error.file!,
    error.start!,
  );
}

export interface ASTMaps {
  esTreeNodeToTSNodeMap: ParserWeakMapESTreeToTSNode;
  tsNodeToESTreeNodeMap: ParserWeakMap<TSNode, TSESTree.Node>;
}

export class Converter {
  private readonly ast: ts.SourceFile;
  private readonly options: ConverterOptions;
  private readonly esTreeNodeToTSNodeMap = new WeakMap();
  private readonly tsNodeToESTreeNodeMap = new WeakMap();

  private allowPattern = false;

  /**
   * Converts a TypeScript node into an ESTree node
   * @param ast the full TypeScript AST
   * @param options additional options for the conversion
   * @returns the converted ESTreeNode
   */
  constructor(
    private ts: typeof import('typescript'),
    ast: ts.SourceFile,
    options?: ConverterOptions,
  ) {
    this.ast = ast;
    this.options = { ...options };
  }

  getASTMaps(): ASTMaps {
    return {
      esTreeNodeToTSNodeMap: this.esTreeNodeToTSNodeMap,
      tsNodeToESTreeNodeMap: this.tsNodeToESTreeNodeMap,
    };
  }

  convertProgram(): TSESTree.Program {
    return this.converter(this.ast) as TSESTree.Program;
  }

  /**
   * Converts a TypeScript node into an ESTree node.
   * @param node the child ts.Node
   * @param parent parentNode
   * @param allowPattern flag to determine if patterns are allowed
   * @returns the converted ESTree node
   */
  private converter(
    node?: ts.Node,
    parent?: ts.Node,
    allowPattern?: boolean,
  ): any {
    /**
     * Exit early for null and undefined
     */
    if (!node) {
      return null;
    }

    this.#checkModifiers(node);

    const pattern = this.allowPattern;
    if (allowPattern !== undefined) {
      this.allowPattern = allowPattern;
    }

    const result = this.convertNode(
      node as TSNode,
      (parent ?? node.parent) as TSNode,
    );

    this.registerTSNodeInNodeMap(node, result);

    this.allowPattern = pattern;
    return result;
  }

  /**
   * Fixes the exports of the given ts.Node
   * @returns the ESTreeNode with fixed exports
   */
  private fixExports<
    T extends
      | TSESTree.DefaultExportDeclarations
      | TSESTree.NamedExportDeclarations,
  >(
    node:
      | ts.ClassDeclaration
      | ts.ClassExpression
      | ts.EnumDeclaration
      | ts.FunctionDeclaration
      | ts.ImportEqualsDeclaration
      | ts.InterfaceDeclaration
      | ts.ModuleDeclaration
      | ts.TypeAliasDeclaration
      | ts.VariableStatement,
    result: T,
  ): T | TSESTree.ExportDefaultDeclaration | TSESTree.ExportNamedDeclaration {
    const isNamespaceNode =
      this.ts.isModuleDeclaration(node) &&
      Boolean(node.flags & this.ts.NodeFlags.Namespace);

    const modifiers = isNamespaceNode
      ? getNamespaceModifiers(this.ts, node)
      : getModifiers(this.ts, node);

    if (modifiers?.[0].kind === this.ts.SyntaxKind.ExportKeyword) {
      /**
       * Make sure that original node is registered instead of export
       */
      this.registerTSNodeInNodeMap(node, result);

      const exportKeyword = modifiers[0];
      const nextModifier = modifiers[1];
      const declarationIsDefault =
        nextModifier?.kind === this.ts.SyntaxKind.DefaultKeyword;

      const varToken = declarationIsDefault
        ? findNextToken(this.ts, nextModifier, this.ast, this.ast)
        : findNextToken(this.ts, exportKeyword, this.ast, this.ast);

      result.range[0] = varToken!.getStart(this.ast);
      result.loc = getLocFor(result.range, this.ast);

      if (declarationIsDefault) {
        return this.createNode<TSESTree.ExportDefaultDeclaration>(
          node as Exclude<typeof node, ts.ImportEqualsDeclaration>,
          {
            type: AST_NODE_TYPES.ExportDefaultDeclaration,
            declaration: result as TSESTree.DefaultExportDeclarations,
            range: [exportKeyword.getStart(this.ast), result.range[1]],
            exportKind: 'value',
          },
        );
      }
      const isType =
        result.type === AST_NODE_TYPES.TSInterfaceDeclaration ||
        result.type === AST_NODE_TYPES.TSTypeAliasDeclaration;
      const isDeclare = 'declare' in result && result.declare;
      return this.createNode<TSESTree.ExportNamedDeclaration>(
        node,
        // @ts-expect-error - TODO, narrow the types here
        this.#withDeprecatedAliasGetter(
          {
            type: AST_NODE_TYPES.ExportNamedDeclaration,
            declaration: result,
            specifiers: [],
            source: null,
            exportKind: isType || isDeclare ? 'type' : 'value',
            range: [exportKeyword.getStart(this.ast), result.range[1]],
            attributes: [],
          },
          'assertions',
          'attributes',
          true,
        ),
      );
    }

    return result;
  }

  /**
   * Register specific TypeScript node into map with first ESTree node provided
   */
  private registerTSNodeInNodeMap(
    node: ts.Node,
    result: TSESTree.Node | null,
  ): void {
    if (result && this.options.shouldPreserveNodeMaps) {
      if (!this.tsNodeToESTreeNodeMap.has(node)) {
        this.tsNodeToESTreeNodeMap.set(node, result);
      }
    }
  }

  /**
   * Converts a TypeScript node into an ESTree node.
   * @param child the child ts.Node
   * @param parent parentNode
   * @returns the converted ESTree node
   */
  private convertPattern(child?: ts.Node, parent?: ts.Node): any {
    return this.converter(child, parent, true);
  }

  /**
   * Converts a TypeScript node into an ESTree node.
   * @param child the child ts.Node
   * @param parent parentNode
   * @returns the converted ESTree node
   */
  private convertChild(child?: ts.Node, parent?: ts.Node): any {
    return this.converter(child, parent, false);
  }

  private createNode<T extends TSESTree.Node = TSESTree.Node>(
    // The 'parent' property will be added later if specified
    node: Omit<TSESTreeToTSNode<T>, 'parent'>,
    data: Omit<TSESTree.OptionalRangeAndLoc<T>, 'parent'>,
  ): T {
    const result = data;
    result.range ??= getRange(node, this.ast);
    result.loc ??= getLocFor(result.range, this.ast);

    if (result && this.options.shouldPreserveNodeMaps) {
      this.esTreeNodeToTSNodeMap.set(result, node);
    }
    return result as T;
  }

  private convertBindingNameWithTypeAnnotation(
    name: ts.BindingName,
    tsType: ts.TypeNode | undefined,
    parent?: ts.Node,
  ): TSESTree.BindingName {
    const id = this.convertPattern(name) as TSESTree.BindingName;

    if (tsType) {
      id.typeAnnotation = this.convertTypeAnnotation(tsType, parent);
      this.fixParentLocation(id, id.typeAnnotation.range);
    }

    return id;
  }

  /**
   * Converts a child into a type annotation. This creates an intermediary
   * TypeAnnotation node to match what Flow does.
   * @param child The TypeScript AST node to convert.
   * @param parent parentNode
   * @returns The type annotation node.
   */
  private convertTypeAnnotation(
    child: ts.TypeNode,
    parent: ts.Node | undefined,
  ): TSESTree.TSTypeAnnotation {
    // in FunctionType and ConstructorType typeAnnotation has 2 characters `=>` and in other places is just colon
    const offset =
      parent?.kind === this.ts.SyntaxKind.FunctionType ||
      parent?.kind === this.ts.SyntaxKind.ConstructorType
        ? 2
        : 1;
    const annotationStartCol = child.getFullStart() - offset;
    const range: TSESTree.Range = [annotationStartCol, child.end];
    const loc = getLocFor(range, this.ast);

    return {
      type: AST_NODE_TYPES.TSTypeAnnotation,
      loc,
      range,
      typeAnnotation: this.convertChild(child),
    } as TSESTree.TSTypeAnnotation;
  }

  /**
   * Coverts body Nodes and add a directive field to StringLiterals
   * @param nodes of ts.Node
   * @param parent parentNode
   * @returns Array of body statements
   */
  private convertBodyExpressions(
    nodes: ts.NodeArray<ts.Statement>,
    parent:
      | ts.Block
      | ts.ClassStaticBlockDeclaration
      | ts.ModuleBlock
      | ts.SourceFile,
  ): TSESTree.Statement[] {
    let allowDirectives = canContainDirective(parent);

    return (
      nodes
        .map(statement => {
          const child = this.convertChild(statement);
          if (allowDirectives) {
            if (
              child?.expression &&
              this.ts.isExpressionStatement(statement) &&
              this.ts.isStringLiteral(statement.expression)
            ) {
              const raw = child.expression.raw;
              child.directive = raw.slice(1, -1);
              return child; // child can be null, but it's filtered below
            }
            allowDirectives = false;
          }
          return child; // child can be null, but it's filtered below
        })
        // filter out unknown nodes for now
        .filter(statement => statement)
    );
  }

  /**
   * Converts a ts.Node's typeArguments to TSTypeParameterInstantiation node
   * @param typeArguments ts.NodeArray typeArguments
   * @param node parent used to create this node
   * @returns TypeParameterInstantiation node
   */
  private convertTypeArgumentsToTypeParameterInstantiation(
    typeArguments: ts.NodeArray<ts.TypeNode>,
    node: TSESTreeToTSNode<TSESTree.TSTypeParameterInstantiation>,
  ): TSESTree.TSTypeParameterInstantiation {
    const greaterThanToken = findNextToken(
      this.ts,
      typeArguments,
      this.ast,
      this.ast,
    )!;

    return this.createNode<TSESTree.TSTypeParameterInstantiation>(node, {
      type: AST_NODE_TYPES.TSTypeParameterInstantiation,
      range: [typeArguments.pos - 1, greaterThanToken.end],
      params: typeArguments.map(typeArgument =>
        this.convertChild(typeArgument),
      ),
    });
  }

  /**
   * Converts a ts.Node's typeParameters to TSTypeParameterDeclaration node
   * @param typeParameters ts.Node typeParameters
   * @returns TypeParameterDeclaration node
   */
  private convertTSTypeParametersToTypeParametersDeclaration(
    typeParameters: ts.NodeArray<ts.TypeParameterDeclaration>,
  ): TSESTree.TSTypeParameterDeclaration {
    const greaterThanToken = findNextToken(
      this.ts,
      typeParameters,
      this.ast,
      this.ast,
    )!;
    const range: TSESTree.Range = [
      typeParameters.pos - 1,
      greaterThanToken.end,
    ];

    return {
      type: AST_NODE_TYPES.TSTypeParameterDeclaration,
      range,
      loc: getLocFor(range, this.ast),
      params: typeParameters.map(typeParameter =>
        this.convertChild(typeParameter),
      ),
    } as TSESTree.TSTypeParameterDeclaration;
  }

  /**
   * Converts an array of ts.Node parameters into an array of ESTreeNode params
   * @param parameters An array of ts.Node params to be converted
   * @returns an array of converted ESTreeNode params
   */
  private convertParameters(
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
  ): TSESTree.Parameter[] {
    if (!parameters?.length) {
      return [];
    }
    return parameters.map(param => {
      const convertedParam = this.convertChild(param) as TSESTree.Parameter;

      convertedParam.decorators =
        getDecorators(this.ts, param)?.map(el => this.convertChild(el)) ?? [];

      return convertedParam;
    });
  }

  private convertChainExpression(
    node: TSESTree.ChainElement,
    tsNode:
      | ts.CallExpression
      | ts.ElementAccessExpression
      | ts.NonNullExpression
      | ts.PropertyAccessExpression,
  ): TSESTree.ChainElement | TSESTree.ChainExpression {
    const { child, isOptional } = ((): {
      child: TSESTree.Node;
      isOptional: boolean;
    } => {
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        return { child: node.object, isOptional: node.optional };
      }
      if (node.type === AST_NODE_TYPES.CallExpression) {
        return { child: node.callee, isOptional: node.optional };
      }
      return { child: node.expression, isOptional: false };
    })();
    const isChildUnwrappable = isChildUnwrappableOptionalChain(tsNode, child);

    if (!isChildUnwrappable && !isOptional) {
      return node;
    }

    if (isChildUnwrappable && isChainExpression(child)) {
      // unwrap the chain expression child
      const newChild = child.expression;
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        node.object = newChild;
      } else if (node.type === AST_NODE_TYPES.CallExpression) {
        node.callee = newChild;
      } else {
        node.expression = newChild;
      }
    }

    return this.createNode<TSESTree.ChainExpression>(tsNode, {
      type: AST_NODE_TYPES.ChainExpression,
      expression: node,
    });
  }

  /**
   * For nodes that are copied directly from the TypeScript AST into
   * ESTree mostly as-is. The only difference is the addition of a type
   * property instead of a kind property. Recursively copies all children.
   */
  private deeplyCopy(node: TSNode): any {
    if (node.kind === this.ts.SyntaxKind.JSDocFunctionType) {
      this.#throwError(
        node,
        'JSDoc types can only be used inside documentation comments.',
      );
    }

    const customType = `TS${this.ts.SyntaxKind[node.kind]}` as AST_NODE_TYPES;

    /**
     * If the "errorOnUnknownASTType" option is set to true, throw an error,
     * otherwise fallback to just including the unknown type as-is.
     */
    if (this.options.errorOnUnknownASTType && !AST_NODE_TYPES[customType]) {
      throw new Error(`Unknown AST_NODE_TYPE: "${customType}"`);
    }

    const result = this.createNode<any>(node, {
      type: customType,
    });

    if ('type' in node) {
      result.typeAnnotation =
        node.type && 'kind' in node.type && this.ts.isTypeNode(node.type)
          ? this.convertTypeAnnotation(node.type, node)
          : null;
    }
    if ('typeArguments' in node) {
      result.typeArguments =
        node.typeArguments && 'pos' in node.typeArguments
          ? this.convertTypeArgumentsToTypeParameterInstantiation(
              node.typeArguments,
              node,
            )
          : null;
      this.#withDeprecatedAliasGetter(
        result,
        'typeParameters',
        'typeArguments',
      );
    }
    if ('typeParameters' in node) {
      result.typeParameters =
        node.typeParameters && 'pos' in node.typeParameters
          ? this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            )
          : null;
    }
    const decorators = getDecorators(this.ts, node);
    if (decorators?.length) {
      result.decorators = decorators.map(el => this.convertChild(el));
    }

    // keys we never want to clone from the base typescript node as they
    // introduce garbage into our AST
    const KEYS_TO_NOT_COPY = new Set([
      '_children',
      'decorators',
      'end',
      'flags',
      'illegalDecorators',
      'heritageClauses',
      'locals',
      'localSymbol',
      'jsDoc',
      'kind',
      'modifierFlagsCache',
      'modifiers',
      'nextContainer',
      'parent',
      'pos',
      'symbol',
      'transformFlags',
      'type',
      'typeArguments',
      'typeParameters',
    ]);

    Object.entries<any>(node)
      .filter(([key]) => !KEYS_TO_NOT_COPY.has(key))
      .forEach(([key, value]) => {
        if (Array.isArray(value)) {
          result[key] = value.map(el => this.convertChild(el as TSNode));
        } else if (value && typeof value === 'object' && value.kind) {
          // need to check node[key].kind to ensure we don't try to convert a symbol
          result[key] = this.convertChild(value as TSNode);
        } else {
          result[key] = value;
        }
      });
    return result;
  }

  private convertJSXIdentifier(
    node: ts.Identifier | ts.ThisExpression,
  ): TSESTree.JSXIdentifier {
    const result = this.createNode<TSESTree.JSXIdentifier>(node, {
      type: AST_NODE_TYPES.JSXIdentifier,
      name: node.getText(),
    });
    this.registerTSNodeInNodeMap(node, result);
    return result;
  }

  private convertJSXNamespaceOrIdentifier(
    node: ts.JsxNamespacedName | ts.Identifier | ts.ThisExpression,
  ): TSESTree.JSXIdentifier | TSESTree.JSXNamespacedName {
    // TypeScript@5.1 added in ts.JsxNamespacedName directly
    // We prefer using that if it's relevant for this node type
    if (node.kind === this.ts.SyntaxKind.JsxNamespacedName) {
      const result = this.createNode<TSESTree.JSXNamespacedName>(node, {
        type: AST_NODE_TYPES.JSXNamespacedName,
        namespace: this.createNode(node.namespace, {
          type: AST_NODE_TYPES.JSXIdentifier,
          name: node.namespace.text,
        }),
        name: this.createNode(node.name, {
          type: AST_NODE_TYPES.JSXIdentifier,
          name: node.name.text,
        }),
      });
      this.registerTSNodeInNodeMap(node, result);
      return result;
    }

    // TypeScript@<5.1 has to manually parse the JSX attributes
    const text = node.getText();
    const colonIndex = text.indexOf(':');
    // this is intentional we can ignore conversion if `:` is in first character
    if (colonIndex > 0) {
      const range = getRange(node, this.ast);
      // @ts-expect-error -- TypeScript@<5.1 doesn't have ts.JsxNamespacedName
      const result = this.createNode<TSESTree.JSXNamespacedName>(node, {
        type: AST_NODE_TYPES.JSXNamespacedName,
        namespace: this.createNode<TSESTree.JSXIdentifier>(node, {
          type: AST_NODE_TYPES.JSXIdentifier,
          name: text.slice(0, colonIndex),
          range: [range[0], range[0] + colonIndex],
        }),
        name: this.createNode<TSESTree.JSXIdentifier>(node, {
          type: AST_NODE_TYPES.JSXIdentifier,
          name: text.slice(colonIndex + 1),
          range: [range[0] + colonIndex + 1, range[1]],
        }),
        range,
      });
      this.registerTSNodeInNodeMap(node, result);
      return result;
    }

    return this.convertJSXIdentifier(node);
  }

  /**
   * Converts a TypeScript JSX node.tagName into an ESTree node.name
   * @param node the tagName object from a JSX ts.Node
   * @returns the converted ESTree name object
   */
  private convertJSXTagName(
    node: ts.JsxTagNameExpression,
    parent: ts.Node,
  ): TSESTree.JSXTagNameExpression {
    let result: TSESTree.JSXTagNameExpression;
    switch (node.kind) {
      case this.ts.SyntaxKind.PropertyAccessExpression:
        if (node.name.kind === this.ts.SyntaxKind.PrivateIdentifier) {
          // This is one of the few times where TS explicitly errors, and doesn't even gracefully handle the syntax.
          // So we shouldn't ever get into this state to begin with.
          this.#throwError(node.name, 'Non-private identifier expected.');
        }

        result = this.createNode<TSESTree.JSXMemberExpression>(node, {
          type: AST_NODE_TYPES.JSXMemberExpression,
          object: this.convertJSXTagName(node.expression, parent),
          property: this.convertJSXIdentifier(node.name),
        });
        break;

      case this.ts.SyntaxKind.ThisKeyword:
      case this.ts.SyntaxKind.Identifier:
      default:
        return this.convertJSXNamespaceOrIdentifier(node);
    }

    this.registerTSNodeInNodeMap(node, result);
    return result;
  }

  private convertMethodSignature(
    node:
      | ts.GetAccessorDeclaration
      | ts.MethodSignature
      | ts.SetAccessorDeclaration,
  ): TSESTree.TSMethodSignature {
    return this.createNode<TSESTree.TSMethodSignature>(node, {
      type: AST_NODE_TYPES.TSMethodSignature,
      accessibility: getTSNodeAccessibility(this.ts, node),
      computed: isComputedProperty(node.name),
      key: this.convertChild(node.name),
      kind: ((): 'get' | 'method' | 'set' => {
        switch (node.kind) {
          case this.ts.SyntaxKind.GetAccessor:
            return 'get';

          case this.ts.SyntaxKind.SetAccessor:
            return 'set';

          case this.ts.SyntaxKind.MethodSignature:
            return 'method';
        }
      })(),
      optional: isOptional(node),
      params: this.convertParameters(node.parameters),
      returnType: node.type && this.convertTypeAnnotation(node.type, node),
      readonly: hasModifier(this.ts, this.ts.SyntaxKind.ReadonlyKeyword, node),
      static: hasModifier(this.ts, this.ts.SyntaxKind.StaticKeyword, node),
      typeParameters:
        node.typeParameters &&
        this.convertTSTypeParametersToTypeParametersDeclaration(
          node.typeParameters,
        ),
    });
  }

  private convertImportAttributes(
    node: ts.ImportAttributes | undefined,
  ): TSESTree.ImportAttribute[] {
    return node === undefined
      ? []
      : node.elements.map(element => this.convertChild(element));
  }

  /**
   * Uses the provided range location to adjust the location data of the given Node
   * @param result The node that will have its location data mutated
   * @param childRange The child node range used to expand location
   */
  private fixParentLocation(
    result: TSESTree.BaseNode,
    childRange: [number, number],
  ): void {
    if (childRange[0] < result.range[0]) {
      result.range[0] = childRange[0];
      result.loc.start = getLineAndCharacterFor(result.range[0], this.ast);
    }
    if (childRange[1] > result.range[1]) {
      result.range[1] = childRange[1];
      result.loc.end = getLineAndCharacterFor(result.range[1], this.ast);
    }
  }

  private assertModuleSpecifier(
    node: ts.ExportDeclaration | ts.ImportDeclaration,
    allowNull: boolean,
  ): void {
    if (!allowNull && node.moduleSpecifier == null) {
      this.#throwUnlessAllowInvalidAST(
        node,
        'Module specifier must be a string literal.',
      );
    }

    if (
      node.moduleSpecifier &&
      node.moduleSpecifier?.kind !== this.ts.SyntaxKind.StringLiteral
    ) {
      this.#throwUnlessAllowInvalidAST(
        node.moduleSpecifier,
        'Module specifier must be a string literal.',
      );
    }
  }

  /**
   * Converts a TypeScript node into an ESTree node.
   * The core of the conversion logic:
   * Identify and convert each relevant TypeScript this.ts.SyntaxKind
   * @returns the converted ESTree node
   */
  private convertNode(node: TSNode, parent: TSNode): TSESTree.Node | null {
    switch (node.kind) {
      case this.ts.SyntaxKind.SourceFile: {
        return this.createNode<TSESTree.Program>(node, {
          type: AST_NODE_TYPES.Program,
          body: this.convertBodyExpressions(node.statements, node),
          comments: undefined,
          range: [node.getStart(this.ast), node.endOfFileToken.end],
          sourceType: node.externalModuleIndicator ? 'module' : 'script',
          tokens: undefined,
        });
      }

      case this.ts.SyntaxKind.Block: {
        return this.createNode<TSESTree.BlockStatement>(node, {
          type: AST_NODE_TYPES.BlockStatement,
          body: this.convertBodyExpressions(node.statements, node),
        });
      }

      case this.ts.SyntaxKind.Identifier: {
        if (isThisInTypeQuery(this.ts, node)) {
          // special case for `typeof this.foo` - TS emits an Identifier for `this`
          // but we want to treat it as a ThisExpression for consistency
          return this.createNode<TSESTree.ThisExpression>(node, {
            type: AST_NODE_TYPES.ThisExpression,
          });
        }
        return this.createNode<TSESTree.Identifier>(node, {
          type: AST_NODE_TYPES.Identifier,
          decorators: [],
          name: node.text,
          optional: false,
          typeAnnotation: undefined,
        });
      }

      case this.ts.SyntaxKind.PrivateIdentifier: {
        return this.createNode<TSESTree.PrivateIdentifier>(node, {
          type: AST_NODE_TYPES.PrivateIdentifier,
          // typescript includes the `#` in the text
          name: node.text.slice(1),
        });
      }

      case this.ts.SyntaxKind.WithStatement:
        return this.createNode<TSESTree.WithStatement>(node, {
          type: AST_NODE_TYPES.WithStatement,
          object: this.convertChild(node.expression),
          body: this.convertChild(node.statement),
        });

      // Control Flow

      case this.ts.SyntaxKind.ReturnStatement:
        return this.createNode<TSESTree.ReturnStatement>(node, {
          type: AST_NODE_TYPES.ReturnStatement,
          argument: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.LabeledStatement:
        return this.createNode<TSESTree.LabeledStatement>(node, {
          type: AST_NODE_TYPES.LabeledStatement,
          label: this.convertChild(node.label),
          body: this.convertChild(node.statement),
        });

      case this.ts.SyntaxKind.ContinueStatement:
        return this.createNode<TSESTree.ContinueStatement>(node, {
          type: AST_NODE_TYPES.ContinueStatement,
          label: this.convertChild(node.label),
        });

      case this.ts.SyntaxKind.BreakStatement:
        return this.createNode<TSESTree.BreakStatement>(node, {
          type: AST_NODE_TYPES.BreakStatement,
          label: this.convertChild(node.label),
        });

      // Choice

      case this.ts.SyntaxKind.IfStatement:
        return this.createNode<TSESTree.IfStatement>(node, {
          type: AST_NODE_TYPES.IfStatement,
          test: this.convertChild(node.expression),
          consequent: this.convertChild(node.thenStatement),
          alternate: this.convertChild(node.elseStatement),
        });

      case this.ts.SyntaxKind.SwitchStatement:
        if (
          node.caseBlock.clauses.filter(
            switchCase => switchCase.kind === this.ts.SyntaxKind.DefaultClause,
          ).length > 1
        ) {
          this.#throwError(
            node,
            "A 'default' clause cannot appear more than once in a 'switch' statement.",
          );
        }

        return this.createNode<TSESTree.SwitchStatement>(node, {
          type: AST_NODE_TYPES.SwitchStatement,
          discriminant: this.convertChild(node.expression),
          cases: node.caseBlock.clauses.map(el => this.convertChild(el)),
        });

      case this.ts.SyntaxKind.CaseClause:
      case this.ts.SyntaxKind.DefaultClause:
        return this.createNode<TSESTree.SwitchCase>(node, {
          type: AST_NODE_TYPES.SwitchCase,
          // expression is present in case only
          test:
            node.kind === this.ts.SyntaxKind.CaseClause
              ? this.convertChild(node.expression)
              : null,
          consequent: node.statements.map(el => this.convertChild(el)),
        });

      // Exceptions

      case this.ts.SyntaxKind.ThrowStatement:
        if (node.expression.end === node.expression.pos) {
          this.#throwUnlessAllowInvalidAST(
            node,
            'A throw statement must throw an expression.',
          );
        }

        return this.createNode<TSESTree.ThrowStatement>(node, {
          type: AST_NODE_TYPES.ThrowStatement,
          argument: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.TryStatement:
        return this.createNode<TSESTree.TryStatement>(node, {
          type: AST_NODE_TYPES.TryStatement,
          block: this.convertChild(node.tryBlock),
          handler: this.convertChild(node.catchClause),
          finalizer: this.convertChild(node.finallyBlock),
        });

      case this.ts.SyntaxKind.CatchClause:
        if (node.variableDeclaration?.initializer) {
          this.#throwError(
            node.variableDeclaration.initializer,
            'Catch clause variable cannot have an initializer.',
          );
        }
        return this.createNode<TSESTree.CatchClause>(node, {
          type: AST_NODE_TYPES.CatchClause,
          param: node.variableDeclaration
            ? this.convertBindingNameWithTypeAnnotation(
                node.variableDeclaration.name,
                node.variableDeclaration.type,
              )
            : null,
          body: this.convertChild(node.block),
        });

      // Loops

      case this.ts.SyntaxKind.WhileStatement:
        return this.createNode<TSESTree.WhileStatement>(node, {
          type: AST_NODE_TYPES.WhileStatement,
          test: this.convertChild(node.expression),
          body: this.convertChild(node.statement),
        });

      /**
       * Unlike other parsers, TypeScript calls a "DoWhileStatement"
       * a "DoStatement"
       */
      case this.ts.SyntaxKind.DoStatement:
        return this.createNode<TSESTree.DoWhileStatement>(node, {
          type: AST_NODE_TYPES.DoWhileStatement,
          test: this.convertChild(node.expression),
          body: this.convertChild(node.statement),
        });

      case this.ts.SyntaxKind.ForStatement:
        return this.createNode<TSESTree.ForStatement>(node, {
          type: AST_NODE_TYPES.ForStatement,
          init: this.convertChild(node.initializer),
          test: this.convertChild(node.condition),
          update: this.convertChild(node.incrementor),
          body: this.convertChild(node.statement),
        });

      case this.ts.SyntaxKind.ForInStatement:
        this.#checkForStatementDeclaration(node.initializer);
        return this.createNode<TSESTree.ForInStatement>(node, {
          type: AST_NODE_TYPES.ForInStatement,
          left: this.convertPattern(node.initializer),
          right: this.convertChild(node.expression),
          body: this.convertChild(node.statement),
        });

      case this.ts.SyntaxKind.ForOfStatement:
        return this.createNode<TSESTree.ForOfStatement>(node, {
          type: AST_NODE_TYPES.ForOfStatement,
          left: this.convertPattern(node.initializer),
          right: this.convertChild(node.expression),
          body: this.convertChild(node.statement),
          await: Boolean(
            node.awaitModifier &&
              node.awaitModifier.kind === this.ts.SyntaxKind.AwaitKeyword,
          ),
        });

      // Declarations

      case this.ts.SyntaxKind.FunctionDeclaration: {
        const isDeclare = hasModifier(
          this.ts,
          this.ts.SyntaxKind.DeclareKeyword,
          node,
        );
        const isAsync = hasModifier(
          this.ts,
          this.ts.SyntaxKind.AsyncKeyword,
          node,
        );
        const isGenerator = !!node.asteriskToken;
        if (isDeclare) {
          if (node.body) {
            this.#throwError(
              node,
              'An implementation cannot be declared in ambient contexts.',
            );
          } else if (isAsync) {
            this.#throwError(
              node,
              "'async' modifier cannot be used in an ambient context.",
            );
          } else if (isGenerator) {
            this.#throwError(
              node,
              'Generators are not allowed in an ambient context.',
            );
          }
        } else {
          if (!node.body && isGenerator) {
            this.#throwError(
              node,
              'A function signature cannot be declared as a generator.',
            );
          }
        }

        const result = this.createNode<
          TSESTree.FunctionDeclaration | TSESTree.TSDeclareFunction
        >(node, {
          // declare implies no body due to the invariant above
          type: !node.body
            ? AST_NODE_TYPES.TSDeclareFunction
            : AST_NODE_TYPES.FunctionDeclaration,
          async: isAsync,
          body: this.convertChild(node.body) || undefined,
          declare: isDeclare,
          expression: false,
          generator: isGenerator,
          id: this.convertChild(node.name),
          params: this.convertParameters(node.parameters),
          returnType: node.type && this.convertTypeAnnotation(node.type, node),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });

        return this.fixExports(node, result);
      }

      case this.ts.SyntaxKind.VariableDeclaration: {
        return this.createNode<TSESTree.VariableDeclarator>(node, {
          type: AST_NODE_TYPES.VariableDeclarator,
          definite: !!node.exclamationToken,
          id: this.convertBindingNameWithTypeAnnotation(
            node.name,
            node.type,
            node,
          ),
          init: this.convertChild(node.initializer),
        });
      }

      case this.ts.SyntaxKind.VariableStatement: {
        const result = this.createNode<TSESTree.VariableDeclaration>(node, {
          type: AST_NODE_TYPES.VariableDeclaration,
          declarations: node.declarationList.declarations.map(el =>
            this.convertChild(el),
          ),
          declare: hasModifier(
            this.ts,
            this.ts.SyntaxKind.DeclareKeyword,
            node,
          ),
          kind: getDeclarationKind(node.declarationList),
        });

        if (!result.declarations.length) {
          this.#throwUnlessAllowInvalidAST(
            node,
            'A variable declaration list must have at least one variable declarator.',
          );
        }
        if (result.kind === 'using' || result.kind === 'await using') {
          node.declarationList.declarations.forEach((declaration, i) => {
            if (result.declarations[i].init == null) {
              this.#throwError(
                declaration,
                `'${result.kind}' declarations must be initialized.`,
              );
            }
            if (result.declarations[i].id.type !== AST_NODE_TYPES.Identifier) {
              this.#throwError(
                declaration.name,
                `'${result.kind}' declarations may not have binding patterns.`,
              );
            }
          });
        }

        /**
         * Semantically, decorators are not allowed on variable declarations,
         * Pre 4.8 TS would include them in the AST, so we did as well.
         * However as of 4.8 TS no longer includes it (as it is, well, invalid).
         *
         * So for consistency across versions, we no longer include it either.
         */
        return this.fixExports(node, result);
      }

      // mostly for for-of, for-in
      case this.ts.SyntaxKind.VariableDeclarationList: {
        const result = this.createNode<TSESTree.VariableDeclaration>(node, {
          type: AST_NODE_TYPES.VariableDeclaration,
          declarations: node.declarations.map(el => this.convertChild(el)),
          declare: false,
          kind: getDeclarationKind(node),
        });

        if (result.kind === 'using' || result.kind === 'await using') {
          node.declarations.forEach((declaration, i) => {
            if (result.declarations[i].init != null) {
              this.#throwError(
                declaration,
                `'${result.kind}' declarations may not be initialized in for statement.`,
              );
            }
            if (result.declarations[i].id.type !== AST_NODE_TYPES.Identifier) {
              this.#throwError(
                declaration.name,
                `'${result.kind}' declarations may not have binding patterns.`,
              );
            }
          });
        }
        return result;
      }

      // Expressions

      case this.ts.SyntaxKind.ExpressionStatement:
        return this.createNode<TSESTree.ExpressionStatement>(node, {
          type: AST_NODE_TYPES.ExpressionStatement,
          directive: undefined,
          expression: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.ThisKeyword:
        return this.createNode<TSESTree.ThisExpression>(node, {
          type: AST_NODE_TYPES.ThisExpression,
        });

      case this.ts.SyntaxKind.ArrayLiteralExpression: {
        // TypeScript uses ArrayLiteralExpression in destructuring assignment, too
        if (this.allowPattern) {
          return this.createNode<TSESTree.ArrayPattern>(node, {
            type: AST_NODE_TYPES.ArrayPattern,
            decorators: [],
            elements: node.elements.map(el => this.convertPattern(el)),
            optional: false,
            typeAnnotation: undefined,
          });
        }
        return this.createNode<TSESTree.ArrayExpression>(node, {
          type: AST_NODE_TYPES.ArrayExpression,
          elements: node.elements.map(el => this.convertChild(el)),
        });
      }

      case this.ts.SyntaxKind.ObjectLiteralExpression: {
        // TypeScript uses ObjectLiteralExpression in destructuring assignment, too
        if (this.allowPattern) {
          return this.createNode<TSESTree.ObjectPattern>(node, {
            type: AST_NODE_TYPES.ObjectPattern,
            decorators: [],
            optional: false,
            properties: node.properties.map(el => this.convertPattern(el)),
            typeAnnotation: undefined,
          });
        }

        const properties: TSESTree.Property[] = [];
        for (const property of node.properties) {
          if (
            (property.kind === this.ts.SyntaxKind.GetAccessor ||
              property.kind === this.ts.SyntaxKind.SetAccessor ||
              property.kind === this.ts.SyntaxKind.MethodDeclaration) &&
            !property.body
          ) {
            this.#throwUnlessAllowInvalidAST(property.end - 1, "'{' expected.");
          }

          properties.push(this.convertChild(property) as TSESTree.Property);
        }

        return this.createNode<TSESTree.ObjectExpression>(node, {
          type: AST_NODE_TYPES.ObjectExpression,
          properties,
        });
      }

      case this.ts.SyntaxKind.PropertyAssignment: {
        // eslint-disable-next-line deprecation/deprecation
        const { questionToken, exclamationToken } = node;

        if (questionToken) {
          this.#throwError(
            questionToken,
            'A property assignment cannot have a question token.',
          );
        }

        if (exclamationToken) {
          this.#throwError(
            exclamationToken,
            'A property assignment cannot have an exclamation token.',
          );
        }

        return this.createNode<TSESTree.Property>(node, {
          type: AST_NODE_TYPES.Property,
          key: this.convertChild(node.name),
          value: this.converter(node.initializer, node, this.allowPattern),
          computed: isComputedProperty(node.name),
          method: false,
          optional: false,
          shorthand: false,
          kind: 'init',
        });
      }

      case this.ts.SyntaxKind.ShorthandPropertyAssignment: {
        // eslint-disable-next-line deprecation/deprecation
        const { modifiers, questionToken, exclamationToken } = node;

        if (modifiers) {
          this.#throwError(
            modifiers[0],
            'A shorthand property assignment cannot have modifiers.',
          );
        }

        if (questionToken) {
          this.#throwError(
            questionToken,
            'A shorthand property assignment cannot have a question token.',
          );
        }

        if (exclamationToken) {
          this.#throwError(
            exclamationToken,
            'A shorthand property assignment cannot have an exclamation token.',
          );
        }

        if (node.objectAssignmentInitializer) {
          return this.createNode<TSESTree.Property>(node, {
            type: AST_NODE_TYPES.Property,
            key: this.convertChild(node.name),
            value: this.createNode<TSESTree.AssignmentPattern>(node, {
              type: AST_NODE_TYPES.AssignmentPattern,
              decorators: [],
              left: this.convertPattern(node.name),
              optional: false,
              right: this.convertChild(node.objectAssignmentInitializer),
              typeAnnotation: undefined,
            }),
            computed: false,
            method: false,
            optional: false,
            shorthand: true,
            kind: 'init',
          });
        }
        return this.createNode<TSESTree.Property>(node, {
          type: AST_NODE_TYPES.Property,
          computed: false,
          key: this.convertChild(node.name),
          kind: 'init',
          method: false,
          optional: false,
          shorthand: true,
          value: this.convertChild(node.name),
        });
      }

      case this.ts.SyntaxKind.ComputedPropertyName:
        return this.convertChild(node.expression);

      case this.ts.SyntaxKind.PropertyDeclaration: {
        const isAbstract = hasModifier(
          this.ts,
          this.ts.SyntaxKind.AbstractKeyword,
          node,
        );

        if (isAbstract && node.initializer) {
          this.#throwError(
            node.initializer,
            `Abstract property cannot have an initializer.`,
          );
        }

        const isAccessor = hasModifier(
          this.ts,
          this.ts.SyntaxKind.AccessorKeyword,
          node,
        );
        const type = (() => {
          if (isAccessor) {
            if (isAbstract) {
              return AST_NODE_TYPES.TSAbstractAccessorProperty;
            }
            return AST_NODE_TYPES.AccessorProperty;
          }

          if (isAbstract) {
            return AST_NODE_TYPES.TSAbstractPropertyDefinition;
          }
          return AST_NODE_TYPES.PropertyDefinition;
        })();

        const key = this.convertChild(node.name);

        return this.createNode<
          | TSESTree.AccessorProperty
          | TSESTree.PropertyDefinition
          | TSESTree.TSAbstractAccessorProperty
          | TSESTree.TSAbstractPropertyDefinition
        >(node, {
          type,
          key,
          accessibility: getTSNodeAccessibility(this.ts, node),
          value: isAbstract ? null : this.convertChild(node.initializer),
          computed: isComputedProperty(node.name),
          static: hasModifier(this.ts, this.ts.SyntaxKind.StaticKeyword, node),
          readonly: hasModifier(
            this.ts,
            this.ts.SyntaxKind.ReadonlyKeyword,
            node,
          ),
          decorators:
            getDecorators(this.ts, node)?.map(el => this.convertChild(el)) ??
            [],

          declare: hasModifier(
            this.ts,
            this.ts.SyntaxKind.DeclareKeyword,
            node,
          ),
          override: hasModifier(
            this.ts,
            this.ts.SyntaxKind.OverrideKeyword,
            node,
          ),
          typeAnnotation:
            node.type && this.convertTypeAnnotation(node.type, node),
          optional:
            (key.type === AST_NODE_TYPES.Literal ||
              node.name.kind === this.ts.SyntaxKind.Identifier ||
              node.name.kind === this.ts.SyntaxKind.ComputedPropertyName ||
              node.name.kind === this.ts.SyntaxKind.PrivateIdentifier) &&
            !!node.questionToken,
          definite: !!node.exclamationToken,
        });
      }

      case this.ts.SyntaxKind.GetAccessor:
      case this.ts.SyntaxKind.SetAccessor: {
        if (
          node.parent.kind === this.ts.SyntaxKind.InterfaceDeclaration ||
          node.parent.kind === this.ts.SyntaxKind.TypeLiteral
        ) {
          return this.convertMethodSignature(node);
        }
      }
      // otherwise, it is a non-type accessor - intentional fallthrough
      case this.ts.SyntaxKind.MethodDeclaration: {
        const method = this.createNode<
          TSESTree.FunctionExpression | TSESTree.TSEmptyBodyFunctionExpression
        >(node, {
          type: !node.body
            ? AST_NODE_TYPES.TSEmptyBodyFunctionExpression
            : AST_NODE_TYPES.FunctionExpression,
          id: null,
          generator: !!node.asteriskToken,
          expression: false, // ESTreeNode as ESTreeNode here
          async: hasModifier(this.ts, this.ts.SyntaxKind.AsyncKeyword, node),
          body: this.convertChild(node.body),
          declare: false,
          range: [node.parameters.pos - 1, node.end],
          params: [],
          returnType: node.type && this.convertTypeAnnotation(node.type, node),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });

        if (method.typeParameters) {
          this.fixParentLocation(method, method.typeParameters.range);
        }

        let result:
          | TSESTree.MethodDefinition
          | TSESTree.Property
          | TSESTree.TSAbstractMethodDefinition;

        if (parent.kind === this.ts.SyntaxKind.ObjectLiteralExpression) {
          method.params = node.parameters.map(el => this.convertChild(el));

          result = this.createNode<TSESTree.Property>(node, {
            type: AST_NODE_TYPES.Property,
            key: this.convertChild(node.name),
            value: method,
            computed: isComputedProperty(node.name),
            optional: !!node.questionToken,
            method: node.kind === this.ts.SyntaxKind.MethodDeclaration,
            shorthand: false,
            kind: 'init',
          });
        } else {
          // class

          /**
           * Unlike in object literal methods, class method params can have decorators
           */
          method.params = this.convertParameters(node.parameters);

          /**
           * TypeScript class methods can be defined as "abstract"
           */
          const methodDefinitionType = hasModifier(
            this.ts,
            this.ts.SyntaxKind.AbstractKeyword,
            node,
          )
            ? AST_NODE_TYPES.TSAbstractMethodDefinition
            : AST_NODE_TYPES.MethodDefinition;

          result = this.createNode<
            TSESTree.MethodDefinition | TSESTree.TSAbstractMethodDefinition
          >(node, {
            type: methodDefinitionType,
            accessibility: getTSNodeAccessibility(this.ts, node),
            computed: isComputedProperty(node.name),
            decorators:
              getDecorators(this.ts, node)?.map(el => this.convertChild(el)) ??
              [],
            key: this.convertChild(node.name),
            kind: 'method',
            optional: !!node.questionToken,
            override: hasModifier(
              this.ts,
              this.ts.SyntaxKind.OverrideKeyword,
              node,
            ),
            static: hasModifier(
              this.ts,
              this.ts.SyntaxKind.StaticKeyword,
              node,
            ),
            value: method,
          });
        }

        if (node.kind === this.ts.SyntaxKind.GetAccessor) {
          result.kind = 'get';
        } else if (node.kind === this.ts.SyntaxKind.SetAccessor) {
          result.kind = 'set';
        } else if (
          !(result as TSESTree.MethodDefinition).static &&
          node.name.kind === this.ts.SyntaxKind.StringLiteral &&
          node.name.text === 'constructor' &&
          result.type !== AST_NODE_TYPES.Property
        ) {
          result.kind = 'constructor';
        }
        return result;
      }

      // TypeScript uses this even for static methods named "constructor"
      case this.ts.SyntaxKind.Constructor: {
        const lastModifier = getLastModifier(this.ts, node);
        const constructorToken =
          (lastModifier &&
            findNextToken(this.ts, lastModifier, node, this.ast)) ??
          node.getFirstToken()!;

        const constructor = this.createNode<
          TSESTree.FunctionExpression | TSESTree.TSEmptyBodyFunctionExpression
        >(node, {
          type: !node.body
            ? AST_NODE_TYPES.TSEmptyBodyFunctionExpression
            : AST_NODE_TYPES.FunctionExpression,
          async: false,
          body: this.convertChild(node.body),
          declare: false,
          expression: false, // is not present in ESTreeNode
          generator: false,
          id: null,
          params: this.convertParameters(node.parameters),
          range: [node.parameters.pos - 1, node.end],
          returnType: node.type && this.convertTypeAnnotation(node.type, node),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });

        if (constructor.typeParameters) {
          this.fixParentLocation(constructor, constructor.typeParameters.range);
        }

        const constructorKey = this.createNode<TSESTree.Identifier>(node, {
          type: AST_NODE_TYPES.Identifier,
          decorators: [],
          name: 'constructor',
          optional: false,
          range: [constructorToken.getStart(this.ast), constructorToken.end],
          typeAnnotation: undefined,
        });

        const isStatic = hasModifier(
          this.ts,
          this.ts.SyntaxKind.StaticKeyword,
          node,
        );

        return this.createNode<
          TSESTree.MethodDefinition | TSESTree.TSAbstractMethodDefinition
        >(node, {
          type: hasModifier(this.ts, this.ts.SyntaxKind.AbstractKeyword, node)
            ? AST_NODE_TYPES.TSAbstractMethodDefinition
            : AST_NODE_TYPES.MethodDefinition,
          accessibility: getTSNodeAccessibility(this.ts, node),
          computed: false,
          decorators: [],
          optional: false,
          key: constructorKey,
          kind: isStatic ? 'method' : 'constructor',
          override: false,
          static: isStatic,
          value: constructor,
        });
      }

      case this.ts.SyntaxKind.FunctionExpression: {
        return this.createNode<TSESTree.FunctionExpression>(node, {
          type: AST_NODE_TYPES.FunctionExpression,
          async: hasModifier(this.ts, this.ts.SyntaxKind.AsyncKeyword, node),
          body: this.convertChild(node.body),
          declare: false,
          expression: false,
          generator: !!node.asteriskToken,
          id: this.convertChild(node.name),
          params: this.convertParameters(node.parameters),
          returnType: node.type && this.convertTypeAnnotation(node.type, node),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });
      }

      case this.ts.SyntaxKind.SuperKeyword:
        return this.createNode<TSESTree.Super>(node, {
          type: AST_NODE_TYPES.Super,
        });

      case this.ts.SyntaxKind.ArrayBindingPattern:
        return this.createNode<TSESTree.ArrayPattern>(node, {
          type: AST_NODE_TYPES.ArrayPattern,
          decorators: [],
          elements: node.elements.map(el => this.convertPattern(el)),
          optional: false,
          typeAnnotation: undefined,
        });

      // occurs with missing array elements like [,]
      case this.ts.SyntaxKind.OmittedExpression:
        return null;

      case this.ts.SyntaxKind.ObjectBindingPattern:
        return this.createNode<TSESTree.ObjectPattern>(node, {
          type: AST_NODE_TYPES.ObjectPattern,
          decorators: [],
          optional: false,
          properties: node.elements.map(el => this.convertPattern(el)),
          typeAnnotation: undefined,
        });

      case this.ts.SyntaxKind.BindingElement: {
        if (parent.kind === this.ts.SyntaxKind.ArrayBindingPattern) {
          const arrayItem = this.convertChild(node.name, parent);

          if (node.initializer) {
            return this.createNode<TSESTree.AssignmentPattern>(node, {
              type: AST_NODE_TYPES.AssignmentPattern,
              decorators: [],
              left: arrayItem,
              optional: false,
              right: this.convertChild(node.initializer),
              typeAnnotation: undefined,
            });
          } else if (node.dotDotDotToken) {
            return this.createNode<TSESTree.RestElement>(node, {
              type: AST_NODE_TYPES.RestElement,
              argument: arrayItem,
              decorators: [],
              optional: false,
              typeAnnotation: undefined,
              value: undefined,
            });
          }
          return arrayItem;
        }
        let result: TSESTree.Property | TSESTree.RestElement;
        if (node.dotDotDotToken) {
          result = this.createNode<TSESTree.RestElement>(node, {
            type: AST_NODE_TYPES.RestElement,
            argument: this.convertChild(node.propertyName ?? node.name),
            decorators: [],
            optional: false,
            typeAnnotation: undefined,
            value: undefined,
          });
        } else {
          result = this.createNode<TSESTree.Property>(node, {
            type: AST_NODE_TYPES.Property,
            key: this.convertChild(node.propertyName ?? node.name),
            value: this.convertChild(node.name),
            computed: Boolean(
              node.propertyName &&
                node.propertyName.kind ===
                  this.ts.SyntaxKind.ComputedPropertyName,
            ),
            method: false,
            optional: false,
            shorthand: !node.propertyName,
            kind: 'init',
          });
        }

        if (node.initializer) {
          result.value = this.createNode<TSESTree.AssignmentPattern>(node, {
            type: AST_NODE_TYPES.AssignmentPattern,
            decorators: [],
            left: this.convertChild(node.name),
            optional: false,
            range: [node.name.getStart(this.ast), node.initializer.end],
            right: this.convertChild(node.initializer),
            typeAnnotation: undefined,
          });
        }
        return result;
      }

      case this.ts.SyntaxKind.ArrowFunction: {
        return this.createNode<TSESTree.ArrowFunctionExpression>(node, {
          type: AST_NODE_TYPES.ArrowFunctionExpression,
          generator: false,
          id: null,
          params: this.convertParameters(node.parameters),
          body: this.convertChild(node.body),
          async: hasModifier(this.ts, this.ts.SyntaxKind.AsyncKeyword, node),
          expression: node.body.kind !== this.ts.SyntaxKind.Block,
          returnType: node.type && this.convertTypeAnnotation(node.type, node),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });
      }

      case this.ts.SyntaxKind.YieldExpression:
        return this.createNode<TSESTree.YieldExpression>(node, {
          type: AST_NODE_TYPES.YieldExpression,
          delegate: !!node.asteriskToken,
          argument: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.AwaitExpression:
        return this.createNode<TSESTree.AwaitExpression>(node, {
          type: AST_NODE_TYPES.AwaitExpression,
          argument: this.convertChild(node.expression),
        });

      // Template Literals

      case this.ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return this.createNode<TSESTree.TemplateLiteral>(node, {
          type: AST_NODE_TYPES.TemplateLiteral,
          quasis: [
            this.createNode<TSESTree.TemplateElement>(node, {
              type: AST_NODE_TYPES.TemplateElement,
              value: {
                raw: this.ast.text.slice(
                  node.getStart(this.ast) + 1,
                  node.end - 1,
                ),
                cooked: node.text,
              },
              tail: true,
            }),
          ],
          expressions: [],
        });

      case this.ts.SyntaxKind.TemplateExpression: {
        const result = this.createNode<TSESTree.TemplateLiteral>(node, {
          type: AST_NODE_TYPES.TemplateLiteral,
          quasis: [this.convertChild(node.head)],
          expressions: [],
        });

        node.templateSpans.forEach(templateSpan => {
          result.expressions.push(
            this.convertChild(templateSpan.expression) as TSESTree.Expression,
          );
          result.quasis.push(
            this.convertChild(templateSpan.literal) as TSESTree.TemplateElement,
          );
        });
        return result;
      }

      case this.ts.SyntaxKind.TaggedTemplateExpression:
        return this.createNode<TSESTree.TaggedTemplateExpression>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.TaggedTemplateExpression,
              typeArguments:
                node.typeArguments &&
                this.convertTypeArgumentsToTypeParameterInstantiation(
                  node.typeArguments,
                  node,
                ),
              tag: this.convertChild(node.tag),
              quasi: this.convertChild(node.template),
            },
            'typeParameters',
            'typeArguments',
          ),
        );

      case this.ts.SyntaxKind.TemplateHead:
      case this.ts.SyntaxKind.TemplateMiddle:
      case this.ts.SyntaxKind.TemplateTail: {
        const tail = node.kind === this.ts.SyntaxKind.TemplateTail;
        return this.createNode<TSESTree.TemplateElement>(node, {
          type: AST_NODE_TYPES.TemplateElement,
          value: {
            raw: this.ast.text.slice(
              node.getStart(this.ast) + 1,
              node.end - (tail ? 1 : 2),
            ),
            cooked: node.text,
          },
          tail,
        });
      }

      // Patterns

      case this.ts.SyntaxKind.SpreadAssignment:
      case this.ts.SyntaxKind.SpreadElement: {
        if (this.allowPattern) {
          return this.createNode<TSESTree.RestElement>(node, {
            type: AST_NODE_TYPES.RestElement,
            argument: this.convertPattern(node.expression),
            decorators: [],
            optional: false,
            typeAnnotation: undefined,
            value: undefined,
          });
        }
        return this.createNode<TSESTree.SpreadElement>(node, {
          type: AST_NODE_TYPES.SpreadElement,
          argument: this.convertChild(node.expression),
        });
      }

      case this.ts.SyntaxKind.Parameter: {
        let parameter: TSESTree.BindingName | TSESTree.RestElement;
        let result: TSESTree.AssignmentPattern | TSESTree.RestElement;

        if (node.dotDotDotToken) {
          parameter = result = this.createNode<TSESTree.RestElement>(node, {
            type: AST_NODE_TYPES.RestElement,
            argument: this.convertChild(node.name),
            decorators: [],
            optional: false,
            typeAnnotation: undefined,
            value: undefined,
          });
        } else if (node.initializer) {
          parameter = this.convertChild(node.name) as TSESTree.BindingName;
          result = this.createNode<TSESTree.AssignmentPattern>(node, {
            type: AST_NODE_TYPES.AssignmentPattern,
            decorators: [],
            left: parameter,
            optional: false,
            right: this.convertChild(node.initializer),
            typeAnnotation: undefined,
          });

          const modifiers = getModifiers(this.ts, node);
          if (modifiers) {
            // AssignmentPattern should not contain modifiers in range
            result.range[0] = parameter.range[0];
            result.loc = getLocFor(result.range, this.ast);
          }
        } else {
          parameter = result = this.convertChild(node.name, parent);
        }

        if (node.type) {
          parameter.typeAnnotation = this.convertTypeAnnotation(
            node.type,
            node,
          );
          this.fixParentLocation(parameter, parameter.typeAnnotation.range);
        }

        if (node.questionToken) {
          if (node.questionToken.end > parameter.range[1]) {
            parameter.range[1] = node.questionToken.end;
            parameter.loc.end = getLineAndCharacterFor(
              parameter.range[1],
              this.ast,
            );
          }
          parameter.optional = true;
        }

        const modifiers = getModifiers(this.ts, node);
        if (modifiers) {
          return this.createNode<TSESTree.TSParameterProperty>(node, {
            type: AST_NODE_TYPES.TSParameterProperty,
            accessibility: getTSNodeAccessibility(this.ts, node),
            decorators: [],
            override: hasModifier(
              this.ts,
              this.ts.SyntaxKind.OverrideKeyword,
              node,
            ),
            parameter: result,
            readonly: hasModifier(
              this.ts,
              this.ts.SyntaxKind.ReadonlyKeyword,
              node,
            ),
            static: hasModifier(
              this.ts,
              this.ts.SyntaxKind.StaticKeyword,
              node,
            ),
          });
        }
        return result;
      }

      // Classes

      case this.ts.SyntaxKind.ClassDeclaration:
        if (
          !node.name &&
          (!hasModifier(this.ts, this.ts.SyntaxKind.ExportKeyword, node) ||
            !hasModifier(this.ts, this.ts.SyntaxKind.DefaultKeyword, node))
        ) {
          this.#throwUnlessAllowInvalidAST(
            node,
            "A class declaration without the 'default' modifier must have a name.",
          );
        }
      /* intentional fallthrough */
      case this.ts.SyntaxKind.ClassExpression: {
        const heritageClauses = node.heritageClauses ?? [];
        const classNodeType =
          node.kind === this.ts.SyntaxKind.ClassDeclaration
            ? AST_NODE_TYPES.ClassDeclaration
            : AST_NODE_TYPES.ClassExpression;

        let extendsClause: ts.HeritageClause | undefined;
        let implementsClause: ts.HeritageClause | undefined;
        for (const heritageClause of heritageClauses) {
          const { token, types } = heritageClause;

          if (types.length === 0) {
            this.#throwUnlessAllowInvalidAST(
              heritageClause,
              `'${this.ts.tokenToString(token)}' list cannot be empty.`,
            );
          }

          if (token === this.ts.SyntaxKind.ExtendsKeyword) {
            if (extendsClause) {
              this.#throwUnlessAllowInvalidAST(
                heritageClause,
                "'extends' clause already seen.",
              );
            }

            if (implementsClause) {
              this.#throwUnlessAllowInvalidAST(
                heritageClause,
                "'extends' clause must precede 'implements' clause.",
              );
            }

            if (types.length > 1) {
              this.#throwUnlessAllowInvalidAST(
                types[1],
                'Classes can only extend a single class.',
              );
            }

            extendsClause ??= heritageClause;
          } else if (token === this.ts.SyntaxKind.ImplementsKeyword) {
            if (implementsClause) {
              this.#throwUnlessAllowInvalidAST(
                heritageClause,
                "'implements' clause already seen.",
              );
            }

            implementsClause ??= heritageClause;
          }
        }

        const result = this.createNode<
          TSESTree.ClassDeclaration | TSESTree.ClassExpression
        >(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: classNodeType,
              abstract: hasModifier(
                this.ts,
                this.ts.SyntaxKind.AbstractKeyword,
                node,
              ),
              body: this.createNode<TSESTree.ClassBody>(node, {
                type: AST_NODE_TYPES.ClassBody,
                body: node.members
                  .filter(isESTreeClassMember)
                  .map(el => this.convertChild(el)),
                range: [node.members.pos - 1, node.end],
              }),
              declare: hasModifier(
                this.ts,
                this.ts.SyntaxKind.DeclareKeyword,
                node,
              ),
              decorators:
                getDecorators(this.ts, node)?.map(el =>
                  this.convertChild(el),
                ) ?? [],
              id: this.convertChild(node.name),
              implements:
                implementsClause?.types.map(el => this.convertChild(el)) ?? [],
              superClass: extendsClause?.types[0]
                ? this.convertChild(extendsClause.types[0].expression)
                : null,
              superTypeArguments: undefined,
              typeParameters:
                node.typeParameters &&
                this.convertTSTypeParametersToTypeParametersDeclaration(
                  node.typeParameters,
                ),
            },
            'superTypeParameters',
            'superTypeArguments',
          ),
        );

        if (extendsClause?.types[0]?.typeArguments) {
          result.superTypeArguments =
            this.convertTypeArgumentsToTypeParameterInstantiation(
              extendsClause.types[0].typeArguments,
              extendsClause.types[0],
            );
        }

        return this.fixExports(node, result);
      }

      // Modules
      case this.ts.SyntaxKind.ModuleBlock:
        return this.createNode<TSESTree.TSModuleBlock>(node, {
          type: AST_NODE_TYPES.TSModuleBlock,
          body: this.convertBodyExpressions(node.statements, node),
        });

      case this.ts.SyntaxKind.ImportDeclaration: {
        this.assertModuleSpecifier(node, false);

        const result = this.createNode<TSESTree.ImportDeclaration>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.ImportDeclaration,
              source: this.convertChild(node.moduleSpecifier),
              specifiers: [],
              importKind: 'value',
              attributes: this.convertImportAttributes(
                // eslint-disable-next-line deprecation/deprecation -- TS <5.3
                node.attributes ?? node.assertClause,
              ),
            },
            'assertions',
            'attributes',
            true,
          ),
        );

        if (node.importClause) {
          if (node.importClause.isTypeOnly) {
            result.importKind = 'type';
          }

          if (node.importClause.name) {
            result.specifiers.push(
              this.convertChild(node.importClause) as TSESTree.ImportClause,
            );
          }

          if (node.importClause.namedBindings) {
            switch (node.importClause.namedBindings.kind) {
              case this.ts.SyntaxKind.NamespaceImport:
                result.specifiers.push(
                  this.convertChild(
                    node.importClause.namedBindings,
                  ) as TSESTree.ImportClause,
                );
                break;
              case this.ts.SyntaxKind.NamedImports:
                result.specifiers = result.specifiers.concat(
                  node.importClause.namedBindings.elements.map(el =>
                    this.convertChild(el),
                  ),
                );
                break;
            }
          }
        }
        return result;
      }

      case this.ts.SyntaxKind.NamespaceImport:
        return this.createNode<TSESTree.ImportNamespaceSpecifier>(node, {
          type: AST_NODE_TYPES.ImportNamespaceSpecifier,
          local: this.convertChild(node.name),
        });

      case this.ts.SyntaxKind.ImportSpecifier:
        return this.createNode<TSESTree.ImportSpecifier>(node, {
          type: AST_NODE_TYPES.ImportSpecifier,
          local: this.convertChild(node.name),
          imported: this.convertChild(node.propertyName ?? node.name),
          importKind: node.isTypeOnly ? 'type' : 'value',
        });

      case this.ts.SyntaxKind.ImportClause: {
        const local = this.convertChild(node.name);
        return this.createNode<TSESTree.ImportDefaultSpecifier>(node, {
          type: AST_NODE_TYPES.ImportDefaultSpecifier,
          local,
          range: local.range,
        });
      }

      case this.ts.SyntaxKind.ExportDeclaration: {
        if (node.exportClause?.kind === this.ts.SyntaxKind.NamedExports) {
          this.assertModuleSpecifier(node, true);
          return this.createNode<TSESTree.ExportNamedDeclaration>(
            node,
            this.#withDeprecatedAliasGetter(
              {
                type: AST_NODE_TYPES.ExportNamedDeclaration,
                source: this.convertChild(node.moduleSpecifier),
                specifiers: node.exportClause.elements.map(el =>
                  this.convertChild(el),
                ),
                exportKind: node.isTypeOnly ? 'type' : 'value',
                declaration: null,
                attributes: this.convertImportAttributes(
                  // eslint-disable-next-line deprecation/deprecation -- TS <5.3
                  node.attributes ?? node.assertClause,
                ),
              },
              'assertions',
              'attributes',
              true,
            ),
          );
        }
        this.assertModuleSpecifier(node, false);
        return this.createNode<TSESTree.ExportAllDeclaration>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.ExportAllDeclaration,
              source: this.convertChild(node.moduleSpecifier),
              exportKind: node.isTypeOnly ? 'type' : 'value',
              exported:
                node.exportClause?.kind === this.ts.SyntaxKind.NamespaceExport
                  ? this.convertChild(node.exportClause.name)
                  : null,
              attributes: this.convertImportAttributes(
                // eslint-disable-next-line deprecation/deprecation -- TS <5.3
                node.attributes ?? node.assertClause,
              ),
            },
            'assertions',
            'attributes',
            true,
          ),
        );
      }

      case this.ts.SyntaxKind.ExportSpecifier:
        return this.createNode<TSESTree.ExportSpecifier>(node, {
          type: AST_NODE_TYPES.ExportSpecifier,
          local: this.convertChild(node.propertyName ?? node.name),
          exported: this.convertChild(node.name),
          exportKind: node.isTypeOnly ? 'type' : 'value',
        });

      case this.ts.SyntaxKind.ExportAssignment:
        if (node.isExportEquals) {
          return this.createNode<TSESTree.TSExportAssignment>(node, {
            type: AST_NODE_TYPES.TSExportAssignment,
            expression: this.convertChild(node.expression),
          });
        }
        return this.createNode<TSESTree.ExportDefaultDeclaration>(node, {
          type: AST_NODE_TYPES.ExportDefaultDeclaration,
          declaration: this.convertChild(node.expression),
          exportKind: 'value',
        });

      // Unary Operations

      case this.ts.SyntaxKind.PrefixUnaryExpression:
      case this.ts.SyntaxKind.PostfixUnaryExpression: {
        const operator = getTextForTokenKind(this.ts, node.operator);
        /**
         * ESTree uses UpdateExpression for ++/--
         */
        if (operator === '++' || operator === '--') {
          if (!isValidAssignmentTarget(node.operand)) {
            this.#throwUnlessAllowInvalidAST(
              node.operand,
              'Invalid left-hand side expression in unary operation',
            );
          }
          return this.createNode<TSESTree.UpdateExpression>(node, {
            type: AST_NODE_TYPES.UpdateExpression,
            operator,
            prefix: node.kind === this.ts.SyntaxKind.PrefixUnaryExpression,
            argument: this.convertChild(node.operand),
          });
        }
        return this.createNode<TSESTree.UnaryExpression>(node, {
          type: AST_NODE_TYPES.UnaryExpression,
          operator,
          prefix: node.kind === this.ts.SyntaxKind.PrefixUnaryExpression,
          argument: this.convertChild(node.operand),
        });
      }

      case this.ts.SyntaxKind.DeleteExpression:
        return this.createNode<TSESTree.UnaryExpression>(node, {
          type: AST_NODE_TYPES.UnaryExpression,
          operator: 'delete',
          prefix: true,
          argument: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.VoidExpression:
        return this.createNode<TSESTree.UnaryExpression>(node, {
          type: AST_NODE_TYPES.UnaryExpression,
          operator: 'void',
          prefix: true,
          argument: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.TypeOfExpression:
        return this.createNode<TSESTree.UnaryExpression>(node, {
          type: AST_NODE_TYPES.UnaryExpression,
          operator: 'typeof',
          prefix: true,
          argument: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.TypeOperator:
        return this.createNode<TSESTree.TSTypeOperator>(node, {
          type: AST_NODE_TYPES.TSTypeOperator,
          operator: getTextForTokenKind(this.ts, node.operator),
          typeAnnotation: this.convertChild(node.type),
        });

      // Binary Operations

      case this.ts.SyntaxKind.BinaryExpression: {
        // TypeScript uses BinaryExpression for sequences as well
        if (isComma(node.operatorToken)) {
          const result = this.createNode<TSESTree.SequenceExpression>(node, {
            type: AST_NODE_TYPES.SequenceExpression,
            expressions: [],
          });

          const left = this.convertChild(node.left) as TSESTree.Expression;
          if (
            left.type === AST_NODE_TYPES.SequenceExpression &&
            node.left.kind !== this.ts.SyntaxKind.ParenthesizedExpression
          ) {
            result.expressions = result.expressions.concat(left.expressions);
          } else {
            result.expressions.push(left);
          }

          result.expressions.push(
            this.convertChild(node.right) as TSESTree.Expression,
          );
          return result;
        }
        const expressionType = getBinaryExpressionType(
          this.ts,
          node.operatorToken,
        );
        if (
          this.allowPattern &&
          expressionType.type === AST_NODE_TYPES.AssignmentExpression
        ) {
          return this.createNode<TSESTree.AssignmentPattern>(node, {
            type: AST_NODE_TYPES.AssignmentPattern,
            decorators: [],
            left: this.convertPattern(node.left, node),
            optional: false,
            right: this.convertChild(node.right),
            typeAnnotation: undefined,
          });
        }
        return this.createNode<
          | TSESTree.AssignmentExpression
          | TSESTree.BinaryExpression
          | TSESTree.LogicalExpression
        >(node, {
          ...expressionType,
          left: this.converter(
            node.left,
            node,
            expressionType.type === AST_NODE_TYPES.AssignmentExpression,
          ),
          right: this.convertChild(node.right),
        });
      }

      case this.ts.SyntaxKind.PropertyAccessExpression: {
        const object = this.convertChild(node.expression);
        const property = this.convertChild(node.name);
        const computed = false;

        const result = this.createNode<TSESTree.MemberExpression>(node, {
          type: AST_NODE_TYPES.MemberExpression,
          object,
          property,
          computed,
          optional: node.questionDotToken !== undefined,
        });

        return this.convertChainExpression(result, node);
      }

      case this.ts.SyntaxKind.ElementAccessExpression: {
        const object = this.convertChild(node.expression);
        const property = this.convertChild(node.argumentExpression);
        const computed = true;

        const result = this.createNode<TSESTree.MemberExpression>(node, {
          type: AST_NODE_TYPES.MemberExpression,
          object,
          property,
          computed,
          optional: node.questionDotToken !== undefined,
        });

        return this.convertChainExpression(result, node);
      }

      case this.ts.SyntaxKind.CallExpression: {
        if (node.expression.kind === this.ts.SyntaxKind.ImportKeyword) {
          if (node.arguments.length !== 1 && node.arguments.length !== 2) {
            this.#throwUnlessAllowInvalidAST(
              node.arguments[2] ?? node,
              'Dynamic import requires exactly one or two arguments.',
            );
          }
          return this.createNode<TSESTree.ImportExpression>(node, {
            type: AST_NODE_TYPES.ImportExpression,
            source: this.convertChild(node.arguments[0]),
            attributes: node.arguments[1]
              ? this.convertChild(node.arguments[1])
              : null,
          });
        }

        const callee = this.convertChild(node.expression);
        const args = node.arguments.map(el => this.convertChild(el));
        const typeArguments =
          node.typeArguments &&
          this.convertTypeArgumentsToTypeParameterInstantiation(
            node.typeArguments,
            node,
          );

        const result = this.createNode<TSESTree.CallExpression>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.CallExpression,
              callee,
              arguments: args,
              optional: node.questionDotToken !== undefined,
              typeArguments,
            },
            'typeParameters',
            'typeArguments',
          ),
        );

        return this.convertChainExpression(result, node);
      }

      case this.ts.SyntaxKind.NewExpression: {
        const typeArguments =
          node.typeArguments &&
          this.convertTypeArgumentsToTypeParameterInstantiation(
            node.typeArguments,
            node,
          );

        // NOTE - NewExpression cannot have an optional chain in it
        return this.createNode<TSESTree.NewExpression>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.NewExpression,
              arguments: node.arguments
                ? node.arguments.map(el => this.convertChild(el))
                : [],
              callee: this.convertChild(node.expression),
              typeArguments,
            },
            'typeParameters',
            'typeArguments',
          ),
        );
      }

      case this.ts.SyntaxKind.ConditionalExpression:
        return this.createNode<TSESTree.ConditionalExpression>(node, {
          type: AST_NODE_TYPES.ConditionalExpression,
          test: this.convertChild(node.condition),
          consequent: this.convertChild(node.whenTrue),
          alternate: this.convertChild(node.whenFalse),
        });

      case this.ts.SyntaxKind.MetaProperty: {
        return this.createNode<TSESTree.MetaProperty>(node, {
          type: AST_NODE_TYPES.MetaProperty,
          meta: this.createNode<TSESTree.Identifier>(
            // TODO: do we really want to convert it to Token?
            node.getFirstToken()! as ts.Token<typeof node.keywordToken>,
            {
              type: AST_NODE_TYPES.Identifier,
              decorators: [],
              name: getTextForTokenKind(this.ts, node.keywordToken),
              optional: false,
              typeAnnotation: undefined,
            },
          ),
          property: this.convertChild(node.name),
        });
      }

      case this.ts.SyntaxKind.Decorator: {
        return this.createNode<TSESTree.Decorator>(node, {
          type: AST_NODE_TYPES.Decorator,
          expression: this.convertChild(node.expression),
        });
      }

      // Literals

      case this.ts.SyntaxKind.StringLiteral: {
        return this.createNode<TSESTree.StringLiteral>(node, {
          type: AST_NODE_TYPES.Literal,
          value:
            parent.kind === this.ts.SyntaxKind.JsxAttribute
              ? unescapeStringLiteralText(node.text)
              : node.text,
          raw: node.getText(),
        });
      }

      case this.ts.SyntaxKind.NumericLiteral: {
        return this.createNode<TSESTree.NumberLiteral>(node, {
          type: AST_NODE_TYPES.Literal,
          value: Number(node.text),
          raw: node.getText(),
        });
      }

      case this.ts.SyntaxKind.BigIntLiteral: {
        const range = getRange(node, this.ast);
        const rawValue = this.ast.text.slice(range[0], range[1]);
        const bigint = rawValue
          // remove suffix `n`
          .slice(0, -1)
          // `BigInt` doesn't accept numeric separator
          // and `bigint` property should not include numeric separator
          .replace(/_/g, '');
        const value = typeof BigInt !== 'undefined' ? BigInt(bigint) : null;
        return this.createNode<TSESTree.BigIntLiteral>(node, {
          type: AST_NODE_TYPES.Literal,
          raw: rawValue,
          value: value,
          bigint: value == null ? bigint : String(value),
          range,
        });
      }

      case this.ts.SyntaxKind.RegularExpressionLiteral: {
        const pattern = node.text.slice(1, node.text.lastIndexOf('/'));
        const flags = node.text.slice(node.text.lastIndexOf('/') + 1);

        let regex = null;
        try {
          regex = new RegExp(pattern, flags);
        } catch {
          // Intentionally blank, so regex stays null
        }

        return this.createNode<TSESTree.RegExpLiteral>(node, {
          type: AST_NODE_TYPES.Literal,
          value: regex,
          raw: node.text,
          regex: {
            pattern,
            flags,
          },
        });
      }

      case this.ts.SyntaxKind.TrueKeyword:
        return this.createNode<TSESTree.BooleanLiteral>(node, {
          type: AST_NODE_TYPES.Literal,
          value: true,
          raw: 'true',
        });

      case this.ts.SyntaxKind.FalseKeyword:
        return this.createNode<TSESTree.BooleanLiteral>(node, {
          type: AST_NODE_TYPES.Literal,
          value: false,
          raw: 'false',
        });

      case this.ts.SyntaxKind.NullKeyword: {
        return this.createNode<TSESTree.NullLiteral>(node, {
          type: AST_NODE_TYPES.Literal,
          value: null,
          raw: 'null',
        });
      }

      case this.ts.SyntaxKind.EmptyStatement:
        return this.createNode<TSESTree.EmptyStatement>(node, {
          type: AST_NODE_TYPES.EmptyStatement,
        });

      case this.ts.SyntaxKind.DebuggerStatement:
        return this.createNode<TSESTree.DebuggerStatement>(node, {
          type: AST_NODE_TYPES.DebuggerStatement,
        });

      // JSX

      case this.ts.SyntaxKind.JsxElement:
        return this.createNode<TSESTree.JSXElement>(node, {
          type: AST_NODE_TYPES.JSXElement,
          openingElement: this.convertChild(node.openingElement),
          closingElement: this.convertChild(node.closingElement),
          children: node.children.map(el => this.convertChild(el)),
        });

      case this.ts.SyntaxKind.JsxFragment:
        return this.createNode<TSESTree.JSXFragment>(node, {
          type: AST_NODE_TYPES.JSXFragment,
          openingFragment: this.convertChild(node.openingFragment),
          closingFragment: this.convertChild(node.closingFragment),
          children: node.children.map(el => this.convertChild(el)),
        });

      case this.ts.SyntaxKind.JsxSelfClosingElement: {
        return this.createNode<TSESTree.JSXElement>(node, {
          type: AST_NODE_TYPES.JSXElement,
          /**
           * Convert this.ts.SyntaxKind.JsxSelfClosingElement to this.ts.SyntaxKind.JsxOpeningElement,
           * TypeScript does not seem to have the idea of openingElement when tag is self-closing
           */
          openingElement: this.createNode<TSESTree.JSXOpeningElement>(
            node,
            this.#withDeprecatedAliasGetter(
              {
                type: AST_NODE_TYPES.JSXOpeningElement,
                typeArguments: node.typeArguments
                  ? this.convertTypeArgumentsToTypeParameterInstantiation(
                      node.typeArguments,
                      node,
                    )
                  : undefined,
                selfClosing: true,
                name: this.convertJSXTagName(node.tagName, node),
                attributes: node.attributes.properties.map(el =>
                  this.convertChild(el),
                ),
                range: getRange(node, this.ast),
              },
              'typeParameters',
              'typeArguments',
            ),
          ),
          closingElement: null,
          children: [],
        });
      }

      case this.ts.SyntaxKind.JsxOpeningElement: {
        return this.createNode<TSESTree.JSXOpeningElement>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.JSXOpeningElement,
              typeArguments:
                node.typeArguments &&
                this.convertTypeArgumentsToTypeParameterInstantiation(
                  node.typeArguments,
                  node,
                ),
              selfClosing: false,
              name: this.convertJSXTagName(node.tagName, node),
              attributes: node.attributes.properties.map(el =>
                this.convertChild(el),
              ),
            },
            'typeParameters',
            'typeArguments',
          ),
        );
      }

      case this.ts.SyntaxKind.JsxClosingElement:
        return this.createNode<TSESTree.JSXClosingElement>(node, {
          type: AST_NODE_TYPES.JSXClosingElement,
          name: this.convertJSXTagName(node.tagName, node),
        });

      case this.ts.SyntaxKind.JsxOpeningFragment:
        return this.createNode<TSESTree.JSXOpeningFragment>(node, {
          type: AST_NODE_TYPES.JSXOpeningFragment,
        });

      case this.ts.SyntaxKind.JsxClosingFragment:
        return this.createNode<TSESTree.JSXClosingFragment>(node, {
          type: AST_NODE_TYPES.JSXClosingFragment,
        });

      case this.ts.SyntaxKind.JsxExpression: {
        const expression = node.expression
          ? this.convertChild(node.expression)
          : this.createNode<TSESTree.JSXEmptyExpression>(node, {
              type: AST_NODE_TYPES.JSXEmptyExpression,
              range: [node.getStart(this.ast) + 1, node.getEnd() - 1],
            });

        if (node.dotDotDotToken) {
          return this.createNode<TSESTree.JSXSpreadChild>(node, {
            type: AST_NODE_TYPES.JSXSpreadChild,
            expression,
          });
        }
        return this.createNode<TSESTree.JSXExpressionContainer>(node, {
          type: AST_NODE_TYPES.JSXExpressionContainer,
          expression,
        });
      }

      case this.ts.SyntaxKind.JsxAttribute: {
        return this.createNode<TSESTree.JSXAttribute>(node, {
          type: AST_NODE_TYPES.JSXAttribute,
          name: this.convertJSXNamespaceOrIdentifier(node.name),
          value: this.convertChild(node.initializer),
        });
      }

      case this.ts.SyntaxKind.JsxText: {
        const start = node.getFullStart();
        const end = node.getEnd();
        const text = this.ast.text.slice(start, end);

        return this.createNode<TSESTree.JSXText>(node, {
          type: AST_NODE_TYPES.JSXText,
          value: unescapeStringLiteralText(text),
          raw: text,
          range: [start, end],
        });
      }

      case this.ts.SyntaxKind.JsxSpreadAttribute:
        return this.createNode<TSESTree.JSXSpreadAttribute>(node, {
          type: AST_NODE_TYPES.JSXSpreadAttribute,
          argument: this.convertChild(node.expression),
        });

      case this.ts.SyntaxKind.QualifiedName: {
        return this.createNode<TSESTree.TSQualifiedName>(node, {
          type: AST_NODE_TYPES.TSQualifiedName,
          left: this.convertChild(node.left),
          right: this.convertChild(node.right),
        });
      }

      // TypeScript specific

      case this.ts.SyntaxKind.TypeReference:
        return this.createNode<TSESTree.TSTypeReference>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.TSTypeReference,
              typeName: this.convertChild(node.typeName),
              typeArguments:
                node.typeArguments &&
                this.convertTypeArgumentsToTypeParameterInstantiation(
                  node.typeArguments,
                  node,
                ),
            },
            'typeParameters',
            'typeArguments',
          ),
        );

      case this.ts.SyntaxKind.TypeParameter: {
        return this.createNode<TSESTree.TSTypeParameter>(node, {
          type: AST_NODE_TYPES.TSTypeParameter,
          name: this.convertChild(node.name),
          constraint: node.constraint && this.convertChild(node.constraint),
          default: node.default ? this.convertChild(node.default) : undefined,
          in: hasModifier(this.ts, this.ts.SyntaxKind.InKeyword, node),
          out: hasModifier(this.ts, this.ts.SyntaxKind.OutKeyword, node),
          const: hasModifier(this.ts, this.ts.SyntaxKind.ConstKeyword, node),
        });
      }

      case this.ts.SyntaxKind.ThisType:
        return this.createNode<TSESTree.TSThisType>(node, {
          type: AST_NODE_TYPES.TSThisType,
        });

      case this.ts.SyntaxKind.AnyKeyword:
      case this.ts.SyntaxKind.BigIntKeyword:
      case this.ts.SyntaxKind.BooleanKeyword:
      case this.ts.SyntaxKind.NeverKeyword:
      case this.ts.SyntaxKind.NumberKeyword:
      case this.ts.SyntaxKind.ObjectKeyword:
      case this.ts.SyntaxKind.StringKeyword:
      case this.ts.SyntaxKind.SymbolKeyword:
      case this.ts.SyntaxKind.UnknownKeyword:
      case this.ts.SyntaxKind.VoidKeyword:
      case this.ts.SyntaxKind.UndefinedKeyword:
      case this.ts.SyntaxKind.IntrinsicKeyword: {
        return this.createNode<any>(node, {
          type: AST_NODE_TYPES[
            `TS${this.ts.SyntaxKind[node.kind]}` as AST_NODE_TYPES
          ],
        });
      }

      case this.ts.SyntaxKind.NonNullExpression: {
        const nnExpr = this.createNode<TSESTree.TSNonNullExpression>(node, {
          type: AST_NODE_TYPES.TSNonNullExpression,
          expression: this.convertChild(node.expression),
        });

        return this.convertChainExpression(nnExpr, node);
      }

      case this.ts.SyntaxKind.TypeLiteral: {
        return this.createNode<TSESTree.TSTypeLiteral>(node, {
          type: AST_NODE_TYPES.TSTypeLiteral,
          members: node.members.map(el => this.convertChild(el)),
        });
      }

      case this.ts.SyntaxKind.ArrayType: {
        return this.createNode<TSESTree.TSArrayType>(node, {
          type: AST_NODE_TYPES.TSArrayType,
          elementType: this.convertChild(node.elementType),
        });
      }

      case this.ts.SyntaxKind.IndexedAccessType: {
        return this.createNode<TSESTree.TSIndexedAccessType>(node, {
          type: AST_NODE_TYPES.TSIndexedAccessType,
          objectType: this.convertChild(node.objectType),
          indexType: this.convertChild(node.indexType),
        });
      }

      case this.ts.SyntaxKind.ConditionalType: {
        return this.createNode<TSESTree.TSConditionalType>(node, {
          type: AST_NODE_TYPES.TSConditionalType,
          checkType: this.convertChild(node.checkType),
          extendsType: this.convertChild(node.extendsType),
          trueType: this.convertChild(node.trueType),
          falseType: this.convertChild(node.falseType),
        });
      }

      case this.ts.SyntaxKind.TypeQuery:
        return this.createNode<TSESTree.TSTypeQuery>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.TSTypeQuery,
              exprName: this.convertChild(node.exprName),
              typeArguments:
                node.typeArguments &&
                this.convertTypeArgumentsToTypeParameterInstantiation(
                  node.typeArguments,
                  node,
                ),
            },
            'typeParameters',
            'typeArguments',
          ),
        );

      case this.ts.SyntaxKind.MappedType: {
        if (node.members && node.members.length > 0) {
          this.#throwUnlessAllowInvalidAST(
            node.members[0],
            'A mapped type may not declare properties or methods.',
          );
        }

        return this.createNode<TSESTree.TSMappedType>(node, {
          type: AST_NODE_TYPES.TSMappedType,
          nameType: this.convertChild(node.nameType) ?? null,
          optional:
            node.questionToken &&
            (node.questionToken.kind === this.ts.SyntaxKind.QuestionToken ||
              getTextForTokenKind(this.ts, node.questionToken.kind)),
          readonly:
            node.readonlyToken &&
            (node.readonlyToken.kind === this.ts.SyntaxKind.ReadonlyKeyword ||
              getTextForTokenKind(this.ts, node.readonlyToken.kind)),
          typeAnnotation: node.type && this.convertChild(node.type),
          typeParameter: this.convertChild(node.typeParameter),
        });
      }

      case this.ts.SyntaxKind.ParenthesizedExpression:
        return this.convertChild(node.expression, parent);

      case this.ts.SyntaxKind.TypeAliasDeclaration: {
        const result = this.createNode<TSESTree.TSTypeAliasDeclaration>(node, {
          type: AST_NODE_TYPES.TSTypeAliasDeclaration,
          declare: hasModifier(
            this.ts,
            this.ts.SyntaxKind.DeclareKeyword,
            node,
          ),
          id: this.convertChild(node.name),
          typeAnnotation: this.convertChild(node.type),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });

        return this.fixExports(node, result);
      }

      case this.ts.SyntaxKind.MethodSignature: {
        return this.convertMethodSignature(node);
      }

      case this.ts.SyntaxKind.PropertySignature: {
        // eslint-disable-next-line deprecation/deprecation
        const { initializer } = node;
        if (initializer) {
          this.#throwError(
            initializer,
            'A property signature cannot have an initializer.',
          );
        }

        return this.createNode<TSESTree.TSPropertySignature>(node, {
          type: AST_NODE_TYPES.TSPropertySignature,
          accessibility: getTSNodeAccessibility(this.ts, node),
          computed: isComputedProperty(node.name),
          key: this.convertChild(node.name),
          optional: isOptional(node),
          readonly: hasModifier(
            this.ts,
            this.ts.SyntaxKind.ReadonlyKeyword,
            node,
          ),
          static: hasModifier(this.ts, this.ts.SyntaxKind.StaticKeyword, node),
          typeAnnotation:
            node.type && this.convertTypeAnnotation(node.type, node),
        });
      }

      case this.ts.SyntaxKind.IndexSignature: {
        return this.createNode<TSESTree.TSIndexSignature>(node, {
          type: AST_NODE_TYPES.TSIndexSignature,
          accessibility: getTSNodeAccessibility(this.ts, node),
          parameters: node.parameters.map(el => this.convertChild(el)),
          readonly: hasModifier(
            this.ts,
            this.ts.SyntaxKind.ReadonlyKeyword,
            node,
          ),
          static: hasModifier(this.ts, this.ts.SyntaxKind.StaticKeyword, node),
          typeAnnotation:
            node.type && this.convertTypeAnnotation(node.type, node),
        });
      }

      case this.ts.SyntaxKind.ConstructorType: {
        return this.createNode<TSESTree.TSConstructorType>(node, {
          type: AST_NODE_TYPES.TSConstructorType,
          abstract: hasModifier(
            this.ts,
            this.ts.SyntaxKind.AbstractKeyword,
            node,
          ),
          params: this.convertParameters(node.parameters),
          returnType: node.type && this.convertTypeAnnotation(node.type, node),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });
      }

      case this.ts.SyntaxKind.FunctionType: {
        // eslint-disable-next-line deprecation/deprecation
        const { modifiers } = node;
        if (modifiers) {
          this.#throwError(
            modifiers[0],
            'A function type cannot have modifiers.',
          );
        }
      }
      // intentional fallthrough
      case this.ts.SyntaxKind.ConstructSignature:
      case this.ts.SyntaxKind.CallSignature: {
        const type =
          node.kind === this.ts.SyntaxKind.ConstructSignature
            ? AST_NODE_TYPES.TSConstructSignatureDeclaration
            : node.kind === this.ts.SyntaxKind.CallSignature
              ? AST_NODE_TYPES.TSCallSignatureDeclaration
              : AST_NODE_TYPES.TSFunctionType;

        return this.createNode<
          | TSESTree.TSCallSignatureDeclaration
          | TSESTree.TSConstructSignatureDeclaration
          | TSESTree.TSFunctionType
        >(node, {
          type,
          params: this.convertParameters(node.parameters),
          returnType: node.type && this.convertTypeAnnotation(node.type, node),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });
      }

      case this.ts.SyntaxKind.ExpressionWithTypeArguments: {
        const parentKind = parent.kind;
        const type =
          parentKind === this.ts.SyntaxKind.InterfaceDeclaration
            ? AST_NODE_TYPES.TSInterfaceHeritage
            : parentKind === this.ts.SyntaxKind.HeritageClause
              ? AST_NODE_TYPES.TSClassImplements
              : AST_NODE_TYPES.TSInstantiationExpression;

        return this.createNode<
          | TSESTree.TSClassImplements
          | TSESTree.TSInstantiationExpression
          | TSESTree.TSInterfaceHeritage
        >(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type,
              expression: this.convertChild(node.expression),
              typeArguments:
                node.typeArguments &&
                this.convertTypeArgumentsToTypeParameterInstantiation(
                  node.typeArguments,
                  node,
                ),
            },
            'typeParameters',
            'typeArguments',
          ),
        );
      }

      case this.ts.SyntaxKind.InterfaceDeclaration: {
        const interfaceHeritageClauses = node.heritageClauses ?? [];
        const interfaceExtends: TSESTree.TSInterfaceHeritage[] = [];

        for (const heritageClause of interfaceHeritageClauses) {
          if (heritageClause.token !== this.ts.SyntaxKind.ExtendsKeyword) {
            this.#throwError(
              heritageClause,
              heritageClause.token === this.ts.SyntaxKind.ImplementsKeyword
                ? "Interface declaration cannot have 'implements' clause."
                : 'Unexpected token.',
            );
          }

          for (const heritageType of heritageClause.types) {
            interfaceExtends.push(
              this.convertChild(
                heritageType,
                node,
              ) as TSESTree.TSInterfaceHeritage,
            );
          }
        }

        const result = this.createNode<TSESTree.TSInterfaceDeclaration>(node, {
          type: AST_NODE_TYPES.TSInterfaceDeclaration,
          body: this.createNode<TSESTree.TSInterfaceBody>(node, {
            type: AST_NODE_TYPES.TSInterfaceBody,
            body: node.members.map(member => this.convertChild(member)),
            range: [node.members.pos - 1, node.end],
          }),
          declare: hasModifier(
            this.ts,
            this.ts.SyntaxKind.DeclareKeyword,
            node,
          ),
          extends: interfaceExtends,
          id: this.convertChild(node.name),
          typeParameters:
            node.typeParameters &&
            this.convertTSTypeParametersToTypeParametersDeclaration(
              node.typeParameters,
            ),
        });

        return this.fixExports(node, result);
      }

      case this.ts.SyntaxKind.TypePredicate: {
        const result = this.createNode<TSESTree.TSTypePredicate>(node, {
          type: AST_NODE_TYPES.TSTypePredicate,
          asserts: node.assertsModifier !== undefined,
          parameterName: this.convertChild(node.parameterName),
          typeAnnotation: null,
        });
        /**
         * Specific fix for type-guard location data
         */
        if (node.type) {
          result.typeAnnotation = this.convertTypeAnnotation(node.type, node);
          result.typeAnnotation.loc = result.typeAnnotation.typeAnnotation.loc;
          result.typeAnnotation.range =
            result.typeAnnotation.typeAnnotation.range;
        }
        return result;
      }

      case this.ts.SyntaxKind.ImportType: {
        const range = getRange(node, this.ast);
        if (node.isTypeOf) {
          const token = findNextToken(
            this.ts,
            node.getFirstToken()!,
            node,
            this.ast,
          )!;
          range[0] = token.getStart(this.ast);
        }
        const result = this.createNode<TSESTree.TSImportType>(
          node,
          this.#withDeprecatedAliasGetter(
            {
              type: AST_NODE_TYPES.TSImportType,
              argument: this.convertChild(node.argument),
              qualifier: this.convertChild(node.qualifier),
              typeArguments: node.typeArguments
                ? this.convertTypeArgumentsToTypeParameterInstantiation(
                    node.typeArguments,
                    node,
                  )
                : null,
              range: range,
            },
            'typeParameters',
            'typeArguments',
          ),
        );

        if (node.isTypeOf) {
          return this.createNode<TSESTree.TSTypeQuery>(node, {
            type: AST_NODE_TYPES.TSTypeQuery,
            exprName: result,
            typeArguments: undefined,
            typeParameters: undefined,
          });
        }
        return result;
      }

      case this.ts.SyntaxKind.EnumDeclaration: {
        const result = this.createNode<TSESTree.TSEnumDeclaration>(node, {
          type: AST_NODE_TYPES.TSEnumDeclaration,
          const: hasModifier(this.ts, this.ts.SyntaxKind.ConstKeyword, node),
          declare: hasModifier(
            this.ts,
            this.ts.SyntaxKind.DeclareKeyword,
            node,
          ),
          id: this.convertChild(node.name),
          members: node.members.map(el => this.convertChild(el)),
        });

        return this.fixExports(node, result);
      }

      case this.ts.SyntaxKind.EnumMember: {
        return this.createNode<TSESTree.TSEnumMember>(node, {
          type: AST_NODE_TYPES.TSEnumMember,
          computed: node.name.kind === this.ts.SyntaxKind.ComputedPropertyName,
          id: this.convertChild(node.name),
          initializer: node.initializer && this.convertChild(node.initializer),
        });
      }

      case this.ts.SyntaxKind.ModuleDeclaration: {
        let isDeclare = hasModifier(
          this.ts,
          this.ts.SyntaxKind.DeclareKeyword,
          node,
        );

        const result = this.createNode<TSESTree.TSModuleDeclaration>(node, {
          type: AST_NODE_TYPES.TSModuleDeclaration,
          ...((): TSESTree.OptionalRangeAndLoc<
            Omit<TSESTree.TSModuleDeclaration, 'parent' | 'type'>
          > => {
            // the constraints checked by this function are syntactically enforced by TS
            // the checks mostly exist for type's sake

            if (node.flags & this.ts.NodeFlags.GlobalAugmentation) {
              const id: TSESTree.Identifier | TSESTree.StringLiteral =
                this.convertChild(node.name);
              const body:
                | TSESTree.TSModuleBlock
                | TSESTree.TSModuleDeclaration
                | null = this.convertChild(node.body);

              if (
                body == null ||
                body.type === AST_NODE_TYPES.TSModuleDeclaration
              ) {
                this.#throwUnlessAllowInvalidAST(
                  node.body ?? node,
                  'Expected a valid module body',
                );
              }
              if (id.type !== AST_NODE_TYPES.Identifier) {
                this.#throwUnlessAllowInvalidAST(
                  node.name,
                  'global module augmentation must have an Identifier id',
                );
              }
              return {
                kind: 'global',
                body: body as TSESTree.TSModuleBlock,
                declare: false,
                global: false,
                id,
              };
            }

            if (!(node.flags & this.ts.NodeFlags.Namespace)) {
              const body: TSESTree.TSModuleBlock | null = this.convertChild(
                node.body,
              );
              return {
                kind: 'module',
                ...(body != null ? { body } : {}),
                declare: false,
                global: false,
                id: this.convertChild(node.name),
              };
            }

            // Nested module declarations are stored in TypeScript as nested tree nodes.
            // We "unravel" them here by making our own nested TSQualifiedName,
            // with the innermost node's body as the actual node body.

            if (node.body == null) {
              this.#throwUnlessAllowInvalidAST(node, 'Expected a module body');
            }
            if (node.name.kind !== this.ts.SyntaxKind.Identifier) {
              this.#throwUnlessAllowInvalidAST(
                node.name,
                '`namespace`s must have an Identifier id',
              );
            }

            let name: TSESTree.Identifier | TSESTree.TSQualifiedName =
              this.createNode<TSESTree.Identifier>(node.name, {
                decorators: [],
                name: node.name.text,
                optional: false,
                range: [node.name.getStart(this.ast), node.name.getEnd()],
                type: AST_NODE_TYPES.Identifier,
                typeAnnotation: undefined,
              });

            while (
              node.body &&
              this.ts.isModuleDeclaration(node.body) &&
              node.body.name
            ) {
              node = node.body;
              isDeclare ||= hasModifier(
                this.ts,
                this.ts.SyntaxKind.DeclareKeyword,
                node,
              );

              const nextName = node.name as ts.Identifier;

              const right = this.createNode<TSESTree.Identifier>(nextName, {
                decorators: [],
                name: nextName.text,
                optional: false,
                range: [nextName.getStart(this.ast), nextName.getEnd()],
                type: AST_NODE_TYPES.Identifier,
                typeAnnotation: undefined,
              });

              name = this.createNode<TSESTree.TSQualifiedName>(nextName, {
                left: name,
                right: right,
                range: [name.range[0], right.range[1]],
                type: AST_NODE_TYPES.TSQualifiedName,
              });
            }

            return {
              kind: 'namespace',
              body: this.convertChild(node.body),
              declare: false,
              global: false,
              id: name,
            };
          })(),
        });

        result.declare = isDeclare;

        if (node.flags & this.ts.NodeFlags.GlobalAugmentation) {
          result.global = true;
        }

        return this.fixExports(node, result);
      }

      // TypeScript specific types
      case this.ts.SyntaxKind.ParenthesizedType: {
        return this.convertChild(node.type);
      }
      case this.ts.SyntaxKind.UnionType: {
        return this.createNode<TSESTree.TSUnionType>(node, {
          type: AST_NODE_TYPES.TSUnionType,
          types: node.types.map(el => this.convertChild(el)),
        });
      }
      case this.ts.SyntaxKind.IntersectionType: {
        return this.createNode<TSESTree.TSIntersectionType>(node, {
          type: AST_NODE_TYPES.TSIntersectionType,
          types: node.types.map(el => this.convertChild(el)),
        });
      }
      case this.ts.SyntaxKind.AsExpression: {
        return this.createNode<TSESTree.TSAsExpression>(node, {
          type: AST_NODE_TYPES.TSAsExpression,
          expression: this.convertChild(node.expression),
          typeAnnotation: this.convertChild(node.type),
        });
      }
      case this.ts.SyntaxKind.InferType: {
        return this.createNode<TSESTree.TSInferType>(node, {
          type: AST_NODE_TYPES.TSInferType,
          typeParameter: this.convertChild(node.typeParameter),
        });
      }
      case this.ts.SyntaxKind.LiteralType: {
        if (node.literal.kind === this.ts.SyntaxKind.NullKeyword) {
          // 4.0 started nesting null types inside a LiteralType node
          // but our AST is designed around the old way of null being a keyword
          return this.createNode<TSESTree.TSNullKeyword>(
            node.literal as ts.NullLiteral,
            {
              type: AST_NODE_TYPES.TSNullKeyword,
            },
          );
        }

        return this.createNode<TSESTree.TSLiteralType>(node, {
          type: AST_NODE_TYPES.TSLiteralType,
          literal: this.convertChild(node.literal),
        });
      }
      case this.ts.SyntaxKind.TypeAssertionExpression: {
        return this.createNode<TSESTree.TSTypeAssertion>(node, {
          type: AST_NODE_TYPES.TSTypeAssertion,
          typeAnnotation: this.convertChild(node.type),
          expression: this.convertChild(node.expression),
        });
      }
      case this.ts.SyntaxKind.ImportEqualsDeclaration: {
        return this.fixExports(
          node,
          this.createNode<TSESTree.TSImportEqualsDeclaration>(node, {
            type: AST_NODE_TYPES.TSImportEqualsDeclaration,
            id: this.convertChild(node.name),
            importKind: node.isTypeOnly ? 'type' : 'value',
            moduleReference: this.convertChild(node.moduleReference),
          }),
        );
      }
      case this.ts.SyntaxKind.ExternalModuleReference: {
        if (node.expression.kind !== this.ts.SyntaxKind.StringLiteral) {
          this.#throwError(node.expression, 'String literal expected.');
        }
        return this.createNode<TSESTree.TSExternalModuleReference>(node, {
          type: AST_NODE_TYPES.TSExternalModuleReference,
          expression: this.convertChild(node.expression),
        });
      }
      case this.ts.SyntaxKind.NamespaceExportDeclaration: {
        return this.createNode<TSESTree.TSNamespaceExportDeclaration>(node, {
          type: AST_NODE_TYPES.TSNamespaceExportDeclaration,
          id: this.convertChild(node.name),
        });
      }
      case this.ts.SyntaxKind.AbstractKeyword: {
        return this.createNode<TSESTree.TSAbstractKeyword>(node, {
          type: AST_NODE_TYPES.TSAbstractKeyword,
        });
      }

      // Tuple
      case this.ts.SyntaxKind.TupleType: {
        const elementTypes = node.elements.map(el => this.convertChild(el));

        return this.createNode<TSESTree.TSTupleType>(node, {
          type: AST_NODE_TYPES.TSTupleType,
          elementTypes,
        });
      }
      case this.ts.SyntaxKind.NamedTupleMember: {
        const member = this.createNode<TSESTree.TSNamedTupleMember>(node, {
          type: AST_NODE_TYPES.TSNamedTupleMember,
          elementType: this.convertChild(node.type, node),
          label: this.convertChild(node.name, node),
          optional: node.questionToken != null,
        });

        if (node.dotDotDotToken) {
          // adjust the start to account for the "..."
          member.range[0] = member.label.range[0];
          member.loc.start = member.label.loc.start;
          return this.createNode<TSESTree.TSRestType>(node, {
            type: AST_NODE_TYPES.TSRestType,
            typeAnnotation: member,
          });
        }

        return member;
      }
      case this.ts.SyntaxKind.OptionalType: {
        return this.createNode<TSESTree.TSOptionalType>(node, {
          type: AST_NODE_TYPES.TSOptionalType,
          typeAnnotation: this.convertChild(node.type),
        });
      }
      case this.ts.SyntaxKind.RestType: {
        return this.createNode<TSESTree.TSRestType>(node, {
          type: AST_NODE_TYPES.TSRestType,
          typeAnnotation: this.convertChild(node.type),
        });
      }

      // Template Literal Types
      case this.ts.SyntaxKind.TemplateLiteralType: {
        const result = this.createNode<TSESTree.TSTemplateLiteralType>(node, {
          type: AST_NODE_TYPES.TSTemplateLiteralType,
          quasis: [this.convertChild(node.head)],
          types: [],
        });

        node.templateSpans.forEach(templateSpan => {
          result.types.push(
            this.convertChild(templateSpan.type) as TSESTree.TypeNode,
          );
          result.quasis.push(
            this.convertChild(templateSpan.literal) as TSESTree.TemplateElement,
          );
        });
        return result;
      }

      case this.ts.SyntaxKind.ClassStaticBlockDeclaration: {
        return this.createNode<TSESTree.StaticBlock>(node, {
          type: AST_NODE_TYPES.StaticBlock,
          body: this.convertBodyExpressions(node.body.statements, node),
        });
      }

      // eslint-disable-next-line deprecation/deprecation -- required for backwards-compatibility
      case this.ts.SyntaxKind.AssertEntry:
      case this.ts.SyntaxKind.ImportAttribute: {
        return this.createNode<TSESTree.ImportAttribute>(node, {
          type: AST_NODE_TYPES.ImportAttribute,
          key: this.convertChild(node.name),
          value: this.convertChild(node.value),
        });
      }

      case this.ts.SyntaxKind.SatisfiesExpression: {
        return this.createNode<TSESTree.TSSatisfiesExpression>(node, {
          type: AST_NODE_TYPES.TSSatisfiesExpression,
          expression: this.convertChild(node.expression),
          typeAnnotation: this.convertChild(node.type),
        });
      }

      default:
        return this.deeplyCopy(node);
    }
  }

  #checkModifiers(node: ts.Node): void {
    if (this.options.allowInvalidAST) {
      return;
    }

    // typescript<5.0.0
    if (nodeHasIllegalDecorators(node)) {
      this.#throwError(
        node.illegalDecorators[0],
        'Decorators are not valid here.',
      );
    }

    for (const decorator of getDecorators(
      this.ts,
      node,
      /* includeIllegalDecorators */ true,
    ) ?? []) {
      // `checkGrammarModifiers` function in typescript
      if (!nodeCanBeDecorated(this.ts, node as TSNode)) {
        if (this.ts.isMethodDeclaration(node) && !nodeIsPresent(node.body)) {
          this.#throwError(
            decorator,
            'A decorator can only decorate a method implementation, not an overload.',
          );
        } else {
          this.#throwError(decorator, 'Decorators are not valid here.');
        }
      }
    }

    for (const modifier of getModifiers(
      this.ts,
      node,
      /* includeIllegalModifiers */ true,
    ) ?? []) {
      if (modifier.kind !== this.ts.SyntaxKind.ReadonlyKeyword) {
        if (
          node.kind === this.ts.SyntaxKind.PropertySignature ||
          node.kind === this.ts.SyntaxKind.MethodSignature
        ) {
          this.#throwError(
            modifier,
            `'${this.ts.tokenToString(
              modifier.kind,
            )}' modifier cannot appear on a type member`,
          );
        }

        if (
          node.kind === this.ts.SyntaxKind.IndexSignature &&
          (modifier.kind !== this.ts.SyntaxKind.StaticKeyword ||
            !this.ts.isClassLike(node.parent))
        ) {
          this.#throwError(
            modifier,
            `'${this.ts.tokenToString(
              modifier.kind,
            )}' modifier cannot appear on an index signature`,
          );
        }
      }

      if (
        modifier.kind !== this.ts.SyntaxKind.InKeyword &&
        modifier.kind !== this.ts.SyntaxKind.OutKeyword &&
        modifier.kind !== this.ts.SyntaxKind.ConstKeyword &&
        node.kind === this.ts.SyntaxKind.TypeParameter
      ) {
        this.#throwError(
          modifier,
          `'${this.ts.tokenToString(
            modifier.kind,
          )}' modifier cannot appear on a type parameter`,
        );
      }

      if (
        (modifier.kind === this.ts.SyntaxKind.InKeyword ||
          modifier.kind === this.ts.SyntaxKind.OutKeyword) &&
        (node.kind !== this.ts.SyntaxKind.TypeParameter ||
          !(
            this.ts.isInterfaceDeclaration(node.parent) ||
            this.ts.isClassLike(node.parent) ||
            this.ts.isTypeAliasDeclaration(node.parent)
          ))
      ) {
        this.#throwError(
          modifier,
          `'${this.ts.tokenToString(
            modifier.kind,
          )}' modifier can only appear on a type parameter of a class, interface or type alias`,
        );
      }

      if (
        modifier.kind === this.ts.SyntaxKind.ReadonlyKeyword &&
        node.kind !== this.ts.SyntaxKind.PropertyDeclaration &&
        node.kind !== this.ts.SyntaxKind.PropertySignature &&
        node.kind !== this.ts.SyntaxKind.IndexSignature &&
        node.kind !== this.ts.SyntaxKind.Parameter
      ) {
        this.#throwError(
          modifier,
          "'readonly' modifier can only appear on a property declaration or index signature.",
        );
      }

      if (
        modifier.kind === this.ts.SyntaxKind.DeclareKeyword &&
        this.ts.isClassLike(node.parent) &&
        !this.ts.isPropertyDeclaration(node)
      ) {
        this.#throwError(
          modifier,
          `'${this.ts.tokenToString(
            modifier.kind,
          )}' modifier cannot appear on class elements of this kind.`,
        );
      }

      if (
        modifier.kind === this.ts.SyntaxKind.DeclareKeyword &&
        this.ts.isVariableStatement(node)
      ) {
        const declarationKind = getDeclarationKind(node.declarationList);
        if (declarationKind === 'using' || declarationKind === 'await using') {
          this.#throwError(
            modifier,
            `'declare' modifier cannot appear on a '${declarationKind}' declaration.`,
          );
        }
      }

      if (
        modifier.kind === this.ts.SyntaxKind.AbstractKeyword &&
        node.kind !== this.ts.SyntaxKind.ClassDeclaration &&
        node.kind !== this.ts.SyntaxKind.ConstructorType &&
        node.kind !== this.ts.SyntaxKind.MethodDeclaration &&
        node.kind !== this.ts.SyntaxKind.PropertyDeclaration &&
        node.kind !== this.ts.SyntaxKind.GetAccessor &&
        node.kind !== this.ts.SyntaxKind.SetAccessor
      ) {
        this.#throwError(
          modifier,
          `'${this.ts.tokenToString(
            modifier.kind,
          )}' modifier can only appear on a class, method, or property declaration.`,
        );
      }

      if (
        (modifier.kind === this.ts.SyntaxKind.StaticKeyword ||
          modifier.kind === this.ts.SyntaxKind.PublicKeyword ||
          modifier.kind === this.ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === this.ts.SyntaxKind.PrivateKeyword) &&
        (node.parent.kind === this.ts.SyntaxKind.ModuleBlock ||
          node.parent.kind === this.ts.SyntaxKind.SourceFile)
      ) {
        this.#throwError(
          modifier,
          `'${this.ts.tokenToString(
            modifier.kind,
          )}' modifier cannot appear on a module or namespace element.`,
        );
      }

      if (
        modifier.kind === this.ts.SyntaxKind.AccessorKeyword &&
        node.kind !== this.ts.SyntaxKind.PropertyDeclaration
      ) {
        this.#throwError(
          modifier,
          "'accessor' modifier can only appear on a property declaration.",
        );
      }

      // `checkGrammarAsyncModifier` function in `typescript`
      if (
        modifier.kind === this.ts.SyntaxKind.AsyncKeyword &&
        node.kind !== this.ts.SyntaxKind.MethodDeclaration &&
        node.kind !== this.ts.SyntaxKind.FunctionDeclaration &&
        node.kind !== this.ts.SyntaxKind.FunctionExpression &&
        node.kind !== this.ts.SyntaxKind.ArrowFunction
      ) {
        this.#throwError(modifier, "'async' modifier cannot be used here.");
      }

      // `checkGrammarModifiers` function in `typescript`
      if (
        node.kind === this.ts.SyntaxKind.Parameter &&
        (modifier.kind === this.ts.SyntaxKind.StaticKeyword ||
          modifier.kind === this.ts.SyntaxKind.ExportKeyword ||
          modifier.kind === this.ts.SyntaxKind.DeclareKeyword ||
          modifier.kind === this.ts.SyntaxKind.AsyncKeyword)
      ) {
        this.#throwError(
          modifier,
          `'${this.ts.tokenToString(
            modifier.kind,
          )}' modifier cannot appear on a parameter.`,
        );
      }

      // `checkGrammarModifiers` function in `typescript`
      if (
        modifier.kind === this.ts.SyntaxKind.PublicKeyword ||
        modifier.kind === this.ts.SyntaxKind.ProtectedKeyword ||
        modifier.kind === this.ts.SyntaxKind.PrivateKeyword
      ) {
        for (const anotherModifier of getModifiers(this.ts, node) ?? []) {
          if (
            anotherModifier !== modifier &&
            (anotherModifier.kind === this.ts.SyntaxKind.PublicKeyword ||
              anotherModifier.kind === this.ts.SyntaxKind.ProtectedKeyword ||
              anotherModifier.kind === this.ts.SyntaxKind.PrivateKeyword)
          ) {
            this.#throwError(
              anotherModifier,
              `Accessibility modifier already seen.`,
            );
          }
        }
      }

      // `checkParameter` function in `typescript`
      if (
        node.kind === this.ts.SyntaxKind.Parameter &&
        // In `typescript` package, it's `ts.hasSyntacticModifier(node, ts.ModifierFlags.ParameterPropertyModifier)`
        // https://github.com/typescript-eslint/typescript-eslint/pull/6615#discussion_r1136489935
        (modifier.kind === this.ts.SyntaxKind.PublicKeyword ||
          modifier.kind === this.ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === this.ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === this.ts.SyntaxKind.ReadonlyKeyword ||
          modifier.kind === this.ts.SyntaxKind.OverrideKeyword)
      ) {
        const func = getContainingFunction(this.ts, node)!;

        if (
          !(
            func.kind === this.ts.SyntaxKind.Constructor &&
            nodeIsPresent(func.body)
          )
        ) {
          this.#throwError(
            modifier,
            'A parameter property is only allowed in a constructor implementation.',
          );
        }
      }
    }
  }

  #throwUnlessAllowInvalidAST(
    node: ts.Node | number,
    message: string,
  ): asserts node is never {
    if (!this.options.allowInvalidAST) {
      this.#throwError(node, message);
    }
  }

  /**
   * Creates a getter for a property under aliasKey that returns the value under
   * valueKey. If suppressDeprecatedPropertyWarnings is not enabled, the
   * getter also console warns about the deprecation.
   *
   * @see https://github.com/typescript-eslint/typescript-eslint/issues/6469
   */
  #withDeprecatedAliasGetter<
    Properties extends { type: string },
    AliasKey extends string,
    ValueKey extends string & keyof Properties,
  >(
    node: Properties,
    aliasKey: AliasKey,
    valueKey: ValueKey,
    suppressWarnings = false,
  ): Properties & Record<AliasKey, Properties[ValueKey]> {
    let warned = suppressWarnings;

    Object.defineProperty(node, aliasKey, {
      configurable: true,
      get: this.options.suppressDeprecatedPropertyWarnings
        ? (): Properties[typeof valueKey] => node[valueKey]
        : (): Properties[typeof valueKey] => {
            if (!warned) {
              process.emitWarning(
                `The '${aliasKey}' property is deprecated on ${node.type} nodes. Use '${valueKey}' instead. See https://typescript-eslint.io/linting/troubleshooting#the-key-property-is-deprecated-on-type-nodes-use-key-instead-warnings.`,
                'DeprecationWarning',
              );
              warned = true;
            }

            return node[valueKey];
          },
      set(value): void {
        Object.defineProperty(node, aliasKey, {
          enumerable: true,
          writable: true,
          value,
        });
      },
    });

    return node as Properties & Record<AliasKey, Properties[ValueKey]>;
  }

  #throwError(node: ts.Node | number, message: string): asserts node is never {
    let start;
    let end;
    if (typeof node === 'number') {
      start = end = node;
    } else {
      start = node.getStart(this.ast);
      end = node.getEnd();
    }

    throw createError(message, this.ast, start, end);
  }
  #checkForStatementDeclaration(initializer: ts.ForInitializer): void {
    if (this.ts.isVariableDeclarationList(initializer)) {
      if ((initializer.flags & this.ts.NodeFlags.Using) !== 0) {
        this.#throwError(
          initializer,
          "The left-hand side of a 'for...in' statement cannot be a 'using' declaration.",
        );
      }
    }
  }
}
