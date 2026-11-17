import { describe, it, expect } from 'vitest';
import { parseYaml, stringifyYamlPreservingSource } from './yaml-io';
import { setField, toFormState, toInstance } from './model';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generalBinding } from './general';
import { validateGeneralMessage } from '../../../worker/lib/general-messages';
const bridge = (v:unknown) => JSON.parse(JSON.stringify(v));
function edit(source:string) {
 const state = toFormState('GeneralCustom', bridge(parseYaml(source))).state;
 return stringifyYamlPreservingSource(toInstance(setField(state,'contents',{en:'Revised'})),source);
}
describe('breaker: one contents edit changes only its scalar bytes',()=>{
 const cases = [
  ['comment', '# keep this comment\ntype: custom\ncontents:\n  en: Original\n'],
  ['quotes', "type: custom\ntitle: 'Keep quotes'\ncontents:\n  en: Original\n"],
  ['CRLF', 'type: custom\r\ncontents:\r\n  en: Original\r\n'],
  ['no final newline', 'type: custom\ncontents:\n  en: Original'],
  ['document marker', '---\ntype: custom\ncontents:\n  en: Original\n'],
  ['NBSP/unicode', 'type: custom\ntitle: "Café 漢字 😀"\ncontents:\n  en: Original\n'],
  ['key order', 'title: Keep\ncontents:\n  en: Original\ntype: custom\n'],
 ] as const;
 it.each(cases)('%s',(_,source)=>{
  const saved=edit(source);
  expect(bridge(parseYaml(saved))).toEqual({...bridge(parseYaml(source)),contents:{en:'Revised'}});
  expect(saved).toBe(source.replace('Original','Revised'));
 });
 it('legacy telephone zero is real, independent recursive scan of all YAML',()=>{
  const root=process.env.OB_DATA_ROOT!;
  const files = readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.yaml'));
  const paths=files.map(e=>join(e.parentPath,e.name));
  expect(paths.filter(p=>p.includes('/telephone_service/'))).toHaveLength(0);
  const legacy=paths.filter(p=>/^type:\s*['"]?telephone_service['"]?\s*$/m.test(readFileSync(p,'utf8')));
  expect(legacy).toHaveLength(0);
 });
});

describe('breaker: real corpus single-field edits',()=>{
 it.each(['sanc','telephone_service_2','custom','mid'])('%s retains every byte except one text scalar',type=>{
  const root=join(process.env.OB_DATA_ROOT!,'ob-issues');
  const paths=readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.yaml')&&e.parentPath.endsWith('/'+type)).map(e=>join(e.parentPath,e.name));
  const path=paths.sort((a,b)=>readFileSync(a).length-readFileSync(b).length)[0]!;
  const source=readFileSync(path,'utf8');
  const value=bridge(parseYaml(source));
  const field=type==='custom'?'title':'contents';
  const next=structuredClone(value[field]);
  let oldText:string|undefined;
  function mutate(node:any):boolean {
   if(!node||typeof node!=='object')return false;
   for(const [key,v] of Object.entries(node)) {
    if((key==='text'||key==='en')&&typeof v==='string'&&v.length>3&&!v.includes('\n')&&source.includes(v.slice(0,12))) { oldText=v.slice(0,12); node[key]=v.replace(oldText,'BREAKER_TEXT'); return true; }
    if(mutate(v))return true;
   }
   return false;
  }
  if(type==='custom') { oldText="''"; next.en='BREAKER_TEXT'; }
  else expect(mutate(next)).toBe(true);
  const state=toFormState(generalBinding(type).className,value).state;
  const changed=toInstance(setField(state,field,next));
  expect(changed).toEqual({...value,[field]:next});
  expect(()=>validateGeneralMessage(type,changed)).not.toThrow();
  const saved=stringifyYamlPreservingSource(changed,source);
  expect(bridge(parseYaml(saved))).toEqual(changed);
  const expected=source.replace(oldText!,type==='custom'?"'BREAKER_TEXT'":'BREAKER_TEXT');
  expect(expected).not.toBe(source);
  expect(saved,path).toBe(expected);
 });
});
