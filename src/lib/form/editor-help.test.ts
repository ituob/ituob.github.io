import { readFileSync } from 'node:fs';
import { compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

const screens = [
  ['src/components/admin/GeneralMessageEditor.vue', ['Authoring help', 'country and SANC code', 'communications with their publication dates']],
  ['src/components/admin/EditionMetadata.vue', ['Scheduling help', 'Save metadata first', 'reviewed and merged publication request']],
  ['src/components/admin/SubmissionWorkspace.vue', ['Amendment authoring help', 'ADD and REP need complete entries', 'MOD carries the changed values and identifying key', 'Textual amendments are staff-only patches']],
] as const;

describe('admin editor inline help', () => {
  it.each(screens)('%s compiles and exposes the relevant help in its template', (file, phrases) => {
    const source = readFileSync(file, 'utf8');
    const { descriptor, errors } = parse(source, { filename: file });
    expect(errors).toEqual([]);
    expect(descriptor.template).not.toBeNull();
    const template = descriptor.template!.content;
    expect(compileTemplate({ source: template, filename: file, id: 'editor-help' }).errors).toEqual([]);
    expect(template).toContain('<details>');
    expect(template).toContain('<summary>');
    for (const phrase of phrases) expect(template).toContain(phrase);
  });
});
