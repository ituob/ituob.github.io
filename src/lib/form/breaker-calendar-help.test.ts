import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as renderer from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import * as calendar from './schedule-calendar';
import { YamlTimestamp } from './yaml-io';

function evaluate(source: string) {
  const modules: Record<string, unknown> = {
    vue: Vue, 'vue/server-renderer': renderer, '../../lib/form/schedule-calendar': calendar,
    '../../styles/admin-forms.css': {},
  };
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const result = { exports: {} as any };
  new Function('require', 'module', 'exports', js)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, result, result.exports);
  return result.exports;
}

async function renderCalendar(props: Record<string, unknown>) {
  const filename = 'src/components/admin/ScheduleCalendar.vue';
  const { descriptor } = parse(readFileSync(filename, 'utf8'));
  const component = evaluate(compileScript(descriptor, { id: 'breaker-calendar' }).content).default;
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'breaker-calendar', ssr: true });
  expect(template.errors).toEqual([]);
  component.ssrRender = evaluate(template.code).ssrRender;
  const setup = component.setup;
  component.setup = (props: unknown, context: unknown) => ({ ...setup(props, context) });
  return renderer.renderToString(Vue.createSSRApp(component, props));
}

const attack = '</time><script>alert(1)</script><img src=x onerror="alert(1)">';

describe('adversarial calendar date contract', () => {
  it.each([
    '1900-02-29', '2100-02-29', '2024-00-01', '2024-01-00', '2024-04-31',
    '2024-01-32', '2024-1-01', '2024-01-01\n', ' 2024-01-01',
    '2024-01-01T00:00:00Z', '10000-01-01', '-0001-01-01', attack,
    null, undefined, 20240101, new Date('2024-01-01'), { text: '2024-01-01' },
  ])('rejects invalid or noncanonical date %j', value => {
    expect(calendar.parseScheduleDate(value)).toBeNull();
    expect(calendar.scheduleDateLabel(value)).toBe('Not set');
  });

  it.each(['0000-02-29', '0099-01-01', '0400-02-29', '2000-02-29', '9999-12-31'])('preserves valid boundary/leap date %s', date => {
    expect(calendar.parseScheduleDate(date)?.date).toBe(date);
    expect(calendar.parseScheduleDate(new YamlTimestamp(date))?.date).toBe(date);
    const parsed = calendar.parseScheduleDate(date)!;
    const days = calendar.calendarDays(parsed, date, date);
    expect(days.filter(day => day.inMonth)).toHaveLength(new Date(`${date.slice(0, 7)}-01T00:00:00Z`).getUTCMonth() === 1 ? 29 : 31);
    expect(days.filter(day => day.cutoff && day.publication).map(day => day.date)).toEqual([date]);
  });

  it.each([
    [2024, 3, '2024-02-25', '2024-04-06'],
    [2024, 11, '2024-10-27', '2024-12-07'],
    [2011, 12, '2011-11-27', '2012-01-07'],
  ])('keeps a contiguous UTC grid through DST and skipped local days: %i-%i', (year, month, first, last) => {
    const days = calendar.calendarDays({ year, month }, `${year}-${String(month).padStart(2, '0')}-01`, null);
    expect(days).toHaveLength(42);
    expect(days[0]!.date).toBe(first);
    expect(days[41]!.date).toBe(last);
    expect(new Set(days.map(day => day.date)).size).toBe(42);
    for (let i = 1; i < days.length; i++) {
      expect(Date.parse(days[i]!.date) - Date.parse(days[i - 1]!.date)).toBe(86_400_000);
    }
  });

  it('uses UTC at offset year boundaries and preserves cutoff priority', () => {
    expect(calendar.initialCalendarMonth(null, null, new Date('2025-01-01T00:30:00+14:00'))).toEqual({ year: 2024, month: 12 });
    expect(calendar.initialCalendarMonth('2024-12-31', '2025-01-01')).toEqual({ year: 2024, month: 12 });
    expect(calendar.shiftCalendarMonth({ year: 99, month: 12 }, 1)).toEqual({ year: 100, month: 1 });
    expect(calendar.shiftCalendarMonth({ year: 2024, month: 1 }, -13)).toEqual({ year: 2022, month: 12 });
  });

  it.each([{ year: 0, month: 1 }, { year: 9999, month: 12 }])('all grid datetime keys should remain valid at year boundary %j', month => {
    // Deliberately asserts the public YYYY-MM-DD contract for every rendered <time>.
    const invalid = calendar.calendarDays(month, null, null).filter(day => !calendar.parseScheduleDate(day.date));
    expect(invalid.map(day => day.date)).toEqual([]);
  });

  it('rejects hostile calendar props without emitting HTML or attribute payloads', async () => {
    const html = await renderCalendar({ cutoffDate: attack, publicationDate: new YamlTimestamp(attack) });
    expect(html).toContain('Cutoff date: <span>Not set</span>');
    expect(html).toContain('Publication date: <span>Not set</span>');
    expect(html).not.toMatch(/<script|<img|onerror|alert\(1\)/i);
    const selected = await renderCalendar({ cutoffDate: '2024-02-29', publicationDate: '2024-02-29' });
    expect(selected).toContain('2024-02-29, cutoff date, publication date');
    expect(selected).toContain('<span>Cutoff</span><span>Publication</span>');
  });
});

describe('actual inline help templates under hostile context', () => {
  it.each([
    ['GeneralMessageEditor.vue', 'Authoring help'],
    ['EditionMetadata.vue', 'Scheduling help'],
    ['SubmissionWorkspace.vue', 'Amendment authoring help'],
  ])('%s help stays static and contains no HTML sink', async (file, summary) => {
    const filename = `src/components/admin/${file}`;
    const { descriptor } = parse(readFileSync(filename, 'utf8'));
    const help = descriptor.template!.content.match(new RegExp(`<details>\\s*<summary>${summary}</summary>[\\s\\S]*?</details>`))?.[0];
    expect(help).toBeDefined();
    expect(help).not.toMatch(/v-html|innerHTML|:href|:src/);
    const compiled = compileTemplate({ source: help!, filename, id: 'breaker-help', ssr: true });
    expect(compiled.errors).toEqual([]);
    const ssrRender = evaluate(compiled.code).ssrRender;
    for (const type of [attack, 'sanc', 'telephone_service', 'telephone_service_2']) {
      const html = await renderer.renderToString(Vue.createSSRApp({
        setup: () => ({ type, error: attack, notice: attack, issueNo: attack, detail: attack }), ssrRender,
      }));
      expect(html).toContain(`<summary>${summary}</summary>`);
      expect(html).not.toMatch(/<script|<img|onerror|alert\(1\)/i);
      if (file === 'GeneralMessageEditor.vue') {
        expect(html).toContain(type === 'sanc' ? 'country and SANC code' : type.startsWith('telephone_service') ? 'communications with their publication dates' : 'Use the structured fields');
      }
    }
  });
});
