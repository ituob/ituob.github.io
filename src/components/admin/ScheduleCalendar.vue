<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { calendarDays, calendarMonthTitle, initialCalendarMonth, scheduleDateLabel, shiftCalendarMonth } from '../../lib/form/schedule-calendar';

const props = defineProps<{ cutoffDate: unknown; publicationDate: unknown }>();
const month = ref(initialCalendarMonth(props.cutoffDate, props.publicationDate));
watch(() => [props.cutoffDate, props.publicationDate], () => {
  month.value = initialCalendarMonth(props.cutoffDate, props.publicationDate);
});
const title = computed(() => calendarMonthTitle(month.value));
const days = computed(() => calendarDays(month.value, props.cutoffDate, props.publicationDate));
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
  <section class="schedule-calendar" aria-label="Selected issue dates calendar">
    <h4>Selected dates</h4>
    <nav aria-label="Calendar month">
      <button type="button" @click="move(-1)" :aria-label="`Previous month before ${title}`">Previous month</button>
      <strong aria-live="polite">{{ title }}</strong>
      <button type="button" @click="move(1)" :aria-label="`Next month after ${title}`">Next month</button>
    </nav>
    <table>
      <caption>{{ title }}</caption>
      <thead><tr><th v-for="weekday in weekdays" :key="weekday.short" scope="col"><abbr :title="weekday.full">{{ weekday.short }}</abbr></th></tr></thead>
      <tbody>
        <tr v-for="week in 6" :key="week">
          <td v-for="day in days.slice((week - 1) * 7, week * 7)" :key="day.date" :class="{ outside: !day.inMonth, cutoff: day.cutoff, publication: day.publication }">
            <time :datetime="day.date" :aria-label="`${day.date}${day.cutoff ? ', cutoff date' : ''}${day.publication ? ', publication date' : ''}`">{{ day.day }}</time>
            <span v-if="day.cutoff">Cutoff</span><span v-if="day.publication">Publication</span>
          </td>
        </tr>
      </tbody>
    </table>
    <ul aria-label="Selected date legend">
      <li><span class="swatch cutoff" aria-hidden="true"></span>Cutoff date: <time v-if="cutoffLabel !== 'Not set'" :datetime="cutoffLabel">{{ cutoffLabel }}</time><span v-else>Not set</span></li>
      <li><span class="swatch publication" aria-hidden="true"></span>Publication date: <time v-if="publicationLabel !== 'Not set'" :datetime="publicationLabel">{{ publicationLabel }}</time><span v-else>Not set</span></li>
    </ul>
  </section>
</template>

<style scoped>
.schedule-calendar { max-width: 36rem; margin: 1rem 0; }
nav { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
th, td { border: 1px solid #9baaba; padding: .35rem; text-align: center; vertical-align: top; }
td { height: 3.2rem; }
td span { display: block; font-size: .75rem; }
.outside { color: #697786; background: #f4f6f8; }
.cutoff { background: #fff2cc; }
.publication { background: #dcecfb; }
td.cutoff.publication { background: #e9e0f5; }
ul { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; padding-left: 1.25rem; }
.swatch { display: inline-block; width: .8rem; height: .8rem; border: 1px solid #667; margin-right: .3rem; vertical-align: -.1rem; }
.swatch.cutoff { background: #fff2cc; }
.swatch.publication { background: #dcecfb; }
</style>
