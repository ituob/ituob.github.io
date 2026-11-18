import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createServer } from 'vite';

const source = readFileSync(new URL('../src/pages/issues/[id]/[lang].astro', import.meta.url), 'utf8').split('---')[1];
const ast = ts.createSourceFile('language-route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const generator = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'getStaticPaths');
const javascript = ts.transpileModule(generator.getText(ast).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: 'error' });
let availableLanguages, supportedLanguages;
try {
  ({ availableLanguages } = await server.ssrLoadModule('/src/lib/i18n.ts'));
  ({ SUPPORTED_LANGUAGES: supportedLanguages } = await server.ssrLoadModule('/src/lib/catalogs.ts'));
} finally {
  await server.close();
}
const pathsFor = (issues) => new Function('listIssueIds', 'loadIssue', 'availableLanguages', 'SUPPORTED_LANGUAGES',
  `${javascript}\nreturn getStaticPaths();`)(() => Object.keys(issues), id => issues[id], availableLanguages, supportedLanguages);
const issue = (languages, textual = [], amendments = {}) => ({ meta: { languages }, general: { textual }, amendments: { textual: amendments } });
const doc = { type: 'doc', content: [] };

test('metadata-only legacy editions retain their public routes with English fallback', () => {
  // OB 1173 retains YAML 1.1 yes scalars; OB 1195 has native booleans.
  assert.deepEqual(pathsFor({
    1173: issue({ en: 'yes', ru: 'yes', zh: 'yes' }, [{ contents: { en: doc } }]),
    1195: issue({ en: true, fr: true }, [{ contents: { en: doc } }]),
  }), [
    { params: { id: '1173', lang: 'ru' } },
    { params: { id: '1173', lang: 'zh' } },
    { params: { id: '1195', lang: 'fr' } },
  ]);
});

test('content-discovered languages survive absent metadata and duplicates', () => {
  assert.deepEqual(pathsFor({
    1200: issue({ fr: true }, [{ contents: { en: doc, fr: doc } }], { text: { contents: { es: doc } } }),
    1201: issue(undefined, [{ contents: { ar: doc } }]),
  }), [
    { params: { id: '1200', lang: 'fr' } },
    { params: { id: '1200', lang: 'es' } },
    { params: { id: '1201', lang: 'ar' } },
  ]);
});

test('disabled and unsupported metadata never creates routes; English keeps its canonical page', () => {
  assert.deepEqual(pathsFor({
    1200: issue({ en: true, fr: false, ru: 'no', zh: 'false', de: true }),
    1201: null,
  }), []);
});
