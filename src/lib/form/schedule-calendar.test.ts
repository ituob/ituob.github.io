import { compileTemplate, parse } from '@vue/compiler-sfc';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarDays, calendarMonthTitle, initialCalendarMonth, parseScheduleDate, scheduleDateLabel, shiftCalendarMonth } from './schedule-calendar';
import { YamlTimestamp } from './yaml-io';

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

  it('marks both selected dates and lays out leap-day cells in Sunday-first UTC weeks', () => {
    const days = calendarDays({ year: 2024, month: 2 }, '2024-02-01', '2024-02-29');
    expect(days).toHaveLength(42);
    expect(days.find(day => day.date === '2024-02-01')).toMatchObject({ inMonth: true, cutoff: true, publication: false });
    expect(days.find(day => day.date === '2024-02-29')).toMatchObject({ day: 29, inMonth: true, publication: true });
    expect(days[0]).toMatchObject({ date: '2024-01-28', inMonth: false });
    expect(days[0]!.year).toBe(2024);
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
