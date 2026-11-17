import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the real helpers for Node without changing their bundler import paths.
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const catalogs = moduleUrl(compile('../src/lib/catalogs.ts'));
const { resolveContent, resolveGeneralContent, availableLanguages } = await import(moduleUrl(
  compile('../src/lib/i18n.ts').replace('"./catalogs"', JSON.stringify(catalogs)),
));
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Preserved' }] }] };

test('General prose resolves requested, English and available languages without parsing markup', () => {
  assert.equal(resolveGeneralContent({ fr: '<b>fr</b>', en: 'en' }, 'fr'), '<b>fr</b>');
  assert.equal(resolveGeneralContent({ en: 'fallback', es: 'es' }, 'fr'), 'fallback');
  assert.equal(resolveGeneralContent({ ar: 'available' }, 'fr'), 'available');
  assert.equal(resolveGeneralContent('scalar'), 'scalar');
  assert.equal(resolveGeneralContent({ fr: '', en: 'fallback' }, 'fr'), '');
  assert.equal(resolveGeneralContent([]), null);
  assert.equal(resolveGeneralContent({ type: "doc", content: "invalid" }), null);
});

test('legacy document resolution preserves documents and excludes scalar prose', () => {
  assert.deepEqual(resolveContent(doc), doc);
  assert.deepEqual(resolveContent({ fr: doc }, 'fr'), doc);
  assert.equal(resolveContent({ fr: 'plain prose' }, 'fr'), null);
});

test('language discovery traverses structured General payloads and excludes asset references', () => {
  assert.deepEqual(availableLanguages({ items: [{ contents: [{ country_name: { ar: 'country' }, communications: [{ contents: { fr: 'prose', es: doc } }] }] }] }), ['fr', 'es', 'ar']);
  assert.deepEqual(availableLanguages({ en: doc, fr: 'general/file.adoc' }), ['en']);
  assert.deepEqual(availableLanguages('general/file.adoc'), []);
  assert.deepEqual(availableLanguages(doc), ['en']);
});
