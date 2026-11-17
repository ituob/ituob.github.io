import { YamlTimestamp } from './yaml-io';

export interface YearMonth { year: number; month: number }
export interface CalendarDay extends YearMonth {
  day: number;
  date: string;
  inMonth: boolean;
  cutoff: boolean;
  publication: boolean;
}

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** Read only real YYYY-MM-DD values (including YAML date scalars), never guess text dates. */
export function parseScheduleDate(value: unknown): { year: number; month: number; day: number; date: string } | null {
  const text = value instanceof YamlTimestamp ? value.text : value;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const year = Number(text.slice(0, 4)), month = Number(text.slice(5, 7)), day = Number(text.slice(8, 10));
  const check = utcDate(year, month - 1, day);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day, date: text };
}

export function initialCalendarMonth(cutoff: unknown, publication: unknown, now = new Date()): YearMonth {
  const selected = parseScheduleDate(cutoff) ?? parseScheduleDate(publication);
  return selected ? { year: selected.year, month: selected.month } : { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export function scheduleDateLabel(value: unknown): string {
  return parseScheduleDate(value)?.date ?? 'Not set';
}

export function shiftCalendarMonth(value: YearMonth, offset: number): YearMonth {
  const date = utcDate(value.year, value.month - 1 + offset, 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function calendarMonthTitle(value: YearMonth): string {
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(utcDate(value.year, value.month - 1, 1));
}

export function calendarDays(value: YearMonth, cutoff: unknown, publication: unknown): CalendarDay[] {
  const first = utcDate(value.year, value.month - 1, 1);
  const gridStart = utcDate(value.year, value.month - 1, 1 - first.getUTCDay());
  const cutoffDate = parseScheduleDate(cutoff)?.date;
  const publicationDate = parseScheduleDate(publication)?.date;
  return Array.from({ length: 42 }, (_, index) => {
    const date = utcDate(gridStart.getUTCFullYear(), gridStart.getUTCMonth(), gridStart.getUTCDate() + index);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { year, month, day, date: key, inMonth: month === value.month && year === value.year,
      cutoff: key === cutoffDate, publication: key === publicationDate };
  });
}
