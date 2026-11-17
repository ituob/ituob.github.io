<script setup lang="ts">
import { computed, ref } from 'vue';
import TranslationAssist from './TranslationAssist.vue';
import { description } from '../../lib/form/description';
import { initialValue } from '../../lib/admin-client';
import { appendItem, clearField, moveItem, removeItem, setField, type FormNode } from '../../lib/form/model';
import { PROSE_LANGUAGES, isLanguageProse, setProseLanguage } from '../../lib/form/general';
import { YamlTimestamp } from '../../lib/form/yaml-io';
import { applyInvalid, type InvalidInput } from '../../lib/form/invalid-input';
const props = defineProps<{ node: FormNode; path?: string; readonly?: boolean; translation?: boolean; opaqueReadonly?: boolean; prose?: boolean }>();
const emit = defineEmits<{ change: [node: FormNode]; invalid: [path: string, message: string] }>();
const jsonError = ref('');
// Items are keyed by index and an item's invalid text lives in its own component. Reordering while any field of
// the list holds invalid input would leave that text and its message on the wrong item (and the parent would stop
// blocking Save), so moves wait until every pending field is valid. Removing is the explicit way to discard an
// item with invalid text: the items are rebuilt from the model (new key epoch) and the pending input is dropped.
const pending = ref<InvalidInput>({}), epoch = ref(0);
function removeAt(node: Extract<FormNode, { kind: 'list' }>, index: number) {
  epoch.value++; pending.value = {};
  emit('change', removeItem(node, index)); emit('invalid', props.path || 'data', '');
}
const hasPending = computed(() => Object.keys(pending.value).length > 0);
function itemInvalid(path: string, message: string) { applyInvalid(pending.value, path, message); emit('invalid', path, message); }
const englishSource = computed(() => {
  if (props.node.kind !== 'object' || props.node.className !== 'MultilingualString') return '';
  const en = props.node.fields.find(f => f.attr.wire === 'en')?.node;
  return en?.kind === 'leaf' && typeof en.value === 'string' ? en.value : '';
});
function jsonInput(event: Event) {
  try {
    const value = JSON.parse((event.target as HTMLTextAreaElement).value);
    if (props.node.kind === 'leaf' && props.node.type === 'Hash' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Use a JSON object.');
    if (props.node.kind === 'leaf' && props.node.type === 'HashOrList' && (!value || typeof value !== 'object' || (Array.isArray(value) && !value.every(item => item && typeof item === 'object' && !Array.isArray(item))))) throw new Error('Use a JSON object or a list of objects.');
    leaf(value); jsonError.value = ''; emit('invalid', props.path ?? '', '');
  } catch (error) { jsonError.value = error instanceof Error && error.message.startsWith('Use ') ? error.message : 'Enter valid JSON for this field.'; emit('invalid', props.path ?? '', jsonError.value); }
}
function languageInput(language: string, event: Event) {
  if (props.node.kind === 'leaf') leaf(setProseLanguage(props.node.value, language, (event.target as HTMLTextAreaElement).value));
}
function languageValue(language: string): unknown {
  return props.node.kind === 'leaf' && isLanguageProse(props.node.value) ? props.node.value[language] : undefined;
}
function leaf(value: unknown) { if (props.node.kind === 'leaf') emit('change', { ...props.node, value }); }
function input(event: Event) {
  if (props.node.kind !== 'leaf') return;
  const el = event.target as HTMLInputElement;
  if (props.node.type === 'Integer' || props.node.type === 'Float') leaf(el.value === '' ? '' : Number(el.value));
  else if (props.node.type === 'Boolean') leaf(el.checked);
  else if (props.node.type === 'Date' || props.node.type === 'Time') leaf(new YamlTimestamp(el.value));
  else leaf(el.value);
}
function replaceField(name: string, child: FormNode) {
  if (props.node.kind === 'object') emit('change', { ...props.node, fields: props.node.fields.map(f => f.attr.name === name ? { ...f, node: child } : f) });
}
function replaceItem(index: number, child: FormNode) {
  if (props.node.kind === 'list') emit('change', { ...props.node, items: props.node.items.map((n, i) => i === index ? child : n) });
}
</script>
<template>
  <fieldset v-if="node.kind === 'object'" :disabled="readonly" class="schema-object">
    <legend>{{ node.className }}</legend>
    <div v-for="field in node.fields" :key="field.attr.wire" class="schema-field">
      <strong>{{ field.attr.wire }}{{ field.attr.required ? ' (required)' : '' }}</strong>
      <span v-if="field.attr.wire === '_class'">: {{ node.className }}</span>
      <template v-else>
        <button v-if="field.node === null" type="button" @click="emit('change', setField(node, field.attr.name, initialValue(field.attr)))">Add {{ field.attr.wire }}</button>
        <template v-else>
          <SchemaNode :node="field.node" :path="`${path || 'data'}.${field.attr.wire}`" :readonly="readonly" :translation="translation" :opaque-readonly="opaqueReadonly" :prose="prose" @change="replaceField(field.attr.name, $event)" @invalid="(path, message) => emit('invalid', path, message)" />
          <button type="button" @click="emit('change', clearField(node, field.attr.name)); emit('invalid', `${path || 'data'}.${field.attr.wire}`, '')">Remove {{ field.attr.wire }}</button>
        </template>
      </template>
      <TranslationAssist v-if="translation && !readonly && englishSource && ['fr','es','ar','ru','zh'].includes(field.attr.wire)"
        :source="englishSource" from="en" :to="field.attr.wire"
        @apply="emit('change', setField(node, field.attr.name, { kind: 'leaf', type: 'String', value: $event }))" />
    </div>
    <p v-if="Object.keys(node.extras).length">Additional stored fields are preserved: {{ Object.keys(node.extras).join(', ') }}.</p>
  </fieldset>
  <fieldset v-else-if="node.kind === 'list'" :disabled="readonly">
    <legend>{{ path }} ({{ node.items.length }} items)</legend>
    <div v-for="(item, index) in node.items" :key="`${epoch}:${index}`">
      <SchemaNode :node="item" :path="`${path}[${index}]`" :readonly="readonly" :translation="translation" :opaque-readonly="opaqueReadonly" :prose="prose" @change="replaceItem(index, $event)" @invalid="itemInvalid" />
      <button type="button" :disabled="index === 0 || hasPending" @click="emit('change', moveItem(node, index, -1)); emit('invalid', path || 'data', '')">Move item {{ index + 1 }} up</button>
      <button type="button" :disabled="index === node.items.length - 1 || hasPending" @click="emit('change', moveItem(node, index, 1)); emit('invalid', path || 'data', '')">Move item {{ index + 1 }} down</button>
      <button type="button" @click="removeAt(node, index)">Remove item {{ index + 1 }}</button>
    </div>
    <button type="button" @click="emit('change', appendItem(node, initialValue({ name: 'item', wire: 'item', type: node.itemType, kind: node.itemKind, collection: false, required: false })))">Add item</button>
  </fieldset>
  <label v-else class="schema-value">
    <span class="field-path">{{ path }}</span>
    <select v-if="description.enums[node.type]" :value="node.value" :disabled="readonly" @change="input">
      <option v-for="option in description.enums[node.type]" :key="option" :value="option">{{ option }}</option>
    </select>
    <input v-else-if="node.type === 'Boolean'" type="checkbox" :checked="node.value === true" :disabled="readonly" @change="input" />
    <input v-else-if="['Integer', 'Float'].includes(node.type)" type="number" :step="node.type === 'Integer' ? 1 : 'any'" :value="node.value as number" :disabled="readonly" @input="input" />
    <template v-else-if="prose && node.type === 'HashOrText' && (typeof node.value === 'string' || isLanguageProse(node.value))">
      <template v-if="typeof node.value === 'string'">
        <textarea :value="node.value" :disabled="readonly" rows="5" @input="input" />
        <button type="button" :disabled="readonly" @click="leaf({en: node.value})">Use language fields (current text becomes English)</button>
      </template>
      <template v-else>
        <span v-for="language in PROSE_LANGUAGES" :key="language" class="prose-language">
          <span>{{ language }}</span>
          <textarea v-if="languageValue(language) === undefined || typeof languageValue(language) === 'string'"
            :aria-label="`${path} ${language}`" :lang="language" :dir="language === 'ar' ? 'rtl' : 'auto'"
            :value="String(languageValue(language) ?? '')" :disabled="readonly" rows="5" @input="languageInput(language, $event)" />
          <span v-else>Stored rich text is preserved read-only.</span>
        </span>
      </template>
    </template>
    <template v-else-if="node.value !== null && typeof node.value === 'object' && !(node.value instanceof YamlTimestamp)">
      <template v-if="opaqueReadonly"><p>Stored content is preserved. This field is read-only.</p><pre>{{ JSON.stringify(node.value, null, 2) }}</pre></template>
      <textarea v-else :value="JSON.stringify(node.value, null, 2)" :disabled="readonly" rows="5" @input="jsonInput" /><small>This field stores opaque structured data. Edit this field as JSON.</small><p v-if="jsonError" role="alert">{{ jsonError }}</p>
    </template>
    <textarea v-else :value="node.value instanceof YamlTimestamp ? node.value.text : String(node.value ?? '')" :disabled="readonly" rows="3" @input="input" />
  </label>
</template>
