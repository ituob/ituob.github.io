<script setup lang="ts">
import { ref } from 'vue';
import { description } from '../../lib/form/description';
import { initialValue } from '../../lib/admin-client';
import { appendItem, clearField, removeItem, setField, type FormNode } from '../../lib/form/model';
import { YamlTimestamp } from '../../lib/form/yaml-io';
const props = defineProps<{ node: FormNode; path?: string; readonly?: boolean }>();
const emit = defineEmits<{ change: [node: FormNode]; invalid: [path: string, message: string] }>();
const jsonError = ref('');
function jsonInput(event: Event) {
  try {
    const value = JSON.parse((event.target as HTMLTextAreaElement).value);
    if (props.node.kind === 'leaf' && props.node.type === 'Hash' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Enter a JSON object');
    leaf(value); jsonError.value = ''; emit('invalid', props.path ?? '', '');
  } catch { jsonError.value = 'Enter a valid JSON object for this field.'; emit('invalid', props.path ?? '', jsonError.value); }
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
          <SchemaNode :node="field.node" :path="`${path || 'data'}.${field.attr.wire}`" :readonly="readonly" @change="replaceField(field.attr.name, $event)" @invalid="(path, message) => emit('invalid', path, message)" />
          <button type="button" @click="emit('change', clearField(node, field.attr.name)); emit('invalid', `${path || 'data'}.${field.attr.wire}`, '')">Remove {{ field.attr.wire }}</button>
        </template>
      </template>
    </div>
    <p v-if="Object.keys(node.extras).length">Additional stored fields are preserved: {{ Object.keys(node.extras).join(', ') }}.</p>
  </fieldset>
  <fieldset v-else-if="node.kind === 'list'" :disabled="readonly">
    <legend>{{ path }} ({{ node.items.length }} items)</legend>
    <div v-for="(item, index) in node.items" :key="index">
      <SchemaNode :node="item" :path="`${path}[${index}]`" :readonly="readonly" @change="replaceItem(index, $event)" @invalid="(path, message) => emit('invalid', path, message)" />
      <button type="button" @click="emit('change', removeItem(node, index)); emit('invalid', path || 'data', '')">Remove item {{ index + 1 }}</button>
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
    <template v-else-if="node.value !== null && typeof node.value === 'object' && !(node.value instanceof YamlTimestamp)">
      <textarea :value="JSON.stringify(node.value, null, 2)" :disabled="readonly" rows="5" @input="jsonInput" /><small>This field stores an opaque object. Edit this field as JSON.</small><p v-if="jsonError" role="alert">{{ jsonError }}</p>
    </template>
    <textarea v-else :value="node.value instanceof YamlTimestamp ? node.value.text : String(node.value ?? '')" :disabled="readonly" rows="3" @input="input" />
  </label>
</template>
