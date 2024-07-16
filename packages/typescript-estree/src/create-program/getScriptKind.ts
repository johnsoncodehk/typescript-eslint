import path from 'path';
import type * as ts from 'typescript';

function getScriptKind(filePath: string, jsx: boolean): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase() as ts.Extension;
  // note - we only respect the user's jsx setting for unknown extensions
  // this is so that we always match TS's internal script kind logic, preventing
  // weird errors due to a mismatch.
  // https://github.com/microsoft/TypeScript/blob/da00ba67ed1182ad334f7c713b8254fba174aeba/src/compiler/utilities.ts#L6948-L6968
  switch (extension) {
    case '.js' /* ts.Extension.Js */:
    case '.cjs' /* ts.Extension.Cjs */:
    case '.mjs' /* ts.Extension.Mjs */:
      return 1 satisfies ts.ScriptKind.JS;

    case '.jsx' /* ts.Extension.Jsx */:
      return 2 satisfies ts.ScriptKind.JSX;

    case '.ts' /* ts.Extension.Ts */:
    case '.cts' /* ts.Extension.Cts */:
    case '.mts' /* ts.Extension.Mts */:
      return 3 satisfies ts.ScriptKind.TS;

    case '.tsx' /* ts.Extension.Tsx */:
      return 4 satisfies ts.ScriptKind.TSX;

    case '.json' /* ts.Extension.Json */:
      return 6 satisfies ts.ScriptKind.JSON;

    default:
      // unknown extension, force typescript to ignore the file extension, and respect the user's setting
      return jsx
        ? (4 satisfies ts.ScriptKind.TSX)
        : (3 satisfies ts.ScriptKind.TS);
  }
}

function getLanguageVariant(scriptKind: ts.ScriptKind): ts.LanguageVariant {
  // https://github.com/microsoft/TypeScript/blob/d6e483b8dabd8fd37c00954c3f2184bb7f1eb90c/src/compiler/utilities.ts#L6281-L6285
  switch (scriptKind) {
    case 4 satisfies ts.ScriptKind.TSX:
    case 2 satisfies ts.ScriptKind.JSX:
    case 1 satisfies ts.ScriptKind.JS:
    case 6 satisfies ts.ScriptKind.JSON:
      return 1 satisfies ts.LanguageVariant.JSX;

    default:
      return 0 satisfies ts.LanguageVariant.Standard;
  }
}

export { getScriptKind, getLanguageVariant };
