import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import * as renderer from 'vue/server-renderer';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { canShiftCalendarMonth, calendarDays, calendarMonthTitle, initialCalendarMonth, parseScheduleDate, scheduleDateLabel, shiftCalendarMonth } from './schedule-calendar';
import * as calendar from './schedule-calendar';
import { YamlTimestamp } from './yaml-io';

function evaluate(source: string) {
  const modules: Record<string, unknown> = { vue: Vue, 'vue/server-renderer': renderer, '../../lib/form/schedule-calendar': calendar, '../../styles/admin-forms.css': {} };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = { exports: {} as any };
  new Function('require', 'module', 'exports', js)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, result, result.exports);
  return result.exports;
}

async function renderCalendar(cutoffDate: string) {
  const filename = 'src/components/admin/ScheduleCalendar.vue';
  const { descriptor } = parse(readFileSync(filename, 'utf8'));
  const component = evaluate(compileScript(descriptor, { id: 'schedule-boundary' }).content).default;
  const compiled = compileTemplate({ source: descriptor.template!.content, filename, id: 'schedule-boundary', ssr: true });
  expect(compiled.errors).toEqual([]);
  component.ssrRender = evaluate(compiled.code).ssrRender;
  const setup = component.setup;
  component.setup = (props: unknown, context: unknown) => ({ ...setup(props, context) });
  return renderer.renderToString(Vue.createSSRApp(component, { cutoffDate, publicationDate: null }));
}

describe('schedule calendar dates', () => {
  it('accepts valid ISO and YAML dates but ignores empty, invalid, and non-date text', () => {
    expect(parseScheduleDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29, date: '2024-02-29' });
    expect(parseScheduleDate(new YamlTimestamp('2024-02-29'))?.date).toBe('2024-02-29');
    expect(parseScheduleDate('2023-02-29')).toBeNull();
    expect(parseScheduleDate('2024-13-01')).toBeNull();
    expect(parseScheduleDate('')).toBeNull();
    expect(parseScheduleDate('next Friday')).toBeNull();
    expect(scheduleDateLabel('2024-02-30')).toBe('Not set');
    expect(scheduleDateLabel('')).toBe('Not set');
  });

  it('starts at the first selected valid month, falling back to the current UTC month', () => {
    expect(initialCalendarMonth('bad date', '2025-11-20')).toEqual({ year: 2025, month: 11 });
    expect(initialCalendarMonth('', null, new Date('2026-01-01T00:30:00+03:00'))).toEqual({ year: 2025, month: 12 });
  });

  it('moves across year boundaries and labels months in UTC', () => {
    expect(shiftCalendarMonth({ year: 2025, month: 1 }, -1)).toEqual({ year: 2024, month: 12 });
    expect(shiftCalendarMonth({ year: 2025, month: 12 }, 1)).toEqual({ year: 2026, month: 1 });
    expect(calendarMonthTitle({ year: 2024, month: 2 })).toBe('February 2024');
  });

  it('clamps navigation and emits only unique four-digit dates at supported year edges', () => {
    expect(shiftCalendarMonth({ year: 0, month: 1 }, -1)).toEqual({ year: 0, month: 1 });
    expect(shiftCalendarMonth({ year: 9999, month: 12 }, 1)).toEqual({ year: 9999, month: 12 });
    expect(canShiftCalendarMonth({ year: 0, month: 1 }, -1)).toBe(false);
    expect(canShiftCalendarMonth({ year: 0, month: 1 }, 1)).toBe(true);
    expect(canShiftCalendarMonth({ year: 9999, month: 12 }, 1)).toBe(false);
    for (const month of [{ year: 0, month: 1 }, { year: 9999, month: 12 }]) {
      const days = calendarDays(month, null, null);
      expect(days.length).toBeLessThan(42);
      expect(new Set(days.map(day => day.date)).size).toBe(days.length);
      expect(days.every(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && parseScheduleDate(day.date))).toBe(true);
      expect(days.filter(day => day.inMonth)).toHaveLength(31);
    }
  });

  it('marks both selected dates and lays out leap-day cells in Sunday-first UTC weeks', () => {
    const days = calendarDays({ year: 2024, month: 2 }, '2024-02-01', '2024-02-29');
    expect(days).toHaveLength(42);
    expect(days.find(day => day.date === '2024-02-01')).toMatchObject({ inMonth: true, cutoff: true, publication: false });
    expect(days.find(day => day.date === '2024-02-29')).toMatchObject({ day: 29, inMonth: true, publication: true });
    expect(days[0]).toMatchObject({ date: '2024-01-28', inMonth: false });
    expect(days[0]!.year).toBe(2024);
  });

  it('renders 42 aligned boundary slots and disables navigation beyond supported years', async () => {
    const january = await renderCalendar('0000-01-01');
    const januaryCells = [...january.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(match => match[1]!);
    expect(januaryCells).toHaveLength(42);
    expect(januaryCells.slice(0, 6).every(cell => !cell.includes('<time'))).toBe(true);
    expect(januaryCells[6]).toContain('datetime="0000-01-01"');
    expect(january).toMatch(/<button[^>]*disabled[^>]*>Previous month<\/button>/);

    const december = await renderCalendar('9999-12-01');
    const decemberCells = [...december.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(match => match[1]!);
    expect(decemberCells).toHaveLength(42);
    const lastDateCell = decemberCells.findIndex(cell => cell.includes('datetime="9999-12-31"'));
    expect(lastDateCell).toBeGreaterThanOrEqual(0);
    expect(decemberCells.slice(lastDateCell + 1).every(cell => !cell.includes('<time'))).toBe(true);
    expect(december).toMatch(/<button[^>]*disabled[^>]*>Next month<\/button>/);
  });

  it('compiles the calendar and the metadata screen that mounts it', () => {
    for (const file of ['src/components/admin/ScheduleCalendar.vue', 'src/components/admin/EditionMetadata.vue']) {
      const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file });
      expect(errors).toEqual([]);
      expect(descriptor.template).not.toBeNull();
      expect(compileTemplate({ source: descriptor.template!.content, filename: file, id: 'schedule-calendar' }).errors).toEqual([]);
    }
    const calendar = readFileSync('src/components/admin/ScheduleCalendar.vue', 'utf8');
    expect(calendar).toContain('Previous month');
    expect(calendar).toContain('scope="col"');
    expect(calendar).toContain('Selected date legend');

  });
});
