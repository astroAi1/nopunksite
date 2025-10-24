import fs from 'node:fs/promises';
import path from 'node:path';

const PUBLIC = path.resolve('./public');
const TOTAL = 10000;

const quickText = new Array(TOTAL).fill('');
const typeMap = Object.create(null);
const pairMap = Object.create(null);

function add(map, key, idx){
  (map[key] ||= []).push(idx);
}

for (let i=0; i<TOTAL; i++){
  const p = path.join(PUBLIC, `${i}.json`);
  try{
    const raw = await fs.readFile(p, 'utf8');
    const meta = JSON.parse(raw);
    let text = '';

    if (meta?.name) text += ' ' + String(meta.name);

    if (Array.isArray(meta?.attributes)){
      for (const a of meta.attributes){
        const t = String(a.trait_type ?? a.type ?? '');
        const v = String(a.value ?? '');
        if (t) {
          add(typeMap, t, i);
          add(pairMap, `${t}|${v}`, i);
          text += ' ' + t + ' ' + v;
        }
      }
    }
    quickText[i] = text.toLowerCase();
  }catch(e){
    // missing file ok, leave quickText[i] empty
  }
}

const out = { quickText, typeMap, pairMap };
const outPath = path.join(PUBLIC, 'traits_index.json');
await fs.writeFile(outPath, JSON.stringify(out));
console.log('Wrote', outPath);
