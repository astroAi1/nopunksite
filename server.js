// server.js
// NoPunks site server
// - Serves static files (if needed)
// - Proxies OpenSea for NFT metadata + stats + sales + listings
// - Uses public/token_map.json to map 0–9999 index -> real token ID
// - Exposes /api/showcase for daily rotating cross-collection picks
// - Exposes /api/etherscan/transfers for chain-level NoPunks data (via Etherscan/Basescan)

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// CORS – allow Netlify / custom domains to call this API
// -----------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// -----------------------------
// CONFIG
// -----------------------------
const CHAIN =
  process.env.OPENSEA_CHAIN ||
  process.env.CHAIN ||
  'base';

const CONTRACT =
  process.env.OPENSEA_CONTRACT ||
  process.env.CONTRACT ||
  '0xa62f65d503068684e7228df98090F94322b8ed54'; // NoPunks V2 contract

const COLLECTION_SLUG =
  process.env.OPENSEA_COLLECTION_SLUG ||
  process.env.COLLECTION_SLUG ||
  'nopunkismv2';

// Side collections
const NOPNUK_CONTRACT =
  process.env.NOPNUK_CONTRACT ||
  '0xc0953eA4449e6592aaEb91475D1Ce5F0365D1D25'; // nopnuks 2024

const NOPIXELPEPEN_CONTRACT =
  process.env.NOPIXELPEPEN_CONTRACT ||
  '0xa9f8EfD315Dcb9b0474F62f3Ad175e2CcD244789'; // nopixelpepen 3888

const NOTINYDINOS_CONTRACT =
  process.env.NOTINYDINOS_CONTRACT ||
  '0x1c08b2d77D143b5A3F11f283beBE3e45c1aEEd27'; // notinydinos 1000

const BUCKED_BLOWN_CONTRACT =
  process.env.BUCKED_BLOWN_CONTRACT ||
  '0x13E09Ef7046442B67dd45A4FA4Ca61feB2eB30Aa'; // Bucked Blown 1500

// Exact total supplies
const NOPUNKS_SUPPLY = 10000;
const NOPNUK_SUPPLY = 2024;
const NOPIXELPEPEN_SUPPLY = 3888;
const NOTINYDINOS_SUPPLY = 1000;
const BUCKED_BLOWN_SUPPLY = 1500;

// In‑memory pagination cache for the main NoPunks collection (for /api/collection)
const COLLECTION_PAGE_SIZE = 50; // must match frontend PAGE_SIZE
let collectionHighestPageLoaded = 0;
let collectionNextCursorAfterHighest = null; // "next" cursor returned after the highest loaded page
const collectionPageTokens = new Map(); // page -> [tokens]

// Showcase config – one daily pick from each of these
const SHOWCASE_COLLECTIONS = [
  {
    key: 'nopunkismv2',
    label: 'No-Punks',
    contract: CONTRACT,
    totalSupply: NOPUNKS_SUPPLY,
    useTokenMap: true,
  },
  {
    key: 'no-pnuks',
    label: 'No-Pnuk',
    contract: NOPNUK_CONTRACT,
    totalSupply: NOPNUK_SUPPLY,
    useTokenMap: false,
  },
  {
    key: 'no-pixelpepen',
    label: 'No-Pixelpepen',
    contract: NOPIXELPEPEN_CONTRACT,
    totalSupply: NOPIXELPEPEN_SUPPLY,
    useTokenMap: false,
  },
  {
    key: 'no-tinydinopunks',
    label: 'No-TinyDinoPunks',
    contract: NOTINYDINOS_CONTRACT,
    totalSupply: NOTINYDINOS_SUPPLY,
    useTokenMap: false,
  },
  {
    key: 'bucked-blown',
    label: 'Bucked Blown',
    contract: BUCKED_BLOWN_CONTRACT,
    totalSupply: BUCKED_BLOWN_SUPPLY,
    useTokenMap: false,
  },
];

// OpenSea API key
const OPENSEA_API_KEY =
  process.env.OPENSEA_API_KEY || '62d4fdc803204dde8192c136b4c344cf';

if (!OPENSEA_API_KEY) {
  console.warn(
    'WARNING: OPENSEA_API_KEY is not set. OpenSea requests will likely fail.'
  );
}

// Etherscan/Basescan API key (for on-chain data)
const ETHERSCAN_API_KEY =
  process.env.ETHERSCAN_API_KEY || '7ZJAP58FPD21M8W9R6IES3G1XNC7EHCPSA';

if (!ETHERSCAN_API_KEY) {
  console.warn(
    'WARNING: ETHERSCAN_API_KEY is not set. Etherscan/Basescan requests will be disabled.'
  );
}

// Use Node 18 global fetch if available, otherwise lazy-load node-fetch (ESM)
const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) =>
      import('node-fetch').then(({ default: fetch }) => fetch(...args));

// -----------------------------
// TOKEN MAP
// -----------------------------
// IMPORTANT: we now use /public/token_map.json
const tokenMapPath = path.join(__dirname, 'public', 'token_map.json');
let tokenMap = {};
try {
  tokenMap = JSON.parse(fs.readFileSync(tokenMapPath, 'utf8'));
} catch (err) {
  console.warn('Could not read public/token_map.json, using identity mapping.', err);
}

function indexToTokenId(index) {
  const key = String(index);
  const mapped = tokenMap[key];
  return mapped != null ? mapped : index;
}

