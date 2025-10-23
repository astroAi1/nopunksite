/**
 * Scan 0.json → 9999.json and build a map of { trait_type: [unique values...] }.
 * Outputs:
 *   - trait_values_by_type.json  // { "Eyes": ["Clown Eyes Green", ...], "Type": ["Female", "Male", ...], ... }
 *   - trait_values_by_type.js    // ES module exports for your frontend
 *   - trait_types.json           // ["Eyes","Hair","Mouth","Type",...]
 */
const fs = require('fs');
const path = require('path');

const DIR = '/Users/danriding/Desktop/nopunks-site';
const START_ID = 0;
const END_ID = 9999;

const OUT_JSON = path.join(DIR, 'trait_values_by_type.json');
const OUT_JS = path.join(DIR, 'trait_values_by_type.js');
const OUT_TYPES = path.join(DIR, 'trait_types.json');

(function main () {
  const byType = new Map(); // trait_type -> Set(values)

  for (let i = START_ID; i <= END_ID; i++) {
    const file = path.join(DIR, `${i}.json`);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      const attrs = Array.isArray(data.attributes) ? data.attributes : [];
      for (const a of attrs) {
        if (!a || typeof a !== 'object') continue;
        const t = a.trait_type != null ? String(a.trait_type).trim() : null;
        const v = a.value != null ? String(a.value).trim() : null;
        if (!t || !v) continue;

        if (!byType.has(t)) byType.set(t, new Set());
        byType.get(t).add(v);
      }
    } catch (e) {
      // Skip missing/invalid files and continue
    }
  }

  // Convert Map<string, Set> → sorted object with sorted arrays
  const entriesSorted = Array.from(byType.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trait, set]) => [trait, Array.from(set).sort((a, b) => a.localeCompare(b))]);

  const byTypeObject = Object.fromEntries(entriesSorted);
  const traitTypes = entriesSorted.map(([trait]) => trait);

  // Write JSON outputs
  fs.writeFileSync(OUT_JSON, JSON.stringify(byTypeObject, null, 2));
  fs.writeFileSync(OUT_TYPES, JSON.stringify(traitTypes, null, 2));

  // Write JS module for easy import on the site
  fs.writeFileSync(
    OUT_JS,
    `// Auto-generated: ${new Date().toISOString()}
export const TRAIT_VALUES_BY_TYPE = ${JSON.stringify(byTypeObject, null, 2)};
export const TRAIT_TYPES = ${JSON.stringify(traitTypes, null, 2)};
`
  );

  const totalValues = entriesSorted.reduce((acc, [, values]) => acc + values.length, 0);
  console.log(
    `Wrote:
- ${OUT_JSON}
- ${OUT_JS}
- ${OUT_TYPES}

Trait types: ${traitTypes.length}
Unique values (sum across types): ${totalValues}`
  );
})();