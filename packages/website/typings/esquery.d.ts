// forked from https://github.com/DefinitelyTyped/DefinitelyTyped/blob/f8e7d054df8c4546dc911f0cf4ca6a0c2d51f11e/types/esquery/index.d.ts

declare module 'esquery' {
  // use our types instead of the estree types
  import type { TSESTree } from '@typescript-eslint/types';

  export as namespace esquery;

  export = query;

  type Node = TSESTree.Node;

  /** Query the code AST using the selector string. */
  declare function query(ast: Node, selector: string): Node[];

  declare namespace query {
    interface ESQueryOptions {
      nodeTypeKey?: string;
      visitorKeys?: Record<string, readonly string[]>;
      fallback?: (node: Node) => string[];
      matchClass?: (className: string, node: Node, ancestry: Node[]) => boolean;
    }
    /** Parse a selector and return its AST. */
    function parse(selector: string): Selector;
    /** From a JS AST and a selector AST, collect all JS AST nodes that match the selector. */
    function match(
      ast: Node,
      selector: Selector,
      options?: ESQueryOptions,
    ): Node[];
    /** Given a `node` and its ancestors, determine if `node` is matched by `selector`. */
    function matches(
      node: Node,
      selector: Selector,
      ancestry: Node[],
      options?: ESQueryOptions,
    ): boolean;
    /** Query the code AST using the selector string. */
    function query(
      ast: Node,
      selector: string,
      options?: ESQueryOptions,
    ): Node[];

    //
    // Unions
    //
    type Selector =
      | Adjacent
      | Attribute
      | Child
      | Class
      | Descendant
      | Field
      | Has
      | Identifier
      | Matches
      | Negation
      | NthChild
      | NthLastChild
      | Sequence
      | Sibling
      | Type
      | Wildcard;
    type MultiSelector = Has | Matches | Negation | Sequence;
    type BinarySelector = Adjacent | Child | Descendant | Sibling;
    type NthSelector = NthChild | NthLastChild;
    type SubjectSelector =
      | Attribute
      | BinarySelector
      | Identifier
      | MultiSelector
      | NthSelector
      | Wildcard;
    type Literal = NumericLiteral | StringLiteral;

    //
    // Base Atoms
    //
    interface Atom {
      type: string;
    }
    interface SubjectSelectorAtom extends Atom {
      subject?: boolean | undefined;
    }
    interface NthSelectorAtom extends SubjectSelectorAtom {
      index: NumericLiteral;
    }
    interface BinarySelectorAtom extends SubjectSelectorAtom {
      type: 'adjacent' | 'child' | 'descendant' | 'sibling';
      left: SubjectSelector;
      right: SubjectSelector;
    }
    interface MultiSelectorAtom extends SubjectSelectorAtom {
      selectors: SubjectSelector[];
    }
    interface LiteralAtom extends Atom {
      type: 'literal';
      value: number | string;
    }

    //
    // Literals
    //
    interface StringLiteral extends LiteralAtom {
      value: string;
    }
    interface NumericLiteral extends LiteralAtom {
      value: number;
    }
    interface RegExpLiteral extends Atom {
      type: 'regexp';
      value: RegExp;
    }

    //
    // Atoms
    //
    interface Field extends Atom {
      type: 'field';
      name: string;
    }
    interface Type extends Atom {
      type: 'type';
      value: string;
    }
    interface Sequence extends MultiSelectorAtom {
      type: 'compound';
    }
    interface Identifier extends SubjectSelectorAtom {
      type: 'identifier';
      value: string;
    }
    interface Wildcard extends SubjectSelectorAtom {
      type: 'wildcard';
      value: '*';
    }
    interface Attribute extends SubjectSelectorAtom {
      type: 'attribute';
      name: string;
      operator?: '!=' | '<' | '<=' | '=' | '>' | '>=' | undefined;
      value?: Literal | RegExpLiteral | Type | undefined;
    }
    interface NthChild extends NthSelectorAtom {
      type: 'nth-child';
    }
    interface NthLastChild extends NthSelectorAtom {
      type: 'nth-last-child';
    }
    interface Descendant extends BinarySelectorAtom {
      type: 'descendant';
    }
    interface Child extends BinarySelectorAtom {
      type: 'child';
    }
    interface Sibling extends BinarySelectorAtom {
      type: 'sibling';
    }
    interface Adjacent extends BinarySelectorAtom {
      type: 'adjacent';
    }
    interface Negation extends MultiSelectorAtom {
      type: 'not';
    }
    interface Matches extends MultiSelectorAtom {
      type: 'matches';
    }
    interface Has extends MultiSelectorAtom {
      type: 'has';
    }
    interface Class extends Atom {
      type: 'class';
      name: 'declaration' | 'expression' | 'function' | 'pattern' | 'statement';
    }
  }
}