// Reverse token map: on-chain tokenId -> 0–9999 collection index
const reverseTokenMap = {};
try {
  Object.keys(tokenMap).forEach((idx) => {
    const mapped = tokenMap[idx];
    if (mapped != null) {
      reverseTokenMap[String(mapped)] = Number(idx);
    }
  });

  // If tokenMap is empty or partial, fall back to identity for 0–9999
  for (let i = 0; i < NOPUNKS_SUPPLY; i++) {
    const key = String(i);
    if (reverseTokenMap[key] == null) {
      reverseTokenMap[key] = i;
    }
  }
} catch (e) {
  console.warn('Failed to build reverseTokenMap from token_map.json', e);
}

// -----------------------------
// TRAITS INDEX – local canonical traits for hover + stats
// -----------------------------
const traitsIndexPath = path.join(__dirname, 'public', 'traits', 'traits_index.json');
let traitsIndex = null;
let traitsIndexIsArray = false;

try {
  const raw = JSON.parse(fs.readFileSync(traitsIndexPath, 'utf8'));
  if (Array.isArray(raw)) {
    traitsIndex = raw;
    traitsIndexIsArray = true;
  } else if (raw && typeof raw === 'object') {
    traitsIndex = raw;
    traitsIndexIsArray = false;
  } else {
    console.warn('traits_index.json has unexpected format; ignoring.');
  }
} catch (err) {
  console.warn(
    'Could not read traits_index.json – hover traits will use OpenSea metadata only.',
    err
  );
}

function normaliseTraitsEntry(entry) {
  if (!entry) return null;
  if (Array.isArray(entry.traits)) return entry.traits;
  if (Array.isArray(entry.attributes)) return entry.attributes;
  if (Array.isArray(entry)) return entry;
  return null;
}

function getTraitsForToken(tokenId, index) {
  if (!traitsIndex) return null;

  const keyStr = tokenId != null ? String(tokenId) : null;

  // Resolve a collection index if we can (for array-based traitsIndex)
  let resolvedIndex =
    typeof index === 'number' && index >= 0 ? index : null;

  if (
    resolvedIndex == null &&
    keyStr &&
    traitsIndexIsArray &&
    reverseTokenMap &&
    Object.prototype.hasOwnProperty.call(reverseTokenMap, keyStr)
  ) {
    resolvedIndex = reverseTokenMap[keyStr];
  }

  // Object keyed by tokenId
  if (!traitsIndexIsArray && keyStr) {
    const direct = traitsIndex[keyStr];
    const directTraits = normaliseTraitsEntry(direct);
    if (directTraits) return directTraits;
  }

  // Array indexed by 0–9999 index
  if (
    traitsIndexIsArray &&
    typeof resolvedIndex === 'number' &&
    resolvedIndex >= 0 &&
    resolvedIndex < traitsIndex.length
  ) {
    const byIndex = traitsIndex[resolvedIndex];
    const byIndexTraits = normaliseTraitsEntry(byIndex);
    if (byIndexTraits) return byIndexTraits;
  }

  // Fallback: scan for a matching token id inside entries
  if (keyStr) {
    const scanSource = traitsIndexIsArray
      ? traitsIndex
      : Object.values(traitsIndex);
    for (const entry of scanSource) {
      if (!entry || typeof entry !== 'object') continue;
      const entryId =
        entry.token_id ??
        entry.tokenId ??
        entry.id ??
        entry.identifier ??
        entry.onChainId ??
        null;
      if (entryId != null && String(entryId) === keyStr) {
        const traits = normaliseTraitsEntry(entry);
        if (traits) return traits;
      }
    }
  }

  return null;
}

// -----------------------------
// SIMPLE IN-MEMORY NFT CACHE
// -----------------------------
const nftCache = new Map();

// -----------------------------
// STATIC FILES
// -----------------------------
// Serve everything from project root
app.use(express.static(path.join(__dirname)));

// Also explicitly serve /public for anything you’ve parked in there
app.use('/public', express.static(path.join(__dirname, 'public')));

// Traits index for frontend
app.use(
  '/traits',
  express.static(path.join(__dirname, 'public', 'traits'))
);

// In case icons / no-meta / team live under /public, wire these paths too:
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
app.use('/no-meta', express.static(path.join(__dirname, 'public', 'no-meta')));
app.use('/team', express.static(path.join(__dirname, 'public', 'team')));
app.use('/marketplace', express.static(path.join(__dirname, 'public', 'marketplace')));

// -----------------------------
// HELPERS – OpenSea
// -----------------------------
function normaliseImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('ipfs://')) {
    return url.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }
  return url;
}

async function fetchJsonFromOpenSea(url, label = 'OpenSea', timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      headers: {
        accept: 'application/json',
        'x-api-key': OPENSEA_API_KEY,
      },
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      const shortBody = text.slice(0, 200).replace(/\s+/g, ' ');
      console.error(`${label} error ${res.status}: ${shortBody}`);
      throw new Error(`${label} request failed with ${res.status}`);
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      console.error(`${label} JSON parse error:`, e);
      throw e;
    }
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------
// HELPERS – Etherscan/Basescan
// -----------------------------
function getEtherscanBaseUrl() {
  if (CHAIN.toLowerCase() === 'base') {
    return 'https://api.basescan.org/api';
  }
  if (CHAIN.toLowerCase() === 'ethereum' || CHAIN.toLowerCase() === 'mainnet') {
    return 'https://api.etherscan.io/api';
  }
  return 'https://api.etherscan.io/api';
}

