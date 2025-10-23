// server.js
// Uses token_map.json (kept in ./public/) to open the correct OpenSea item for any visible edition.
// Accepts either 0-based keys (fileIndex 0..9999) or 1-based keys (edition 1..10000).

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Config ----------
const CHAIN = 'base';
const CONTRACT = '0x4ed83635e2309a7c067d0f98efca47b920bf79b1';
const PORT = process.env.PORT || 3000;

// Serve your static site files from ./public (images 0.png..9999.png, json, index.html, token_map.json, etc.)
const PUBLIC_DIR = path.join(__dirname, 'public');

// Disable caching while iterating locally
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
  next();
});

app.use(express.static(PUBLIC_DIR));

// Serve index.html (prefer public/index.html; fall back to project root index.html)
app.get('/', (req, res) => {
  const publicIndex = path.join(PUBLIC_DIR, 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  fs.access(publicIndex, fs.constants.R_OK, (err) => {
    const target = err ? rootIndex : publicIndex;
    res.sendFile(target);
  });
});

// ---------- Load mapping ----------
const MAP_PATH = path.join(PUBLIC_DIR, 'token_map.json');

let tokenMapRaw = {};
let hasZeroKey = false;
try {
  const txt = fs.readFileSync(MAP_PATH, 'utf8');
  tokenMapRaw = JSON.parse(txt);
  hasZeroKey = Object.prototype.hasOwnProperty.call(tokenMapRaw, '0');
  const entries = Array.isArray(tokenMapRaw) ? tokenMapRaw.length : Object.keys(tokenMapRaw).length;
  console.log(
    `Loaded token_map.json (${entries} entries) – ` +
    (hasZeroKey ? 'interpreting as 0-based keys' : 'interpreting as 1-based keys')
  );
} catch (e) {
  console.warn(`token_map.json not found or invalid at ${MAP_PATH}. Clicks will fall back to 1:1 mapping. ${e.message}`);
}

// Convert “visible edition (1..10000)” → token_id using the map
function tokenIdForEdition(edition) {
  if (!Number.isFinite(edition) || edition < 1 || edition > 10000) return null;

  // 1-based direct hit (if your map already uses 1..10000 as keys)
  if (Object.prototype.hasOwnProperty.call(tokenMapRaw, String(edition))) {
    return tokenMapRaw[String(edition)];
  }

  // 0-based map: use (edition - 1) key
  if (hasZeroKey && Object.prototype.hasOwnProperty.call(tokenMapRaw, String(edition - 1))) {
    return tokenMapRaw[String(edition - 1)];
  }

  // Fallback: assume 1:1 (better than nothing)
  return edition;
}

function osUrlFromToken(tokenId) {
  return `https://opensea.io/item/${CHAIN}/${CONTRACT}/${tokenId}`;
}

// ---------- API ----------
app.get('/api/opensea-url', (req, res) => {
  const edition = parseInt(req.query.edition, 10);
  if (!Number.isFinite(edition)) return res.status(400).json({ error: 'edition must be a number' });

  const tokenId = tokenIdForEdition(edition);
  if (!tokenId) return res.status(404).json({ error: 'edition out of range' });

  return res.json({ edition, token_id: tokenId, url: osUrlFromToken(tokenId) });
});

app.post('/api/opensea-url-batch', (req, res) => {
  const editions = Array.isArray(req.body) ? req.body : [];
  const out = editions
    .map((e) => {
      const ed = parseInt(e, 10);
      const tokenId = tokenIdForEdition(ed);
      return tokenId ? { edition: ed, token_id: tokenId, url: osUrlFromToken(tokenId) } : null;
    })
    .filter(Boolean);
  res.json(out);
});

// Quick sanity/status endpoint
app.get('/api/mapping-stats', (_req, res) => {
  const entries = Array.isArray(tokenMapRaw) ? tokenMapRaw.length : Object.keys(tokenMapRaw).length;
  res.json({
    entries,
    zero_based: hasZeroKey,
    sample: Object.entries(tokenMapRaw).slice(0, 10)
  });
});

app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
  console.log(`Map path: ${MAP_PATH}`);
  try {
    fs.accessSync(path.join(PUBLIC_DIR, 'index.html'), fs.constants.R_OK);
    console.log('Index: public/index.html');
  } catch {
    console.log('Index: ./index.html (root)');
  }
});