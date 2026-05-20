(() => {
  const PUNK_SIZE = 24;
  const IMPROVENANCE_PIXEL = '#111111';
  const NOPUNKS_BG = '#000000';
  const NOPUNKS_BLACK = { r: 4, g: 4, b: 4, a: 255 };
  const MALE_CATEGORIES = ['hair', 'eyes', 'mouth', 'face', 'beard', 'neck', 'ears'];
  const FEMALE_CATEGORIES = ['hair', 'eyes', 'mouth', 'face', 'lips', 'neck', 'ears'];
  const CRYPTOPUNKS_RENDER_ORDER = [
    'Black Lipstick', 'Buck Teeth', 'Frown', 'Hot Lipstick', 'Purple Lipstick', 'Smile',
    'Mole', 'Rosy Cheeks', 'Gold Chain', 'Spots', 'Choker', 'Silver Chain',
    'Big Beard', 'Chinstrap', 'Front Beard', 'Front Beard Dark', 'Goat', 'Handlebars',
    'Luxurious Beard', 'Mustache', 'Muttonchops', 'Normal Beard', 'Normal Beard Black',
    'Shadow Beard', 'Earring', 'Bandana', 'Beanie', 'Blonde Bob', 'Blonde Short',
    'Cap', 'Cap Forward', 'Clown Hair Green', 'Cowboy Hat', 'Crazy Hair', 'Dark Hair',
    'Do-rag', 'Fedora', 'Frumpy Hair', 'Half Shaved', 'Headband', 'Hoodie',
    'Knitted Cap', 'Messy Hair', 'Mohawk', 'Mohawk Dark', 'Mohawk Thin', 'Orange Side',
    'Peak Spike', 'Pigtails', 'Pilot Helmet', 'Pink With Hat', 'Police Cap',
    'Purple Hair', 'Red Mohawk', 'Shaved Head', 'Straight Hair', 'Straight Hair Blonde',
    'Straight Hair Dark', 'Stringy Hair', 'Tassle Hat', 'Tiara', 'Top Hat',
    'Vampire Hair', 'Wild Blonde', 'Wild Hair', 'Wild White Hair', 'Cigarette',
    'Medical Mask', 'Pipe', 'Vape', '3D Glasses', 'Big Shades', 'Blue Eye Shadow',
    'Classic Shades', 'Clown Eyes Blue', 'Clown Eyes Green', 'Eye Mask', 'Eye Patch',
    'Green Eye Shadow', 'Horned Rim Glasses', 'Nerd Glasses', 'Purple Eye Shadow',
    'Regular Shades', 'Small Shades', 'VR', 'Welding Goggles', 'Clown Nose',
  ];
  const CRYPTOPUNKS_RENDER_RANK = new Map(CRYPTOPUNKS_RENDER_ORDER.map((name, index) => [name, index]));
  const BASE_SKIN_PALETTE_INDICES = {
    'Male 1': [1, 2, 3, 4],
    'Female 1': [1, 2, 3, 4, 17],
    'Male 2': [5, 6, 7, 8],
    'Female 2': [5, 6, 7, 8, 18],
    'Male 3': [9, 10, 11, 12],
    'Female 3': [9, 10, 11, 12, 19],
    'Male 4': [13, 14, 15, 16],
    'Female 4': [13, 14, 15, 16, 19],
    Zombie: [20, 21, 22, 23],
    Ape: [24, 25, 26, 27],
    Alien: [28, 29, 30, 31],
  };
  const BASE_OUTLINE_PALETTE_INDICES = {
    Ape: [24, 26],
  };

  const el = {
    frame: document.getElementById('punk-frame'),
    title: document.getElementById('title'),
    status: document.getElementById('status-line'),
    pill: document.getElementById('result-pill'),
    evidence: document.getElementById('evidence'),
    links: document.getElementById('links'),
    randomize: document.getElementById('randomize-btn'),
    download: document.getElementById('download-btn'),
    seedInput: document.getElementById('seed-token'),
    seedButton: document.getElementById('seed-btn'),
    type: document.getElementById('select-type'),
    hair: document.getElementById('select-hair'),
    eyes: document.getElementById('select-eyes'),
    mouth: document.getElementById('select-mouth'),
    face: document.getElementById('select-face'),
    lipsbeard: document.getElementById('select-lipsbeard'),
    neck: document.getElementById('select-neck'),
    ears: document.getElementById('select-ears'),
  };

  const traitSelects = {
    hair: el.hair,
    eyes: el.eyes,
    mouth: el.mouth,
    face: el.face,
    neck: el.neck,
    ears: el.ears,
  };
  const allTraitSelects = [el.hair, el.eyes, el.mouth, el.face, el.lipsbeard, el.neck, el.ears];

  let traitsData = null;
  let comboMap = null;
  let cachedPalette = null;
  let currentState = null;
  let evidenceRun = 0;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function slugify(value) {
    return String(value).toLowerCase().replace(/_/g, ' ').trim().replace(/\s+/g, '-');
  }

  function unslug(value) {
    return String(value).toLowerCase().replace(/-/g, ' ').replace(/_/g, ' ').trim();
  }

  function normalizeTraitName(value) {
    return String(value).replace(/_/g, ' ').trim().toLowerCase();
  }

  function randomInt(max) {
    return Math.floor(Math.random() * max);
  }

  function decodePalette(paletteArr) {
    return paletteArr.map((hex) => {
      const sourceHex = {
        dedede80: 'dbdbdb80',
        cae7fe70: 'cae6ff70',
        '2c954199': '2c944199',
      }[hex] || hex;
      return {
        r: parseInt(sourceHex.slice(0, 2), 16),
        g: parseInt(sourceHex.slice(2, 4), 16),
        b: parseInt(sourceHex.slice(4, 6), 16),
        a: parseInt(sourceHex.slice(6, 8), 16),
      };
    });
  }

  function decodeLayer(hexStr, palette) {
    const hex = hexStr.replace(/^0x/i, '');
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }

    const pixels = new Array(PUNK_SIZE * PUNK_SIZE).fill(null);
    for (let i = 0; i < bytes.length; i += 3) {
      const bx = (bytes[i] & 0xf0) >> 4;
      const by = bytes[i] & 0x0f;
      const colorIdx = bytes[i + 1];
      const colorMask = (bytes[i + 2] & 0xf0) >> 4;
      const blackMask = bytes[i + 2] & 0x0f;

      for (let dx = 0; dx < 2; dx += 1) {
        for (let dy = 0; dy < 2; dy += 1) {
          const x = 2 * bx + dx;
          const y = 2 * by + dy;
          if (x >= PUNK_SIZE || y >= PUNK_SIZE) continue;
          const bit = 1 << (dx * 2 + dy);
          const idx = y * PUNK_SIZE + x;

          if (colorMask & bit) {
            pixels[idx] = palette[colorIdx];
          } else if (blackMask & bit) {
            pixels[idx] = { r: 0, g: 0, b: 0, a: 255 };
          }
        }
      }
    }
    return pixels;
  }

  function colorKey(px) {
    return `${px.r},${px.g},${px.b},${px.a}`;
  }

  function getSkinColorKeys(baseTypeName) {
    const indices = BASE_SKIN_PALETTE_INDICES[baseTypeName] || [];
    return new Set(indices.map((idx) => colorKey(cachedPalette[idx])));
  }

  function getBaseOutlineColorKeys(baseTypeName) {
    const indices = BASE_OUTLINE_PALETTE_INDICES[baseTypeName] || [];
    return new Set(indices.map((idx) => colorKey(cachedPalette[idx])));
  }

  function isBaseEyeAperturePixel(index, baseTypeName) {
    const x = index % PUNK_SIZE;
    const y = Math.floor(index / PUNK_SIZE);
    const apertureY = getBaseGender(baseTypeName) === 'f' ? [12, 13] : [11, 12];
    return apertureY.includes(y) && ((x >= 9 && x <= 10) || (x >= 14 && x <= 15));
  }

  function applyNoPunksColorTransform(pixels, baseTypeName, traitNames, sources = []) {
    const skinColorKeys = getSkinColorKeys(baseTypeName);
    const baseOutlineColorKeys = getBaseOutlineColorKeys(baseTypeName);
    return pixels.map((px, index) => {
      if (!px || px.a === 0) return { r: 0, g: 0, b: 0, a: 255 };
      if (px.r === 0 && px.g === 0 && px.b === 0 && px.a > 0) return { ...NOPUNKS_BLACK, a: px.a };
      if (sources[index] !== 'trait' && isBaseEyeAperturePixel(index, baseTypeName)) return px;
      if (sources[index] !== 'trait' && baseOutlineColorKeys.has(colorKey(px))) return { ...NOPUNKS_BLACK, a: px.a };
      if (skinColorKeys.has(colorKey(px)) && sources[index] !== 'trait') return { r: 0, g: 0, b: 0, a: px.a };
      return px;
    });
  }

  function alphaBlend(dst, src) {
    const sa = src.a / 255;
    const da = dst.a / 255;
    const outA = sa + da * (1 - sa);
    if (outA === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: Math.round((src.r * sa + dst.r * da * (1 - sa)) / outA),
      g: Math.round((src.g * sa + dst.g * da * (1 - sa)) / outA),
      b: Math.round((src.b * sa + dst.b * da * (1 - sa)) / outA),
      a: Math.round(outA * 255),
    };
  }

  function compositePixels(layers) {
    const result = new Array(PUNK_SIZE * PUNK_SIZE).fill(null);
    const sources = new Array(PUNK_SIZE * PUNK_SIZE).fill(null);
    for (const layer of layers) {
      for (let i = 0; i < layer.pixels.length; i += 1) {
        const src = layer.pixels[i];
        if (src === null || src.a === 0) continue;
        result[i] = result[i] === null || src.a === 255 ? src : alphaBlend(result[i], src);
        sources[i] = layer.source;
      }
    }
    return { pixels: result, sources };
  }

  function colorToCss(px) {
    if (px.r === 4 && px.g === 4 && px.b === 4 && px.a === 255) return '#040404';
    if (px.a === 255) return `rgb(${px.r},${px.g},${px.b})`;
    return `rgba(${px.r},${px.g},${px.b},${(px.a / 255).toFixed(2)})`;
  }

  function pixelsToSvg(pixels, { improvenancePixel = false } = {}) {
    const pathsByColor = new Map();
    for (let y = 0; y < PUNK_SIZE; y += 1) {
      let x = 0;
      while (x < PUNK_SIZE) {
        const px = pixels[y * PUNK_SIZE + x];
        if (!px || px.a <= 0) {
          x += 1;
          continue;
        }
        const color = colorToCss(px);
        let width = 1;
        while (x + width < PUNK_SIZE) {
          const next = pixels[y * PUNK_SIZE + x + width];
          if (!next || next.a <= 0 || colorToCss(next) !== color) break;
          width += 1;
        }
        const commands = pathsByColor.get(color) || [];
        commands.push(`M${x} ${y}h${width}v1H${x}z`);
        pathsByColor.set(color, commands);
        x += width;
      }
    }
    const shapes = [`<rect x="0" y="0" width="24" height="24" fill="${NOPUNKS_BG}"/>`];
    for (const [color, commands] of pathsByColor) {
      shapes.push(`<path fill="${color}" d="${commands.join('')}"/>`);
    }
    if (improvenancePixel) {
      shapes.push(`<rect x="23" y="23" width="1" height="1" fill="${IMPROVENANCE_PIXEL}"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges" style="shape-rendering:crispEdges;image-rendering:pixelated" role="img" aria-label="Generated No-Punk">${shapes.join('')}</svg>`;
  }

  function getTraitLayerId(traitName, gender) {
    const trait = traitsData.traits[traitName];
    if (!trait) return 0;
    return gender === 'f'
      ? (trait.femaleId || trait.maleId || 0)
      : (trait.maleId || trait.femaleId || 0);
  }

  function sortTraitsForBaseType(baseTypeName, traitNames) {
    const gender = getBaseGender(baseTypeName);
    return [...traitNames].sort((a, b) => {
      const rankA = CRYPTOPUNKS_RENDER_RANK.get(a) ?? 999;
      const rankB = CRYPTOPUNKS_RENDER_RANK.get(b) ?? 999;
      return rankA - rankB || getTraitLayerId(a, gender) - getTraitLayerId(b, gender);
    });
  }

  function renderNoPunk(baseTypeName, traitNames, opts = {}) {
    if (!cachedPalette) cachedPalette = decodePalette(traitsData.palette);
    const layers = [];
    const baseHex = traitsData.baseTypes[baseTypeName]?.hex;
    if (baseHex) layers.push({ pixels: decodeLayer(baseHex, cachedPalette), source: 'base' });

    const gender = getBaseGender(baseTypeName);
    const sortedTraits = sortTraitsForBaseType(baseTypeName, traitNames);
    for (const name of sortedTraits) {
      const trait = traitsData.traits[name];
      if (!trait) continue;
      const hex = gender === 'f' ? (trait.femaleHex || trait.maleHex) : (trait.maleHex || trait.femaleHex);
      if (hex) layers.push({ pixels: decodeLayer(hex, cachedPalette), source: 'trait' });
    }

    const composited = compositePixels(layers);
    return pixelsToSvg(applyNoPunksColorTransform(composited.pixels, baseTypeName, traitNames, composited.sources), opts);
  }

  function getBaseGender(baseTypeName) {
    return traitsData.baseTypes[baseTypeName]?.gender || 'm';
  }

  function getTraitsForGender(gender) {
    return traitsData.traitNames.filter((name) => {
      const trait = traitsData.traits[name];
      return gender === 'f' ? trait.femaleCount > 0 : trait.maleCount > 0;
    });
  }

  function getTraitsByCategory(gender) {
    const result = {};
    for (const name of getTraitsForGender(gender)) {
      const category = traitsData.traits[name]?.category || 'other';
      if (!result[category]) result[category] = [];
      result[category].push(name);
    }
    return result;
  }

  function makeComboKey(baseTypeName, traitNames) {
    const baseIdx = traitsData.baseTypeNames.indexOf(baseTypeName);
    const traitIdxs = traitNames
      .map((trait) => traitsData.traitNames.indexOf(trait))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b);
    return `${baseIdx}:${traitIdxs.join(',')}`;
  }

  function checkExists(baseTypeName, traitNames) {
    const key = makeComboKey(baseTypeName, traitNames);
    return Object.prototype.hasOwnProperty.call(comboMap, key) ? comboMap[key] : null;
  }

  function populateTypeSelector() {
    el.type.innerHTML = '';
    for (const name of traitsData.baseTypeNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      el.type.appendChild(opt);
    }
  }

  function fillSelect(selectEl, values) {
    const prev = selectEl.value;
    selectEl.innerHTML = '<option value="">None</option>';
    for (const name of [...values].sort()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      selectEl.appendChild(opt);
    }
    if (values.includes(prev)) selectEl.value = prev;
  }

  function populateTraitSelectors(gender) {
    const byCategory = getTraitsByCategory(gender);
    Object.entries(traitSelects).forEach(([category, selectEl]) => {
      fillSelect(selectEl, byCategory[category] || []);
    });
    fillSelect(el.lipsbeard, [...(byCategory.lips || []), ...(byCategory.beard || [])]);
  }

  function getCurrentTraits() {
    return allTraitSelects.map((selectEl) => selectEl.value).filter(Boolean);
  }

  function setSelectValues(base, traits) {
    el.type.value = base;
    populateTraitSelectors(getBaseGender(base));
    for (const selectEl of allTraitSelects) selectEl.value = '';

    for (const name of traits) {
      const category = traitsData.traits[name]?.category;
      if (category === 'lips' || category === 'beard') {
        el.lipsbeard.value = name;
      } else if (traitSelects[category]) {
        traitSelects[category].value = name;
      }
    }
  }

  function pickRandomTraitByCategory(byCategory, category) {
    const values = byCategory[category] || [];
    return values.length ? values[randomInt(values.length)] : null;
  }

  function randomPunk(maxAttempts = 150) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const base = traitsData.baseTypeNames[randomInt(traitsData.baseTypeNames.length)];
      const gender = getBaseGender(base);
      const categories = gender === 'f' ? FEMALE_CATEGORIES : MALE_CATEGORIES;
      const weights = [1, 5, 15, 20, 15, 8, 3, 1];
      const total = weights.reduce((sum, value) => sum + value, 0);
      let r = Math.random() * total;
      let traitCount = 0;
      for (let i = 0; i < weights.length; i += 1) {
        r -= weights[i];
        if (r <= 0) {
          traitCount = i;
          break;
        }
      }

      const byCategory = getTraitsByCategory(gender);
      const eyesTrait = pickRandomTraitByCategory(byCategory, 'eyes');
      if (!eyesTrait) continue;
      const extraTraitCount = Math.max(0, traitCount - 1);
      const traits = [
        eyesTrait,
        ...categories
          .filter((category) => category !== 'eyes')
        .sort(() => Math.random() - 0.5)
          .slice(0, extraTraitCount)
        .map((category) => {
          const values = byCategory[category] || [];
          return values.length ? values[randomInt(values.length)] : null;
          })
          .filter(Boolean),
      ];

      if (checkExists(base, traits) === null) return { base, traits };
    }
    return { base: 'Alien', traits: ['Eye Mask', 'Mohawk', 'Earring', 'Smile', 'Big Beard'] };
  }

  function hashString(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function punkFromSeed(seed) {
    let h = hashString(`nopunks:${seed}`);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const base = traitsData.baseTypeNames[h % traitsData.baseTypeNames.length];
      h = (Math.imul(h || 1, 1103515245) + 12345) >>> 0;
      const gender = getBaseGender(base);
      const categories = gender === 'f' ? FEMALE_CATEGORIES : MALE_CATEGORIES;
      const byCategory = getTraitsByCategory(gender);
      const traitCount = (h % 5) + 1;
      const traits = [];
      const eyes = byCategory.eyes || [];
      if (eyes.length) {
        h = (Math.imul(h || 1, 1103515245) + 12345) >>> 0;
        traits.push(eyes[h % eyes.length]);
      }

      for (let i = 0; i < Math.min(traitCount - traits.length, categories.length - 1); i += 1) {
        h = (Math.imul(h || 1, 1103515245) + 12345 + i) >>> 0;
        const availableCategories = categories.filter((category) => category !== 'eyes');
        const category = availableCategories[h % availableCategories.length];
        if (traits.some((name) => traitsData.traits[name]?.category === category)) continue;
        const values = byCategory[category] || [];
        if (values.length) traits.push(values[h % values.length]);
      }

      if (checkExists(base, traits) === null || attempt > 20) return { base, traits };
    }
    return randomPunk();
  }

  function buildUrl(base, traits) {
    const params = new URLSearchParams();
    params.set('type', slugify(base).replace(/-/g, ''));
    for (const trait of traits) {
      const category = traitsData.traits[trait]?.category || 'trait';
      params.append(category, slugify(trait));
    }
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  }

  function updateRoute(base, traits) {
    const url = buildUrl(base, traits);
    history.replaceState(null, '', url);
    return url;
  }

  function renderEvidenceRows(rows) {
    el.evidence.innerHTML = rows.map(([label, value]) => `
      <div class="evidence-row">
        <b>${escapeHtml(label)}</b>
        <span>${value}</span>
      </div>
    `).join('');
  }

  function renderLinks(state, shareUrl) {
    const links = [
      `<button id="copy-link" class="copy-url" type="button">${escapeHtml(shareUrl)}</button>`,
    ];

    if (state.exists) {
      links.push(`<a href="https://www.cryptopunks.app/cryptopunks/details/${state.existingId}" target="_blank" rel="noopener noreferrer">CryptoPunk V2 #${state.existingId}</a>`);
      links.push(`<a href="https://punksmarket.app/punk/${state.existingId}" target="_blank" rel="noopener noreferrer">CryptoPunk V1 #${state.existingId}</a>`);
      links.push(`<a href="/api/v2/tokens/${state.existingId}" target="_blank" rel="noopener noreferrer">No-Punk API #${state.existingId}</a>`);
      links.push(`<a href="https://opensea.io/assets/base/0xa62f65d503068684e7228df98090f94322b8ed54/${state.existingId}" target="_blank" rel="noopener noreferrer">No-Punk V2 Market #${state.existingId}</a>`);
    } else {
      links.push('<a href="/api/v2/datasets" target="_blank" rel="noopener noreferrer">No-Punks datasets</a>');
    }

    el.links.innerHTML = links.join('');
    const copyBtn = document.getElementById('copy-link');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard?.writeText(shareUrl);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = shareUrl; }, 1200);
    });
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  }

  async function updateApiEvidence(state, runId) {
    if (!state.exists) return;
    try {
      let noPunk;
      try {
        noPunk = await fetchJson(`/api/v2/tokens/${state.existingId}`);
      } catch {
        noPunk = await fetchJson(`https://nopunks.xyz/api/v2/tokens/${state.existingId}`);
      }
      if (runId !== evidenceRun || !currentState?.exists || currentState.existingId !== state.existingId) return;
      const attr = Array.isArray(noPunk.attributes)
        ? noPunk.attributes.map((item) => `${item.trait_type}: ${item.value}`).join(', ')
        : 'Unavailable';
      renderEvidenceRows([
        ['Result', `Real CryptoPunk combo. <span class="struck">Not</span> is struck.`],
        ['Source', `CryptoPunk #${state.existingId}; same-index No-Punk #${state.existingId}.`],
        ['No-Punks', escapeHtml(attr)],
        ['API Source', escapeHtml(noPunk.source?.type || 'No-Punks API')],
        ['Render Rule', '#000000 skin/background; NoPunks outline/black pixels -> #040404; trait colors preserved.'],
      ]);
    } catch {
      if (runId !== evidenceRun) return;
      renderEvidenceRows([
        ['Result', `Real CryptoPunk combo. <span class="struck">Not</span> is struck.`],
        ['Source', `CryptoPunk #${state.existingId}; same-index No-Punk #${state.existingId}.`],
        ['No-Punks', 'Metadata unavailable from local API.'],
        ['Render Rule', '#000000 skin/background; NoPunks outline/black pixels -> #040404; trait colors preserved.'],
      ]);
    }
  }

  function updateDisplay() {
    const base = el.type.value;
    const traits = getCurrentTraits();
    const existingId = checkExists(base, traits);
    const exists = existingId !== null;
    const state = { base, traits, exists, existingId };
    currentState = state;
    evidenceRun += 1;
    const runId = evidenceRun;
    const shareUrl = updateRoute(base, traits);
    const svg = renderNoPunk(base, traits, { improvenancePixel: false });
    const existingSvg = el.frame.querySelector('svg');
    if (existingSvg) existingSvg.remove();
    el.frame.insertAdjacentHTML('beforeend', svg);

    if (exists) {
      el.title.textContent = 'No-Existence';
      el.pill.innerHTML = `<strong>Real</strong> #${existingId}`;
      el.status.innerHTML = `<strong>Matched CryptoPunk #${existingId}</strong> / ${escapeHtml(base)} / ${traits.length} traits`;
      renderEvidenceRows([
        ['Result', `Real CryptoPunk combo. <span class="struck">Not</span> is struck.`],
        ['Source', `CryptoPunk #${existingId}; checking No-Punks API...`],
        ['Traits', escapeHtml(traits.length ? traits.join(', ') : 'No traits')],
        ['Render Rule', '#000000 skin/background; NoPunks outline/black pixels -> #040404; trait colors preserved.'],
      ]);
      updateApiEvidence(state, runId);
    } else {
      el.title.textContent = 'No-Existence';
      el.pill.innerHTML = '<strong>Impossible</strong> combo';
      el.status.innerHTML = `<strong>Synthetic No-Punk</strong> / ${escapeHtml(base)} / ${traits.length} traits`;
      renderEvidenceRows([
        ['Result', 'No matching CryptoPunk in the real 10,000 combo map.'],
        ['Traits', escapeHtml(traits.length ? traits.join(', ') : 'No traits')],
        ['Export', 'PNG adds one bottom-right improvenance pixel.'],
        ['Render Rule', '#000000 skin/background; NoPunks outline/black pixels -> #040404; trait colors preserved.'],
      ]);
    }

    renderLinks(state, shareUrl);
  }

  function loadFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const typeSlug = params.get('type');
    if (!typeSlug) return false;
    const base = traitsData.baseTypeNames.find((name) => slugify(name).replace(/-/g, '') === typeSlug);
    if (!base) return false;

    const traitNames = [];
    for (const [key, value] of params.entries()) {
      if (key === 'type') continue;
      const normalized = unslug(value);
      const trait = traitsData.traitNames.find((name) => normalizeTraitName(name) === normalized);
      if (trait) traitNames.push(trait);
    }

    setSelectValues(base, traitNames);
    return true;
  }

  function getExportFilename() {
    return currentState?.exists
      ? `nopunk-source-${currentState.existingId}.png`
      : 'no-existence.png';
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('PNG export failed'));
      }, 'image/png');
    });
  }

  function triggerBrowserDownload(pngBlob, filename) {
    const pngUrl = URL.createObjectURL(pngBlob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = pngUrl;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(pngUrl), 30000);
  }

  async function savePngBlob(pngBlob, filename) {
    const file =
      typeof File === 'function'
        ? new File([pngBlob], filename, { type: 'image/png' })
        : null;
    if (
      file &&
      navigator.share &&
      navigator.canShare &&
      navigator.canShare({ files: [file] })
    ) {
      try {
        await navigator.share({
          files: [file],
          title: 'No-Existence',
          text: filename,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      const pngUrl = URL.createObjectURL(pngBlob);
      const opened = window.open(pngUrl, '_blank', 'noopener,noreferrer');
      if (opened) {
        setTimeout(() => URL.revokeObjectURL(pngUrl), 60000);
        return;
      }
      URL.revokeObjectURL(pngUrl);
    }

    triggerBrowserDownload(pngBlob, filename);
  }

  function downloadPng() {
    if (!currentState) return;
    const svg = renderNoPunk(currentState.base, currentState.traits, {
      improvenancePixel: !currentState.exists,
    });
    const size = 2400;
    const canvas = document.getElementById('export-canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = async () => {
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      const pngBlob = await canvasToPngBlob(canvas);
      await savePngBlob(pngBlob, getExportFilename());
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  async function init() {
    if (window.__NO_PUNK_TRAITS__ && window.__NO_PUNK_COMBOS__) {
      traitsData = window.__NO_PUNK_TRAITS__;
      comboMap = window.__NO_PUNK_COMBOS__;
    } else {
      const [traitsRes, combosRes] = await Promise.all([
        fetch('data/traits.json'),
        fetch('data/combos.json'),
      ]);
      traitsData = await traitsRes.json();
      comboMap = await combosRes.json();
    }

    populateTypeSelector();
    populateTraitSelectors(getBaseGender(traitsData.baseTypeNames[0]));

    el.type.addEventListener('change', () => {
      populateTraitSelectors(getBaseGender(el.type.value));
      updateDisplay();
    });
    for (const selectEl of allTraitSelects) {
      selectEl.addEventListener('change', updateDisplay);
    }
    el.randomize.addEventListener('click', () => {
      const punk = randomPunk();
      setSelectValues(punk.base, punk.traits);
      updateDisplay();
    });
    el.seedButton.addEventListener('click', () => {
      const tokenId = String(el.seedInput.value || '').trim();
      if (!/^\d+$/.test(tokenId)) return;
      const punk = punkFromSeed(tokenId);
      setSelectValues(punk.base, punk.traits);
      updateDisplay();
    });
    el.seedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') el.seedButton.click();
    });
    el.download.addEventListener('click', downloadPng);

    if (!loadFromUrl()) {
      const punk = randomPunk();
      setSelectValues(punk.base, punk.traits);
    }
    updateDisplay();
  }

  init().catch((err) => {
    console.error(err);
    el.status.textContent = 'Tool failed to load local trait data.';
    el.evidence.textContent = 'Data unavailable.';
  });
})();