async function fetchJsonFromEtherscan(params, label = 'Etherscan', timeoutMs = 20000) {
  if (!ETHERSCAN_API_KEY) {
    throw new Error('ETHERSCAN_API_KEY not configured');
  }

  const baseUrl = getEtherscanBaseUrl();
  const url = `${baseUrl}?${new URLSearchParams({
    ...params,
    apikey: ETHERSCAN_API_KEY,
  }).toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      const shortBody = text.slice(0, 200).replace(/\s+/g, ' ');
      console.error(`${label} error ${res.status}: ${shortBody}`);
      throw new Error(`${label} request failed with ${res.status}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error(`${label} JSON parse error:`, e);
      throw e;
    }

    if (json.status && json.status !== '1' && json.message !== 'OK') {
      console.warn(`${label} non-OK response:`, json.message, json.result);
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// =======================
// /api/etherscan/transfers
// =======================
app.get('/api/etherscan/transfers', async (req, res) => {
  try {
    const page = req.query.page || '1';
    const offset = req.query.limit || '25';

    const data = await fetchJsonFromEtherscan(
      {
        module: 'account',
        action: 'tokennfttx',
        contractaddress: CONTRACT,
        page,
        offset,
        sort: 'desc',
      },
      'Etherscan transfers',
      20000
    );

    const txs = Array.isArray(data.result) ? data.result : [];

    const transfers = txs.map((tx) => ({
      tokenId: tx.tokenID,
      from: tx.from,
      to: tx.to,
      hash: tx.hash,
      timeStamp: tx.timeStamp,
      blockNumber: tx.blockNumber,
      value: tx.value,
    }));

    res.json({ transfers });
  } catch (err) {
    console.error('Etherscan transfers API error:', err.message || err);
    res.status(502).json({
      transfers: [],
      error: 'On-chain transfers unavailable',
    });
  }
});

// -----------------------------
// SIMPLE OPENSEA REQUEST QUEUE
// -----------------------------
const openSeaQueue = [];
let openSeaActive = false;

function processOpenSeaQueue() {
  if (openSeaActive) return;
  const next = openSeaQueue.shift();
  if (!next) return;

  openSeaActive = true;
  const { url, label, timeoutMs, resolve, reject } = next;

  fetchJsonFromOpenSea(url, label, timeoutMs)
    .then((result) => resolve(result))
    .catch((err) => reject(err))
    .finally(() => {
      openSeaActive = false;
      setTimeout(processOpenSeaQueue, 500); // ~2 req/s max
    });
}

function queueOpenSeaRequest(url, label = 'OpenSea', timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    openSeaQueue.push({ url, label, timeoutMs, resolve, reject });
    processOpenSeaQueue();
  });
}

// -----------------------------
// DAILY SHOWCASE HELPERS
// -----------------------------
function getDailySeedString() {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function hashToRange(str, max) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  hash = Math.abs(hash);
  return hash % max;
}

// =======================
// /api/nft/:index
// =======================
app.get('/api/nft/:index', async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    if (Number.isNaN(index) || index < 0 || index >= 10000) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    const tokenId = indexToTokenId(index);
    const cacheKey = `${CONTRACT.toLowerCase()}:${tokenId}`;
    const cached = nftCache.get(cacheKey);
    if (cached) {
      const canonicalTraits = getTraitsForToken(tokenId, index);
      if (canonicalTraits && !cached.traits && !cached.attributes) {
        cached.traits = canonicalTraits;
        cached.attributes = canonicalTraits;
      }
      return res.json(cached);
    }

    const url = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${tokenId}`;
    const data = await queueOpenSeaRequest(url, 'NFT');

    const nft = data.nft || data || {};

    const image_url = normaliseImageUrl(
      nft.image_url ||
        nft.display_image_url ||
        nft.image_original_url ||
        nft.image ||
        ''
    );

    const canonicalTraits = getTraitsForToken(tokenId, index);

    const payload = {
      ...nft,
      image_url,
      onChainId: nft.identifier || nft.token_id || tokenId,
    };

    if (canonicalTraits) {
      payload.traits = canonicalTraits;
      payload.attributes = canonicalTraits;
    }

    nftCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('NFT API error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch NFT from OpenSea' });
  }
});

// Helper: fetch and normalise a single page from OpenSea using the collection slug and cursor
async function fetchCollectionPageFromOpenSea(cursor, pageSize) {
  const limit = pageSize || COLLECTION_PAGE_SIZE;

  const baseUrl =
    `https://api.opensea.io/api/v2/collection/${COLLECTION_SLUG}/nfts` +
    `?limit=${limit}&chain=${CHAIN}`;

  const url = cursor
    ? `${baseUrl}&next=${encodeURIComponent(cursor)}`
    : baseUrl;

  const data = await queueOpenSeaRequest(url, 'Collection page', 25000);

  const nfts = Array.isArray(data.nfts)
    ? data.nfts
    : Array.isArray(data.assets)
    ? data.assets
    : [];

  const cursorNext = data.next || null;

  const tokens = nfts.map((nft) => {
    const image_url = normaliseImageUrl(
      nft.image_url ||
        nft.image_original_url ||
        nft.display_image_url ||
        nft.image ||
        (nft.media &&
          nft.media[0] &&
          (nft.media[0].gateway || nft.media[0].thumbnail)) ||
        ''
    );

    const tokenId =
      nft.identifier ||
      nft.token_id ||
      (nft.id && nft.id.tokenId) ||
      null;

    let collectionIndex = null;
    if (
      tokenId != null &&
      Object.prototype.hasOwnProperty.call(reverseTokenMap, String(tokenId))
    ) {
      collectionIndex = reverseTokenMap[String(tokenId)];
    }

    const canonicalTraits = getTraitsForToken(tokenId, collectionIndex);

    const base = {
      ...nft,
      image_url,
      onChainId: tokenId,
    };

    if (canonicalTraits) {
      base.traits = canonicalTraits;
      base.attributes = canonicalTraits;
    }

    return base;
  });

  return { tokens, cursorNext };
}

