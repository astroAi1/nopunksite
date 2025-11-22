
// server.js
// NoPunks site server
// - Serves static files (if needed)
// - Proxies OpenSea for NFT metadata + stats + sales + listings
// - Uses token_map.json to map 0–9999 index -> real token ID
// - Exposes /api/showcase for daily rotating cross-collection picks

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// CONFIG
// -----------------------------
// Prefer OPENSEA_* envs if present (matches your .env),
// fall back to older names or hard-coded defaults.
const CHAIN =
  process.env.OPENSEA_CHAIN ||
  process.env.CHAIN ||
  'base';

const CONTRACT =
  process.env.OPENSEA_CONTRACT ||
  process.env.CONTRACT ||
  '0x4ed83635e2309a7c067d0f98efca47b920bf79b1'; // NoPunks contract

const COLLECTION_SLUG =
  process.env.OPENSEA_COLLECTION_SLUG ||
  process.env.COLLECTION_SLUG ||
  'nopunkism';

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

// Exact total supplies
const NOPUNKS_SUPPLY = 10000;
const NOPNUK_SUPPLY = 2024;
const NOPIXELPEPEN_SUPPLY = 3888;
const NOTINYDINOS_SUPPLY = 1000;

// Showcase config – one daily pick from each of these
const SHOWCASE_COLLECTIONS = [
  {
    key: 'nopunkism',
    label: 'NoPunks',
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
];

// Use env key if set, otherwise fall back to your provided key
const OPENSEA_API_KEY =
  process.env.OPENSEA_API_KEY || '62d4fdc803204dde8192c136b4c344cf';

if (!OPENSEA_API_KEY) {
  console.warn(
    'WARNING: OPENSEA_API_KEY is not set. OpenSea requests will likely fail.'
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
const tokenMapPath = path.join(__dirname, 'token_map.json');
let tokenMap = {};
try {
  tokenMap = JSON.parse(fs.readFileSync(tokenMapPath, 'utf8'));
} catch (err) {
  console.warn('Could not read token_map.json, using identity mapping.', err);
}

function indexToTokenId(index) {
  const key = String(index);
  const mapped = tokenMap[key];
  return mapped != null ? mapped : index;
}

// -----------------------------
// SIMPLE IN-MEMORY NFT CACHE
// -----------------------------
const nftCache = new Map();

// -----------------------------
// MIDDLEWARE
// -----------------------------
// CORS so nopunks.xyz (Netlify) and nopunksite.onrender.com can both call this API
app.use(
  cors({
    origin: '*',
    methods: ['GET'],
  })
);

// This lets you serve static files if you hit this server directly.
// (Your main site is on Netlify/Vercel; this doesn’t hurt.)
app.use(express.static(path.join(__dirname)));

// -----------------------------
// HELPERS
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
      setTimeout(processOpenSeaQueue, 250); // ~4 req/s max
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

    const payload = {
      ...nft,
      image_url,
      onChainId: nft.identifier || nft.token_id || tokenId,
    };

    nftCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('NFT API error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch NFT from OpenSea' });
  }
});

// =======================
// /api/collection
// (used by website.js for the main grid)
// =======================
app.get('/api/collection', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSizeRaw = parseInt(req.query.pageSize, 10) || 50;
    const pageSize = Math.min(Math.max(pageSizeRaw, 1), 50); // OpenSea limit 50
    const offset = (page - 1) * pageSize;

    const url =
      `https://api.opensea.io/api/v2/collection/${COLLECTION_SLUG}/nfts` +
      `?limit=${pageSize}&offset=${offset}&chain=${CHAIN}`;

    const data = await queueOpenSeaRequest(url, 'Collection page', 25000);

    const nfts = Array.isArray(data.nfts)
      ? data.nfts
      : Array.isArray(data.assets)
      ? data.assets
      : [];

    const tokens = nfts.map((nft) => {
      const image_url = normaliseImageUrl(
        nft.image_url ||
          nft.image_original_url ||
          nft.display_image_url ||
          (nft.media &&
            nft.media[0] &&
            (nft.media[0].thumbnail || nft.media[0].gateway)) ||
          ''
      );
      return { ...nft, image_url };
    });

    res.json({
      tokens,
      total: NOPUNKS_SUPPLY, // frontend already has fallback; we give the exact supply here
    });
  } catch (err) {
    console.error('Collection API error:', err.message || err);
    res.status(502).json({
      tokens: [],
      total: NOPUNKS_SUPPLY,
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

    // Match what website.js expects (various key names on top-level)
    res.json({
      // canonical
      floorPrice,
      totalVolume,
      numOwners,
      stats: rawStats,

      // aliases for the frontend helper
      floorPriceEth: floorPrice,
      floor_price_eth: floorPrice,
      floor_price: floorPrice,
      floor: floorPrice,

      totalVolumeEth: totalVolume,
      total_volume_eth: totalVolume,
      total_volume: totalVolume,
      volume: totalVolume,

      num_owners: numOwners,
      owners: numOwners,
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
// /api/recent-sales + alias /api/sales/recent
// =======================
async function handleRecentSales(req, res) {
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

      return {
        onChainId: tokenId,
        token_id: tokenId ? String(tokenId) : null, // for website.js getTokenId(...)
        price,
        unit: symbol,
        time,
        image_url,
      };
    });

    res.json({ sales });
  } catch (err) {
    console.error('Recent sales API error:', err.message || err);
    res.status(502).json({ sales: [], error: 'Recent sales unavailable' });
  }
}

app.get('/api/recent-sales', handleRecentSales);
app.get('/api/sales/recent', handleRecentSales); // alias used by website.js

// =======================
// /api/listed
// =======================
app.get('/api/listed', async (req, res) => {
  try {
    const url = `https://api.opensea.io/api/v2/listings/collection/${COLLECTION_SLUG}/all?limit=40&chain=${CHAIN}`;
    const data = await queueOpenSeaRequest(url, 'Listings');

    const rawListings = data.listings || [];

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

      return {
        onChainId: tokenId,
        token_id: tokenId ? String(tokenId) : null, // for website.js helper
        price,
        unit: 'ETH',
        source: 'OpenSea',
        image_url,
      };
    });

    // Enrich with images if needed
    const listingsWithImages = await Promise.all(
      mapped.map(async (item) => {
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

    const byToken = new Map();
    for (const lst of listingsWithImages) {
      if (!lst.onChainId) continue;
      const key = String(lst.onChainId);
      const existing = byToken.get(key);
      if (!existing || (lst.price != null && lst.price < existing.price)) {
        byToken.set(key, lst);
      }
    }

    const listings = Array.from(byToken.values());
    res.json({ listings });
  } catch (err) {
    console.error('Listings API error:', err.message || err);
    res.status(502).json({ listings: [], error: 'Listings unavailable' });
  }
});

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(
    `NoPunks server running at http://localhost:${PORT}\n` +
      `Collection slug: ${COLLECTION_SLUG} | Chain: ${CHAIN} | Contract: ${CONTRACT}`
  );
});