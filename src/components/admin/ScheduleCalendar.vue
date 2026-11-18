<script setup lang="ts">
import '../../styles/admin-forms.css';
import { computed, ref, watch } from 'vue';
import { canShiftCalendarMonth, calendarDays, calendarMonthTitle, initialCalendarMonth, scheduleDateLabel, shiftCalendarMonth } from '../../lib/form/schedule-calendar';

const props = defineProps<{ cutoffDate: unknown; publicationDate: unknown }>();
const month = ref(initialCalendarMonth(props.cutoffDate, props.publicationDate));
watch(() => [props.cutoffDate, props.publicationDate], () => {
  month.value = initialCalendarMonth(props.cutoffDate, props.publicationDate);
});
const title = computed(() => calendarMonthTitle(month.value));
const days = computed(() => calendarDays(month.value, props.cutoffDate, props.publicationDate));
const grid = computed(() => {
  const leading = days.value.length ? new Date(`${days.value[0]!.date}T00:00:00Z`).getUTCDay() : 0;
  return Array.from({ length: 42 }, (_, index) => days.value[index - leading] ?? null);
});
const cutoffLabel = computed(() => scheduleDateLabel(props.cutoffDate));
const publicationLabel = computed(() => scheduleDateLabel(props.publicationDate));
const weekdays = [
  { short: 'Sun', full: 'Sunday' }, { short: 'Mon', full: 'Monday' }, { short: 'Tue', full: 'Tuesday' },
  { short: 'Wed', full: 'Wednesday' }, { short: 'Thu', full: 'Thursday' }, { short: 'Fri', full: 'Friday' },
  { short: 'Sat', full: 'Saturday' },
];
function move(offset: number) { month.value = shiftCalendarMonth(month.value, offset); }
</script>

<template>
  <section class="admin-form schedule-calendar" aria-label="Selected issue dates calendar">
    <h4>Selected dates</h4>
    <nav aria-label="Calendar month">
      <button class="admin-button" type="button" @click="move(-1)" :disabled="!canShiftCalendarMonth(month, -1)" :aria-label="`Previous month before ${title}`">Previous month</button>
      <strong aria-live="polite">{{ title }}</strong>
      <button class="admin-button" type="button" @click="move(1)" :disabled="!canShiftCalendarMonth(month, 1)" :aria-label="`Next month after ${title}`">Next month</button>
    </nav>
    <div class="admin-table-scroll" tabindex="0" role="region" aria-label="Selected dates calendar"><table class="admin-table">
      <caption>{{ title }}</caption>
      <thead><tr><th v-for="weekday in weekdays" :key="weekday.short" scope="col"><abbr :title="weekday.full">{{ weekday.short }}</abbr></th></tr></thead>
      <tbody>
        <tr v-for="week in 6" :key="week">
          <td v-for="(day, index) in grid.slice((week - 1) * 7, week * 7)" :key="day?.date ?? `blank-${week}-${index}`" :class="{ outside: day && !day.inMonth, cutoff: day?.cutoff, publication: day?.publication }">
            <template v-if="day">
            <time :datetime="day.date" :aria-label="`${day.date}${day.cutoff ? ', cutoff date' : ''}${day.publication ? ', publication date' : ''}`">{{ day.day }}</time>
            <span v-if="day.cutoff">Cutoff</span><span v-if="day.publication">Publication</span>
            </template>
          </td>
        </tr>
      </tbody>
    </table></div>
    <ul aria-label="Selected date legend">
      <li><span class="swatch cutoff" aria-hidden="true"></span>Cutoff date: <time v-if="cutoffLabel !== 'Not set'" :datetime="cutoffLabel">{{ cutoffLabel }}</time><span v-else>Not set</span></li>
      <li><span class="swatch publication" aria-hidden="true"></span>Publication date: <time v-if="publicationLabel !== 'Not set'" :datetime="publicationLabel">{{ publicationLabel }}</time><span v-else>Not set</span></li>
    </ul>
  </section>
</template>

<style scoped>
.schedule-calendar { max-width: 36rem; margin: 1rem 0; }
nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; }
.schedule-calendar .admin-table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
.schedule-calendar .admin-table :is(th, td) { border: 1px solid var(--border); padding: .35rem; text-align: center; vertical-align: top; }
.schedule-calendar td { height: 3.2rem; }
td span { display: block; font-size: .75rem; }
.outside { color: var(--fg-3); background: var(--bg-3); }
.cutoff { background: var(--color-amber-bg); }
.publication { background: var(--accent-soft); }
td.cutoff.publication { background: var(--color-violet-bg); }
ul { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; padding-left: 1.25rem; }
.swatch { display: inline-block; width: .8rem; height: .8rem; border: 1px solid var(--border-2); margin-right: .3rem; vertical-align: -.1rem; }
.swatch.cutoff { background: var(--color-amber-bg); }
.swatch.publication { background: var(--accent-soft); }
</style>