// =======================
// /api/collection
// =======================
// NOTE: we page via OpenSea's cursor ("next") for the collection slug,
// but the frontend only sends a numeric `page` (1‑based). This route
// keeps a simple in‑memory cache so that each page of 50 NoPunks is
// stable and unique while the server is running.
app.get('/api/collection', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = COLLECTION_PAGE_SIZE; // keep this in sync with website.js PAGE_SIZE

    // If we've already cached this page, return it immediately.
    if (collectionPageTokens.has(page)) {
      return res.json({
        tokens: collectionPageTokens.get(page),
        total: NOPUNKS_SUPPLY,
        page,
        pageSize,
      });
    }

    // On the very first request, ensure our cursor state is clean.
    if (collectionHighestPageLoaded === 0) {
      collectionNextCursorAfterHighest = null;
    }

    // We always fetch pages sequentially so OpenSea's `next` cursor
    // stays valid. For example, if highestPageLoaded === 2 and the
    // client asks for page 4, we fetch 3 then 4 in order.
    let cursor = collectionNextCursorAfterHighest;
    for (let p = collectionHighestPageLoaded + 1; p <= page; p++) {
      const { tokens, cursorNext } = await fetchCollectionPageFromOpenSea(
        cursor,
        pageSize
      );

      collectionPageTokens.set(p, tokens);
      collectionHighestPageLoaded = p;
      cursor = cursorNext;
      collectionNextCursorAfterHighest = cursor;

      // If OpenSea indicates there are no more pages, stop early.
      if (!cursor) {
        break;
      }
    }

    const tokens = collectionPageTokens.get(page) || [];

    res.json({
      tokens,
      total: NOPUNKS_SUPPLY,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('Collection API error:', err.message || err);
    res.status(502).json({
      tokens: [],
      total: NOPUNKS_SUPPLY,
      page: 1,
      pageSize: COLLECTION_PAGE_SIZE,
      error: 'Collection unavailable',
    });
  }
});

