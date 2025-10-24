// build-traits-index.mjs
// Build a fast traits index for the site.
// Usage (from project root):
//   node build-traits-index.mjs --dir ./public --total 10000 \
//        --out ./public/traits_index.json --values ./trait_values_by_type.json

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir') out.dir = args[++i];
    else if (a === '--total') out.total = parseInt(args[++i], 10);
    else if (a === '--out') out.out = args[++i];
    else if (a === '--values') out.valuesOut = args[++i];
    else if (a === '--concurrency') out.conc = parseInt(args[++i], 10);
  }
  return {
    dir: out.dir ?? './public',
    total: Number.isFinite(out.total) ? out.total : 10000,
    out: out.out ?? './public/traits_index.json',
    valuesOut: out.valuesOut ?? './trait_values_by_type.json',
    conc: Number.isFinite(out.conc) ? Math.max(8, out.conc) : 128,
  };
}

function normStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

async function readJsonSafe(file) {
  try {
    const buf = await fs.readFile(file);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  });
}

async function main() {
  const cfg = parseArgs();

  // Resolve to absolute paths for safety
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const baseDir = path.resolve(__dirname, cfg.dir);
  const outPath = path.resolve(__dirname, cfg.out);
  const valuesPath = path.resolve(__dirname, cfg.valuesOut);

  console.log('Building traits index with config:');
  console.log({ baseDir, total: cfg.total, outPath, valuesPath, concurrency: cfg.conc });

  // Data structures expected by index.html
  const quickText = new Array(cfg.total).fill('');
  const typeMap = Object.create(null);       // TraitType -> [localIndex,...]
  const pairMap = Object.create(null);       // "TraitType|Value" -> [localIndex,...]
  const valuesPerType = Object.create(null); // TraitType -> Set(values)

  const batches = [];
  for (let i = 0; i < cfg.total; i += cfg.conc) {
    const range = { start: i, end: Math.min(cfg.total, i + cfg.conc) };
    batches.push(range);
  }

  let processed = 0;
  for (const { start, end } of batches) {
    const jobs = [];
    for (let j = start; j < end; j++) {
      const file = path.join(baseDir, `${j}.json`);
      jobs.push(readJsonSafe(file).then(meta => ({ idx: j, meta })));
    }
    const results = await Promise.all(jobs);

    for (const { idx, meta } of results) {
      let text = '';
      if (meta) {
        if (meta.name) text += ' ' + String(meta.name);

        const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
        for (const a of attrs) {
          const t = normStr(a.trait_type || a.type); // support 'trait_type' or 'type'
          const v = normStr(a.value);
          if (!t) continue;

          // Build typeMap
          if (!typeMap[t]) typeMap[t] = [];
          typeMap[t].push(idx);

          // Build pairMap
          const key = `${t}|${v}`;
          if (!pairMap[key]) pairMap[key] = [];
          pairMap[key].push(idx);

          // For quick text search
          text += ` ${t} ${v}`;

          // For trait_values_by_type.json
          (valuesPerType[t] ||= new Set()).add(v);
        }
      }
      quickText[idx] = text.toLowerCase();
    }

    processed = end;
    if (processed % (cfg.conc * 2) === 0 || processed === cfg.total) {
      console.log(`Progress: ${processed}/${cfg.total}`);
    }
  }

  // Deduplicate/sort indices in maps
  for (const [t, arr] of Object.entries(typeMap)) {
    typeMap[t] = uniqueSorted(arr);
  }
  for (const [k, arr] of Object.entries(pairMap)) {
    pairMap[k] = uniqueSorted(arr);
  }

  // Write index
  const indexPayload = { quickText, typeMap, pairMap };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(indexPayload));

  // Write values map (used to populate dropdowns)
  const valuesPayload = {};
  for (const [t, set] of Object.entries(valuesPerType)) {
    valuesPayload[t] = uniqueSorted(Array.from(set));
  }
  await fs.writeFile(valuesPath, JSON.stringify(valuesPayload));

  const sizeKB = (await fs.stat(outPath)).size / 1024;
  console.log(`Wrote index → ${outPath} (${sizeKB.toFixed(1)} KB)`);
  console.log(`Wrote type→values → ${valuesPath}`);
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});