// =======================
// /api/showcase
// =======================
app.get('/api/showcase', async (req, res) => {
  const seedBase = getDailySeedString();
  const showcase = [];
  const failedCollections = [];

  for (const cfg of SHOWCASE_COLLECTIONS) {
    let picked = null;

    // 1) Try slug-based list
    try {
      const slugUrl = `https://api.opensea.io/api/v2/collection/${cfg.key}/nfts?limit=50&chain=${CHAIN}`;
      const data = await queueOpenSeaRequest(
        slugUrl,
        `Showcase collection ${cfg.key}`,
        20000
      );

      const nfts = Array.isArray(data.nfts)
        ? data.nfts
        : Array.isArray(data.assets)
        ? data.assets
        : [];

      if (nfts.length) {
        const pickIndex = hashToRange(`${seedBase}:${cfg.key}`, nfts.length);
        const nft = nfts[pickIndex];

        const tokenId =
          nft.identifier ||
          nft.token_id ||
          nft.tokenId ||
          (nft.id && nft.id.tokenId) ||
          null;

        const image_url = normaliseImageUrl(
          nft.image_url ||
            nft.image_original_url ||
            nft.display_image_url ||
            (nft.media &&
              nft.media[0] &&
              (nft.media[0].thumbnail || nft.media[0].gateway)) ||
            ''
        );

        const onChainId = tokenId || null;

        if (cfg.contract && onChainId) {
          const cacheKey = `${cfg.contract.toLowerCase()}:${onChainId}`;
          nftCache.set(cacheKey, {
            ...nft,
            image_url,
            onChainId,
          });
        }

        picked = {
          key: cfg.key,
          label: cfg.label,
          projectLabel: cfg.label,
          project: cfg.key,
          collection: cfg.key,
          contract: cfg.contract,
          tokenId: onChainId ? String(onChainId) : '',
          image_url,
          onChainId,
        };
      } else {
        console.warn(
          `Showcase: collection ${cfg.key} returned no NFTs for slug-based fetch`
        );
      }
    } catch (err) {
      console.error(
        `Showcase: slug-based fetch failed for collection ${cfg.key}`,
        err && (err.message || err)
      );
    }

    // 2) Fallback – token-id guesses
    if (!picked && cfg.totalSupply && cfg.totalSupply > 0) {
      const maxAttempts = 8;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const indexZeroBased = hashToRange(
            `${seedBase}:${cfg.key}:fallback:${attempt}`,
            cfg.totalSupply
          );

          let tokenId;
          if (cfg.useTokenMap) {
            tokenId = indexToTokenId(indexZeroBased);
          } else {
            tokenId = indexZeroBased + 1;
          }

          const nftUrl = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${cfg.contract}/nfts/${tokenId}`;
          const data = await queueOpenSeaRequest(
            nftUrl,
            `Showcase fallback ${cfg.key}`,
            15000
          );
          const nft = data.nft || data || {};

          const image_url = normaliseImageUrl(
            nft.image_url ||
              nft.display_image_url ||
              nft.image_original_url ||
              nft.image ||
              ''
          );

          const onChainId =
            nft.identifier || nft.token_id || tokenId || null;

          const cacheKey = `${cfg.contract.toLowerCase()}:${onChainId}`;
          nftCache.set(cacheKey, {
            ...nft,
            image_url,
            onChainId,
          });

          picked = {
            key: cfg.key,
            label: cfg.label,
            projectLabel: cfg.label,
            project: cfg.key,
            collection: cfg.key,
            contract: cfg.contract,
            tokenId: String(onChainId),
            image_url,
            onChainId,
          };

          break;
        } catch (fallbackErr) {
          console.error(
            `Showcase fallback attempt ${attempt + 1} failed for ${cfg.key}`,
            fallbackErr && (fallbackErr.message || fallbackErr)
          );
        }
      }
    }

    if (picked) {
      showcase.push(picked);
    } else {
      failedCollections.push(cfg.key);
    }
  }

  const payload = {
    seed: seedBase,
    showcase,
    failedCollections,
  };

  console.log('Showcase debug:', JSON.stringify(payload, null, 2));
  res.json(payload);
});

// =======================
// /api/stats
// =======================
app.get('/api/stats', async (req, res) => {
  try {
    const url = `https://api.opensea.io/api/v2/collections/${COLLECTION_SLUG}/stats`;
    const data = await queueOpenSeaRequest(url, 'Stats', 25000);

    const rawStats = data.stats || data.total || data || {};

    function coerceNumber(v) {
      if (v == null) return null;
      if (typeof v === 'object') {
        if (v.quantity != null) return coerceNumber(v.quantity);
        if (v.total != null) return coerceNumber(v.total);
        if (v.value != null) return coerceNumber(v.value);
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    const floorPrice = coerceNumber(
      rawStats.floor_price ??
        rawStats.total_floor_price ??
        rawStats.floorPrice ??
        rawStats.floor ??
        rawStats.floor_price_eth ??
        null
    );

    let totalVolume = coerceNumber(
      rawStats.total_volume ??
        rawStats.volume_traded ??
        rawStats.totalVolume ??
        rawStats.volume ??
        rawStats.total_volume_eth ??
        null
    );

    if (totalVolume == null) {
      try {
        for (const [key, value] of Object.entries(rawStats)) {
          if (!/volume/i.test(key)) continue;
          const n = coerceNumber(value);
          if (n == null) continue;
          if (totalVolume == null || n > totalVolume) {
            totalVolume = n;
          }
        }
      } catch (scanErr) {
        console.warn('Could not auto-detect totalVolume from stats', scanErr);
      }
    }

    const numOwners = coerceNumber(
      rawStats.num_owners ??
        rawStats.numOwners ??
        rawStats.owners ??
        rawStats.unique_owners ??
        null
    );

    if (floorPrice != null) rawStats.floor_price = floorPrice;
    if (totalVolume != null) rawStats.total_volume = totalVolume;
    if (numOwners != null) rawStats.num_owners = numOwners;

    res.json({
      floorPrice,
      totalVolume,
      numOwners,
      stats: rawStats,
    });
  } catch (err) {
    console.error('Stats API error:', err.message || err);
    res.status(502).json({
      floorPrice: null,
      totalVolume: null,
      numOwners: null,
      stats: {},
      error: 'Stats unavailable',
    });
  }
});

// =======================
// /api/recent-sales
// =======================
app.get('/api/recent-sales', async (req, res) => {
  try {
    const url =
      `https://api.opensea.io/api/v2/events/collection/${COLLECTION_SLUG}` +
      `?event_type=sale&limit=5&chain=${CHAIN}`;

    const data = await queueOpenSeaRequest(url, 'Recent sales', 25000);
    const events = data.asset_events || data.events || [];

    const sales = events.map((ev) => {
      const asset = ev.asset || ev.nft || {};
      const tokenId = asset.token_id || asset.identifier || null;

      const payment = ev.payment || ev.payment_token || {};
      const totalPrice = payment.quantity || ev.total_price || null;
      const decimals =
        payment.decimals != null ? Number(payment.decimals) : 18;
      const symbol =
        (payment.token && payment.token.symbol) ||
        payment.symbol ||
        'ETH';

      const price =
        totalPrice != null ? Number(totalPrice) / 10 ** decimals : null;

      const time =
        ev.event_timestamp ||
        (ev.transaction && ev.transaction.timestamp) ||
        ev.created_date ||
        null;

      const image_url = normaliseImageUrl(
        asset.image_url ||
          asset.image_original_url ||
          asset.image_preview_url ||
          asset.display_image_url ||
          ''
      );

      // include buyer so "Sold to" text can show correctly
      const buyer =
        (ev.to_account && ev.to_account.address) ||
        (ev.winner_account && ev.winner_account.address) ||
        null;

      return {
        onChainId: tokenId,
        price,
        unit: symbol,
        time,
        image_url,
        buyer,
      };
    });

    res.json({ sales });
  } catch (err) {
    console.error('Recent sales API error:', err.message || err);
    res.status(502).json({ sales: [], error: 'Recent sales unavailable' });
  }
});

// =======================
// /api/listed
// =======================
app.get('/api/listed', async (req, res) => {
  try {
    // Paginate through all listings
    let allListings = [];
    let nextCursor = null;
    const maxPages = 10; // Safety limit
    let page = 0;

    do {
      const url = nextCursor
        ? `https://api.opensea.io/api/v2/listings/collection/${COLLECTION_SLUG}/all?limit=50&chain=${CHAIN}&next=${nextCursor}`
        : `https://api.opensea.io/api/v2/listings/collection/${COLLECTION_SLUG}/all?limit=50&chain=${CHAIN}`;

      const data = await queueOpenSeaRequest(url, `Listings page ${page + 1}`);
      const listings = data.listings || [];
      allListings = allListings.concat(listings);
      nextCursor = data.next || null;
      page++;
    } while (nextCursor && page < maxPages);

    const rawListings = allListings;

    const mapped = rawListings.map((l) => {
      const nft = l.nft || {};
      const tokenId =
        (l.protocol_data &&
          l.protocol_data.parameters &&
          l.protocol_data.parameters.offer &&
          l.protocol_data.parameters.offer[0] &&
          l.protocol_data.parameters.offer[0].identifierOrCriteria) ||
        nft.identifier ||
        null;

      const priceRaw =
        l.price && l.price.current && l.price.current.value
          ? String(l.price.current.value)
          : null;
      const decimals =
        (l.price &&
          l.price.current &&
          l.price.current.decimals &&
          Number(l.price.current.decimals)) ||
        18;

      const price =
        priceRaw != null ? Number(priceRaw) / 10 ** decimals : null;

      const image_url = normaliseImageUrl(
        nft.image_url ||
          nft.image_original_url ||
          nft.display_image_url ||
          ''
      );

      // include seller so "Listed by" text can show correctly
      const seller =
        (l.maker && l.maker.address) ||
        (l.seller && l.seller.address) ||
        null;

      return {
        onChainId: tokenId,
        price,
        unit: 'ETH',
        source: 'OpenSea',
        image_url,
        seller,
      };
    });

    // Deduplicate listings by tokenId, keeping only the lowest-priced listing for each
    const deduped = [];
    const seenTokenIds = new Map(); // tokenId -> index in deduped array

    for (const listing of mapped) {
      if (!listing.onChainId) continue;

      const tokenId = String(listing.onChainId);
      const existingIndex = seenTokenIds.get(tokenId);

      if (existingIndex === undefined) {
        // First time seeing this tokenId
        seenTokenIds.set(tokenId, deduped.length);
        deduped.push(listing);
      } else {
        // Already have a listing for this tokenId - keep the lower price
        const existing = deduped[existingIndex];
        if (listing.price != null && (existing.price == null || listing.price < existing.price)) {
          deduped[existingIndex] = listing;
        }
      }
    }

    const listingsWithImages = await Promise.all(
      deduped.map(async (item) => {
        if (!item.onChainId) return item;

        const cacheKey = `${CONTRACT.toLowerCase()}:${item.onChainId}`;
        const cached = nftCache.get(cacheKey);

        if (cached && cached.image_url) {
          return { ...item, image_url: cached.image_url };
        }

        if (item.image_url) {
          nftCache.set(cacheKey, {
            ...(cached || {}),
            onChainId: String(item.onChainId),
            image_url: item.image_url,
          });
          return item;
        }

        try {
          const nftUrl = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${item.onChainId}`;
          const nftData = await queueOpenSeaRequest(
            nftUrl,
            'Listing NFT image',
            15000
          );
          const nft = nftData.nft || nftData || {};
          const image_url = normaliseImageUrl(
            nft.image_url ||
              nft.display_image_url ||
              nft.image_original_url ||
              nft.image ||
              ''
          );

          if (image_url) {
            const payload = {
              ...(cached || {}),
              onChainId: String(item.onChainId),
              image_url,
            };
            nftCache.set(cacheKey, payload);
            return { ...item, image_url };
          }

          return item;
        } catch (e) {
          console.error('Failed to fetch listing NFT image', e.message || e);
          return item;
        }
      })
    );

    const listings = listingsWithImages;
    res.json({ listings });
  } catch (err) {
    console.error('Listings API error:', err.message || err);
    res.status(502).json({ listings: [], error: 'Listings unavailable' });
  }
});

// =======================
// MARKETPLACE CONFIG
// =======================

// Import ethers for contract interaction
let ethers;
try {
  ethers = require('ethers');
} catch (e) {
  console.warn('ethers not installed - marketplace API will be limited');
}

// Marketplace contract address (set after deployment)
const MARKETPLACE_CONTRACT = process.env.MARKETPLACE_CONTRACT || '';

// Base RPC URL for read operations
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Marketplace ABI (minimal for read operations)
const MARKETPLACE_ABI = [
  'function raffleCount() view returns (uint256)',
  'function auctionCount() view returns (uint256)',
  'function getActiveRaffles() view returns (uint256[])',
  'function getActiveAuctions() view returns (uint256[])',
  'function getRaffleDetails(uint256 raffleId) view returns (uint256 tokenId, address nftContract, uint256 endTime, uint256 entryCount, bool drawn, bool cancelled, address winner)',
  'function getAuctionDetails(uint256 auctionId) view returns (uint256 tokenId, address nftContract, uint256 endTime, uint256 reservePrice, uint256 minBidIncrement, address highestBidder, uint256 highestBid, bool finalized, bool cancelled)',
  'function getRaffleEntryCount(uint256 raffleId) view returns (uint256)',
  'function hasEnteredRaffle(uint256 raffleId, address entrant) view returns (bool)',
  'function getPendingReturns(uint256 auctionId, address bidder) view returns (uint256)',
  'event RaffleCreated(uint256 indexed raffleId, uint256 indexed tokenId, uint256 endTime)',
  'event RaffleEntered(uint256 indexed raffleId, address indexed entrant, uint256 totalEntries)',
  'event RaffleWinnerSelected(uint256 indexed raffleId, address indexed winner, uint256 indexed tokenId)',
  'event AuctionCreated(uint256 indexed auctionId, uint256 indexed tokenId, uint256 endTime, uint256 reservePrice, uint256 minBidIncrement)',
  'event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount)',
  'event AuctionFinalized(uint256 indexed auctionId, address indexed winner, uint256 amount)',
];

// Create provider and contract instance
let marketplaceProvider = null;
let marketplaceContract = null;

if (ethers && MARKETPLACE_CONTRACT) {
  try {
    marketplaceProvider = new ethers.providers.JsonRpcProvider(BASE_RPC_URL);
    marketplaceContract = new ethers.Contract(MARKETPLACE_CONTRACT, MARKETPLACE_ABI, marketplaceProvider);
    console.log(`Marketplace contract initialized at ${MARKETPLACE_CONTRACT}`);
  } catch (e) {
    console.error('Failed to initialize marketplace contract:', e.message);
  }
}

// =======================
// /api/marketplace/raffles
// =======================
app.get('/api/marketplace/raffles', async (req, res) => {
  try {
    // If contract not configured, return empty list
    if (!marketplaceContract) {
      return res.json({
        raffles: [],
        total: 0,
        message: 'Marketplace contract not configured',
      });
    }

    // Get active raffle IDs from contract
    const activeRaffleIds = await marketplaceContract.getActiveRaffles();

    // Fetch details for each active raffle
    const raffles = await Promise.all(
      activeRaffleIds.map(async (raffleId) => {
        try {
          const [tokenId, nftContract, endTime, entryCount, drawn, cancelled, winner] =
            await marketplaceContract.getRaffleDetails(raffleId);

          // Get NFT image from cache or OpenSea
          let image_url = '';
          const tokenIdNum = tokenId.toNumber();
          const cacheKey = `${CONTRACT.toLowerCase()}:${tokenIdNum}`;
          const cached = nftCache.get(cacheKey);

          if (cached && cached.image_url) {
            image_url = cached.image_url;
          } else {
            // Try to get from local icons
            image_url = `/icons/${tokenIdNum}.png`;
          }

          return {
            id: raffleId.toNumber(),
            tokenId: tokenIdNum,
            nftContract,
            endTime: endTime.toNumber(),
            entryCount: entryCount.toNumber(),
            drawn,
            cancelled,
            winner: winner !== '0x0000000000000000000000000000000000000000' ? winner : null,
            image_url,
            timeRemaining: Math.max(0, endTime.toNumber() - Math.floor(Date.now() / 1000)),
          };
        } catch (e) {
          console.error(`Failed to fetch raffle ${raffleId}:`, e.message);
          return null;
        }
      })
    );

    // Filter out failed fetches
    const validRaffles = raffles.filter(r => r !== null);

    res.json({
      raffles: validRaffles,
      total: validRaffles.length,
    });
  } catch (err) {
    console.error('Marketplace raffles API error:', err.message || err);
    res.status(502).json({
      raffles: [],
      total: 0,
      error: 'Failed to fetch raffles',
    });
  }
});

// =======================
// /api/marketplace/auctions
// =======================
app.get('/api/marketplace/auctions', async (req, res) => {
  try {
    // If contract not configured, return empty list
    if (!marketplaceContract) {
      return res.json({
        auctions: [],
        total: 0,
        message: 'Marketplace contract not configured',
      });
    }

    // Get active auction IDs from contract
    const activeAuctionIds = await marketplaceContract.getActiveAuctions();

    // Fetch details for each active auction
    const auctions = await Promise.all(
      activeAuctionIds.map(async (auctionId) => {
        try {
          const [tokenId, nftContract, endTime, reservePrice, minBidIncrement, highestBidder, highestBid, finalized, cancelled] =
            await marketplaceContract.getAuctionDetails(auctionId);

          // Get NFT image from cache or local
          let image_url = '';
          const tokenIdNum = tokenId.toNumber();
          const cacheKey = `${CONTRACT.toLowerCase()}:${tokenIdNum}`;
          const cached = nftCache.get(cacheKey);

          if (cached && cached.image_url) {
            image_url = cached.image_url;
          } else {
            image_url = `/icons/${tokenIdNum}.png`;
          }

          return {
            id: auctionId.toNumber(),
            tokenId: tokenIdNum,
            nftContract,
            endTime: endTime.toNumber(),
            reservePrice: ethers.utils.formatEther(reservePrice),
            minBidIncrement: ethers.utils.formatEther(minBidIncrement),
            highestBidder: highestBidder !== '0x0000000000000000000000000000000000000000' ? highestBidder : null,
            highestBid: ethers.utils.formatEther(highestBid),
            finalized,
            cancelled,
            image_url,
            timeRemaining: Math.max(0, endTime.toNumber() - Math.floor(Date.now() / 1000)),
          };
        } catch (e) {
          console.error(`Failed to fetch auction ${auctionId}:`, e.message);
          return null;
        }
      })
    );

    // Filter out failed fetches
    const validAuctions = auctions.filter(a => a !== null);

    res.json({
      auctions: validAuctions,
      total: validAuctions.length,
    });
  } catch (err) {
    console.error('Marketplace auctions API error:', err.message || err);
    res.status(502).json({
      auctions: [],
      total: 0,
      error: 'Failed to fetch auctions',
    });
  }
});

// =======================
// /api/marketplace/history
// =======================
app.get('/api/marketplace/history', async (req, res) => {
  try {
    // If contract not configured, return empty history
    if (!marketplaceContract || !marketplaceProvider) {
      return res.json({
        raffleHistory: [],
        auctionHistory: [],
        message: 'Marketplace contract not configured',
      });
    }

    // Query past events (last 10000 blocks ~ 1 day on Base)
    const currentBlock = await marketplaceProvider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 10000);

    // Get raffle winner events
    const raffleWinnerFilter = marketplaceContract.filters.RaffleWinnerSelected();
    const raffleWinnerEvents = await marketplaceContract.queryFilter(raffleWinnerFilter, fromBlock, currentBlock);

    const raffleHistory = raffleWinnerEvents.map(event => ({
      type: 'raffle',
      raffleId: event.args.raffleId.toNumber(),
      winner: event.args.winner,
      tokenId: event.args.tokenId.toNumber(),
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    }));

    // Get auction finalized events
    const auctionFinalizedFilter = marketplaceContract.filters.AuctionFinalized();
    const auctionFinalizedEvents = await marketplaceContract.queryFilter(auctionFinalizedFilter, fromBlock, currentBlock);

    const auctionHistory = auctionFinalizedEvents.map(event => ({
      type: 'auction',
      auctionId: event.args.auctionId.toNumber(),
      winner: event.args.winner,
      amount: ethers.utils.formatEther(event.args.amount),
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    }));

    res.json({
      raffleHistory,
      auctionHistory,
      fromBlock,
      toBlock: currentBlock,
    });
  } catch (err) {
    console.error('Marketplace history API error:', err.message || err);
    res.status(502).json({
      raffleHistory: [],
      auctionHistory: [],
      error: 'Failed to fetch history',
    });
  }
});

// =======================
// /api/marketplace/raffle/:id
// =======================
app.get('/api/marketplace/raffle/:id', async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id, 10);
    if (Number.isNaN(raffleId) || raffleId < 0) {
      return res.status(400).json({ error: 'Invalid raffle ID' });
    }

    if (!marketplaceContract) {
      return res.status(503).json({ error: 'Marketplace contract not configured' });
    }

    const [tokenId, nftContract, endTime, entryCount, drawn, cancelled, winner] =
      await marketplaceContract.getRaffleDetails(raffleId);

    const tokenIdNum = tokenId.toNumber();
    let image_url = `/icons/${tokenIdNum}.png`;
    const cacheKey = `${CONTRACT.toLowerCase()}:${tokenIdNum}`;
    const cached = nftCache.get(cacheKey);
    if (cached && cached.image_url) {
      image_url = cached.image_url;
    }

    res.json({
      id: raffleId,
      tokenId: tokenIdNum,
      nftContract,
      endTime: endTime.toNumber(),
      entryCount: entryCount.toNumber(),
      drawn,
      cancelled,
      winner: winner !== '0x0000000000000000000000000000000000000000' ? winner : null,
      image_url,
      timeRemaining: Math.max(0, endTime.toNumber() - Math.floor(Date.now() / 1000)),
    });
  } catch (err) {
    console.error('Raffle detail API error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch raffle details' });
  }
});

// =======================
// /api/marketplace/auction/:id
// =======================
app.get('/api/marketplace/auction/:id', async (req, res) => {
  try {
    const auctionId = parseInt(req.params.id, 10);
    if (Number.isNaN(auctionId) || auctionId < 0) {
      return res.status(400).json({ error: 'Invalid auction ID' });
    }

    if (!marketplaceContract) {
      return res.status(503).json({ error: 'Marketplace contract not configured' });
    }

    const [tokenId, nftContract, endTime, reservePrice, minBidIncrement, highestBidder, highestBid, finalized, cancelled] =
      await marketplaceContract.getAuctionDetails(auctionId);

    const tokenIdNum = tokenId.toNumber();
    let image_url = `/icons/${tokenIdNum}.png`;
    const cacheKey = `${CONTRACT.toLowerCase()}:${tokenIdNum}`;
    const cached = nftCache.get(cacheKey);
    if (cached && cached.image_url) {
      image_url = cached.image_url;
    }

    res.json({
      id: auctionId,
      tokenId: tokenIdNum,
      nftContract,
      endTime: endTime.toNumber(),
      reservePrice: ethers.utils.formatEther(reservePrice),
      minBidIncrement: ethers.utils.formatEther(minBidIncrement),
      highestBidder: highestBidder !== '0x0000000000000000000000000000000000000000' ? highestBidder : null,
      highestBid: ethers.utils.formatEther(highestBid),
      finalized,
      cancelled,
      image_url,
      timeRemaining: Math.max(0, endTime.toNumber() - Math.floor(Date.now() / 1000)),
    });
  } catch (err) {
    console.error('Auction detail API error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch auction details' });
  }
});

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(
    `NoPunks server running at http://localhost:${PORT}\n` +
      `Collection slug: ${COLLECTION_SLUG} | Chain: ${CHAIN} | Contract: ${CONTRACT}` +
      (MARKETPLACE_CONTRACT ? `\nMarketplace: ${MARKETPLACE_CONTRACT}` : '')
  );
});