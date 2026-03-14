// server.js
// NoPunks site server
// - Serves static files (if needed)
// - Proxies OpenSea for NFT metadata + stats + sales + listings
// - Uses onchain token IDs directly (0–9999) unless USE_TOKEN_MAP=1
// - Exposes /api/showcase for daily rotating cross-collection picks
// - Exposes /api/etherscan/transfers for chain-level NoPunks data (via Etherscan/Basescan)

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const {
  renderWorld3dShareGif,
  renderWorld3dShareMp4,
} = require('./lib/world3d-share-export');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', true);

// Public web/API responses should not be interpreted loosely by browsers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '64kb' }));

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

const PUBLIC_SITE_ORIGIN = String(
  process.env.PUBLIC_SITE_ORIGIN || 'https://nopunks.xyz'
)
  .trim()
  .replace(/\/+$/, '');
const PUBLIC_API_VERSION = 'v2';
const PUBLIC_API_BASE_PATH = `/api/${PUBLIC_API_VERSION}`;
const PUBLIC_API_LEGACY_BASE_PATH = '/api/v1';
const PUBLIC_API_ROUTE_PREFIXES = [PUBLIC_API_BASE_PATH, PUBLIC_API_LEGACY_BASE_PATH];
const PUBLIC_API_DOCS_PATH = '/api';
const PUBLIC_API_OPENAPI_PATH = '/api/openapi.json';
const PUBLIC_SAMPLE_TOKEN_ID = 9967;
const PUBLIC_CHAIN_ID = 8453;
const PUBLIC_CHAIN_NAME = 'Base';
const PUBLIC_COLLECTION_NAME = 'No-Punks V2';
const PUBLIC_COLLECTION_SLUG = 'nopunks-v2';

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

const NOPUNKS_3D_POSTERS_DIR =
  process.env.NOPUNKS_3D_POSTERS_DIR ||
  path.join(__dirname, 'transparent');

const NOPUNKS_3D_MODELS_DIR =
  process.env.NOPUNKS_3D_MODELS_DIR ||
  path.join(__dirname, 'world3d-models');

const NOPUNKS_3D_SHARE_EXPORT_VERSION =
  process.env.NOPUNKS_3D_SHARE_EXPORT_VERSION || 'v5';
const NOPUNKS_3D_SHARE_GIF_MAX_BYTES = 24 * 1024 * 1024;

const NOPUNKS_3D_SHARE_EXPORT_ROOT_DIR =
  process.env.NOPUNKS_3D_SHARE_EXPORT_ROOT_DIR ||
  path.join(os.tmpdir(), 'nopunks-world3d-share');

const NOPUNKS_3D_SHARE_JOB_ROOT_DIR =
  process.env.NOPUNKS_3D_SHARE_JOB_ROOT_DIR ||
  path.join(os.tmpdir(), 'nopunks-world3d-share-jobs');

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
    useTokenMap: false,
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
const OPENSEA_API_KEY = String(process.env.OPENSEA_API_KEY || '').trim();

if (!OPENSEA_API_KEY) {
  console.warn(
    'WARNING: OPENSEA_API_KEY is not set. OpenSea requests will likely fail.'
  );
}

// Etherscan/Basescan API key (for on-chain data)
const ETHERSCAN_API_KEY = String(process.env.ETHERSCAN_API_KEY || '').trim();

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
// Default is identity mapping (onchain token IDs). Enable remap only when explicitly needed.
const USE_TOKEN_MAP = /^(1|true|yes)$/i.test(String(process.env.USE_TOKEN_MAP || '').trim());
const tokenMapPath = path.join(__dirname, 'public', 'token_map.json');
let tokenMap = {};
if (USE_TOKEN_MAP) {
  try {
    tokenMap = JSON.parse(fs.readFileSync(tokenMapPath, 'utf8'));
  } catch (err) {
    console.warn('Could not read public/token_map.json, using identity mapping.', err);
  }
}

function indexToTokenId(index) {
  if (!USE_TOKEN_MAP) return index;
  const key = String(index);
  const mapped = tokenMap[key];
  return mapped != null ? mapped : index;
}

function parseOnChainTokenId(value) {
  const tokenId = parseInt(String(value), 10);
  if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId >= NOPUNKS_SUPPLY) {
    return null;
  }
  return tokenId;
}

// Reverse token map: on-chain tokenId -> 0–9999 collection index
const reverseTokenMap = {};
try {
  if (USE_TOKEN_MAP) {
    Object.keys(tokenMap).forEach((idx) => {
      const mapped = tokenMap[idx];
      if (mapped != null) {
        reverseTokenMap[String(mapped)] = Number(idx);
      }
    });
  }

  // Identity fallback for all onchain token IDs.
  for (let i = 0; i < NOPUNKS_SUPPLY; i++) {
    const key = String(i);
    if (reverseTokenMap[key] == null) {
      reverseTokenMap[key] = i;
    }
  }
} catch (e) {
  console.warn('Failed to build reverseTokenMap from token_map.json', e);
}

function getCollectionIndexForTokenId(tokenId) {
  if (!Number.isInteger(tokenId)) return null;
  const idx = reverseTokenMap[String(tokenId)];
  return Number.isInteger(idx) ? idx : null;
}

// -----------------------------
// TRAITS INDEX – local canonical traits for hover + stats
// -----------------------------
const traitsIndexPath = path.join(__dirname, 'public', 'traits', 'traits_index.json');
const USE_LOCAL_TRAITS_INDEX = /^(1|true|yes)$/i.test(
  String(process.env.USE_LOCAL_TRAITS_INDEX || '').trim()
);
let traitsIndex = null;
let traitsIndexIsArray = false;

if (USE_LOCAL_TRAITS_INDEX) {
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
}

function normaliseTraitsEntry(entry) {
  if (!entry) return null;
  if (Array.isArray(entry.traits)) return entry.traits;
  if (Array.isArray(entry.attributes)) return entry.attributes;
  if (Array.isArray(entry)) return entry;
  return null;
}

// -----------------------------
// PRECOMPUTED DATA FILES
// -----------------------------
const explorerTraitIndexPath = path.join(
  __dirname,
  'public',
  'data',
  'explorer',
  'trait_to_token_ids.json'
);

const explorerTokenBlobPath = path.join(
  __dirname,
  'public',
  'data',
  'explorer',
  'token_trait_blob.json'
);

const explorerPublicDir = path.join(__dirname, 'public', 'data', 'explorer');
const explorerPublicImagesDir = path.join(explorerPublicDir, 'images');
const explorerPublishedDir = path.join(__dirname, 'explorer-data');
const explorerPublishedImagesDir = path.join(explorerPublishedDir, 'images');

const onchainTraitsSnapshotPath = path.join(
  __dirname,
  'public',
  'data',
  'explorer',
  'onchain_traits.json'
);

const publicTraitTypesPath = path.join(
  __dirname,
  'public',
  'traits',
  'trait_types.json'
);

const publicTraitValuesPath = path.join(
  __dirname,
  'public',
  'traits',
  'trait_values_by_type.json'
);

const holderLatestPath = path.join(
  __dirname,
  'public',
  'data',
  'holders',
  'latest.json'
);

const holderHistoryPath = path.join(
  __dirname,
  'public',
  'data',
  'holders',
  'history.json'
);

function parsePositiveIntEnv(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const HOLDER_AUTO_REBUILD_ENABLED = /^(1|true|yes)$/i.test(
  String(process.env.HOLDER_AUTO_REBUILD || 'true').trim()
);
const HOLDER_AUTO_REBUILD_INTERVAL_MS = parsePositiveIntEnv(
  'HOLDER_AUTO_REBUILD_INTERVAL_MS',
  10 * 60 * 1000,
  60 * 1000
);
const HOLDER_AUTO_REBUILD_STARTUP_DELAY_MS = parsePositiveIntEnv(
  'HOLDER_AUTO_REBUILD_STARTUP_DELAY_MS',
  25 * 1000,
  0
);
const HOLDER_AUTO_REBUILD_RETRY_DELAY_MS = parsePositiveIntEnv(
  'HOLDER_AUTO_REBUILD_RETRY_DELAY_MS',
  2 * 60 * 1000,
  15 * 1000
);
const HOLDER_AUTO_REBUILD_TIMEOUT_MS = parsePositiveIntEnv(
  'HOLDER_AUTO_REBUILD_TIMEOUT_MS',
  20 * 60 * 1000,
  60 * 1000
);
const HOLDER_AUTO_REBUILD_OWNER_BATCH_SIZE = parsePositiveIntEnv(
  'HOLDER_AUTO_REBUILD_OWNER_BATCH_SIZE',
  parsePositiveIntEnv('HOLDER_OWNER_BATCH_SIZE', 120, 10),
  10
);
const HOLDER_AUTO_REBUILD_SUPPLY = parsePositiveIntEnv(
  'HOLDER_AUTO_REBUILD_SUPPLY',
  10000,
  1
);
const HOLDER_AUTO_REBUILD_SOURCE = String(
  process.env.HOLDER_AUTO_REBUILD_SOURCE || 'owners'
).trim() || 'owners';
const HOLDER_AUTO_REBUILD_RPC_URL = String(
  process.env.HOLDER_AUTO_REBUILD_RPC_URLS ||
    process.env.HOLDER_RPC_URLS ||
    process.env.BASE_RPC_URL ||
    'https://base.llamarpc.com,https://base-rpc.publicnode.com,https://1rpc.io/base,https://mainnet.base.org'
).trim();
const HOLDER_LIVE_MODE_ENABLED = /^(1|true|yes)$/i.test(
  String(process.env.HOLDER_LIVE_MODE || 'true').trim()
);
const HOLDER_LIVE_CACHE_TTL_MS = parsePositiveIntEnv(
  'HOLDER_LIVE_CACHE_TTL_MS',
  60 * 1000,
  10 * 1000
);
const HOLDER_LIVE_BATCH_SIZE = parsePositiveIntEnv(
  'HOLDER_LIVE_BATCH_SIZE',
  150,
  10,
  300
);
const HOLDER_LIVE_RPC_TIMEOUT_MS = parsePositiveIntEnv(
  'HOLDER_LIVE_RPC_TIMEOUT_MS',
  20 * 1000,
  4 * 1000,
  120 * 1000
);
const HOLDER_LIVE_FORCE_REFRESH_ON_LOOKUP = /^(1|true|yes)$/i.test(
  String(process.env.HOLDER_LIVE_FORCE_REFRESH_ON_LOOKUP || 'true').trim()
);

const OPENSEA_QUEUE_DELAY_MS = parsePositiveIntEnv(
  'OPENSEA_QUEUE_DELAY_MS',
  120,
  60,
  2000
);
const OPENSEA_STATS_CACHE_TTL_MS = parsePositiveIntEnv(
  'OPENSEA_STATS_CACHE_TTL_MS',
  2 * 60 * 1000,
  10 * 1000
);
const OPENSEA_RECENT_SALES_CACHE_TTL_MS = parsePositiveIntEnv(
  'OPENSEA_RECENT_SALES_CACHE_TTL_MS',
  45 * 1000,
  10 * 1000
);
const OPENSEA_LISTINGS_CACHE_TTL_MS = parsePositiveIntEnv(
  'OPENSEA_LISTINGS_CACHE_TTL_MS',
  60 * 1000,
  10 * 1000
);
const OPENSEA_SHOWCASE_CACHE_TTL_MS = parsePositiveIntEnv(
  'OPENSEA_SHOWCASE_CACHE_TTL_MS',
  15 * 60 * 1000,
  60 * 1000
);
const LISTED_DEFAULT_MAX_PAGES = parsePositiveIntEnv(
  'LISTED_DEFAULT_MAX_PAGES',
  2,
  1,
  10
);
const LISTED_MAX_PAGES_CAP = parsePositiveIntEnv(
  'LISTED_MAX_PAGES_CAP',
  5,
  1,
  20
);
const LISTED_DEFAULT_RESULT_LIMIT = parsePositiveIntEnv(
  'LISTED_DEFAULT_RESULT_LIMIT',
  80,
  8,
  400
);
const LISTED_RESULT_LIMIT_CAP = parsePositiveIntEnv(
  'LISTED_RESULT_LIMIT_CAP',
  200,
  8,
  500
);
const LISTED_PAGE_SIZE_DEFAULT = parsePositiveIntEnv(
  'LISTED_PAGE_SIZE_DEFAULT',
  50,
  20,
  50
);
const SHOWCASE_DEBUG_LOGS =
  /^(1|true|yes)$/i.test(String(process.env.SHOWCASE_DEBUG_LOGS || '').trim()) ||
  String(process.env.NODE_ENV || '').trim().toLowerCase() === 'development';

const fileJsonCache = new Map(); // filePath -> { mtimeMs, value }

function readJsonFileCached(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const mtimeMs = stat.mtimeMs;
    const cached = fileJsonCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.value;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const value = JSON.parse(raw);
    fileJsonCache.set(filePath, { mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').trim();
  const proto = forwardedProto || req.protocol || 'https';
  const host = String(req.get('host') || '').trim();
  return host ? `${proto}://${host}` : PUBLIC_SITE_ORIGIN;
}

function toAbsoluteUrl(origin, resourcePath) {
  const base = String(origin || PUBLIC_SITE_ORIGIN).replace(/\/+$/, '');
  const target = String(resourcePath || '').trim();
  if (!target) return base;
  if (/^https?:\/\//i.test(target)) return target;
  return `${base}${target.startsWith('/') ? '' : '/'}${target}`;
}

function setPublicCacheControl(res, value) {
  res.setHeader('Cache-Control', value);
}

function sendPublicApiError(res, statusCode, error, message, extra = {}) {
  return res.status(statusCode).json({
    status: statusCode,
    error,
    message,
    contract: CONTRACT,
    chain: CHAIN,
    ...extra,
  });
}

function isPublicCorsPath(requestPath) {
  const pathName = String(requestPath || '').trim();
  return (
    pathName === PUBLIC_API_OPENAPI_PATH ||
    pathName === '/llms.txt' ||
    PUBLIC_API_ROUTE_PREFIXES.some(
      (basePath) => pathName === basePath || pathName.startsWith(`${basePath}/`)
    )
  );
}

function getPublicApiRoutePaths(routeSuffix = '') {
  return PUBLIC_API_ROUTE_PREFIXES.map((basePath) => `${basePath}${routeSuffix}`);
}

app.use((req, res, next) => {
  if (!isPublicCorsPath(req.path)) {
    return next();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

function getRateLimitClientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimitMiddleware(name, windowMs, maxRequests) {
  const buckets = new Map();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = `${name}:${getRateLimitClientKey(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return next();
    }

    if (bucket.count >= maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return sendPublicApiError(
        res,
        429,
        'rate_limit_exceeded',
        'Rate limit exceeded. Please retry shortly.',
        { retryAfterSeconds }
      );
    }

    bucket.count += 1;

    if (buckets.size > 20000) {
      for (const [bucketKey, value] of buckets.entries()) {
        if (now >= value.resetAt) {
          buckets.delete(bucketKey);
        }
      }
    }

    return next();
  };
}

const publicCoreRateLimit = createRateLimitMiddleware('public-core', 60 * 1000, 120);
const publicLiveRateLimit = createRateLimitMiddleware('public-live', 60 * 1000, 30);
const legacyReadRateLimit = createRateLimitMiddleware('legacy-read', 60 * 1000, 240);
const legacyMutationRateLimit = createRateLimitMiddleware('legacy-mutation', 60 * 1000, 24);

function isLegacyApiPath(requestPath) {
  const pathName = String(requestPath || '').trim();
  return pathName.startsWith('/api/') && !isPublicCorsPath(pathName);
}

function normalizeOriginValue(value) {
  try {
    return new URL(String(value || '').trim()).origin;
  } catch {
    return '';
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === '::1'
  );
}

function isAllowedSiteOrigin(req) {
  const origin = normalizeOriginValue(req.headers.origin);
  if (!origin) return false;

  const requestOrigin = normalizeOriginValue(getRequestOrigin(req));
  const publicOrigin = normalizeOriginValue(PUBLIC_SITE_ORIGIN);
  if (origin === requestOrigin || origin === publicOrigin) {
    return true;
  }

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(requestOrigin || PUBLIC_SITE_ORIGIN);
    return isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(requestUrl.hostname);
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  if (!isLegacyApiPath(req.path)) {
    return next();
  }

  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'GET' || req.method === 'HEAD') {
    return legacyReadRateLimit(req, res, next);
  }

  return next();
});

app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/api/3d/export') {
    return next();
  }

  if (!isAllowedSiteOrigin(req)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'This route is only available from the No-Punks site.',
    });
  }

  return legacyMutationRateLimit(req, res, next);
});

let publicTraitCatalogCache = {
  traitTypesRef: null,
  traitValuesRef: null,
  catalog: null,
};

function getPublicTraitCatalog() {
  const traitTypesRaw = readJsonFileCached(publicTraitTypesPath);
  const traitValuesRaw = readJsonFileCached(publicTraitValuesPath);
  if (!Array.isArray(traitTypesRaw) || !traitValuesRaw || typeof traitValuesRaw !== 'object') {
    return null;
  }

  if (
    publicTraitCatalogCache.traitTypesRef === traitTypesRaw &&
    publicTraitCatalogCache.traitValuesRef === traitValuesRaw &&
    publicTraitCatalogCache.catalog
  ) {
    return publicTraitCatalogCache.catalog;
  }

  const traitTypes = traitTypesRaw
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const traitTypeSet = new Set(traitTypes);
  const traitTypeLookup = new Map(
    traitTypes.map((traitType) => [traitType.toLowerCase(), traitType])
  );

  const typeValues = {};
  const valueLookupByType = {};
  traitTypes.forEach((traitType) => {
    const values = Array.isArray(traitValuesRaw[traitType])
      ? traitValuesRaw[traitType]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      : [];
    typeValues[traitType] = values;
    valueLookupByType[traitType] = new Map(
      values.map((value) => [value.toLowerCase(), value])
    );
  });

  const catalog = {
    traitTypes,
    traitTypeSet,
    traitTypeLookup,
    typeValues,
    valueLookupByType,
  };

  publicTraitCatalogCache = {
    traitTypesRef: traitTypesRaw,
    traitValuesRef: traitValuesRaw,
    catalog,
  };
  return catalog;
}

function filterPublicAttributes(attributes) {
  const catalog = getPublicTraitCatalog();
  const traitTypeSet = catalog?.traitTypeSet || null;

  return (Array.isArray(attributes) ? attributes : [])
    .map((entry) => {
      const trait_type = String(entry?.trait_type || entry?.type || '').trim();
      const value = String(entry?.value ?? '').trim();
      if (!trait_type || !value) return null;
      if (trait_type === 'Attribute Count') return null;
      if (trait_type.startsWith('(')) return null;
      if (traitTypeSet && !traitTypeSet.has(trait_type)) return null;
      return { trait_type, value };
    })
    .filter(Boolean);
}

function getPublicTokenBlobPayload() {
  const payload = readJsonFileCached(explorerTokenBlobPath);
  if (!payload || !Array.isArray(payload.tokens)) return null;
  return payload;
}

let publicTokenBlobLookupCache = {
  sourceRef: null,
  byTokenId: null,
};

function getPublicTokenBlobLookup() {
  const payload = getPublicTokenBlobPayload();
  if (!payload) return null;

  if (
    publicTokenBlobLookupCache.sourceRef === payload &&
    publicTokenBlobLookupCache.byTokenId instanceof Map
  ) {
    return publicTokenBlobLookupCache.byTokenId;
  }

  const byTokenId = new Map();
  payload.tokens.forEach((entry) => {
    const tokenId = Number.parseInt(String(entry?.id ?? entry?.i), 10);
    if (!Number.isFinite(tokenId)) return;
    byTokenId.set(String(tokenId), entry);
  });

  publicTokenBlobLookupCache = {
    sourceRef: payload,
    byTokenId,
  };
  return byTokenId;
}

function getPublicTokenBlobEntry(tokenId) {
  const lookup = getPublicTokenBlobLookup();
  if (!(lookup instanceof Map)) return null;
  return lookup.get(String(tokenId)) || null;
}

function getPublicExplorerImagePath(tokenId, tokenEntry) {
  const candidates = [
    tokenEntry?.im,
    `/public/data/explorer/images/${tokenId}.svg`,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeIpfsUri(candidate);
    if (isLocalPublicPath(normalized) && doesLocalPublicAssetExist(normalized)) {
      return normalized;
    }
  }

  return '';
}

function getPublicTokenAttributes(tokenId) {
  const snapshotMeta = getOnchainSnapshotMetadata(tokenId);
  if (snapshotMeta) {
    const attributes = filterPublicAttributes(snapshotMeta.attributes);
    if (attributes.length) return attributes;
  }

  const tokenEntry = getPublicTokenBlobEntry(tokenId);
  const blobAttributes = normalizeOnchainTupleTraits(tokenEntry?.t || []);
  return filterPublicAttributes(blobAttributes);
}

function buildPublicTokenSearchText(tokenId, name, attributes) {
  const terms = [name, String(tokenId), `#${tokenId}`];
  attributes.forEach((attribute) => {
    terms.push(attribute.trait_type, attribute.value, `${attribute.trait_type} ${attribute.value}`);
  });
  return terms.join(' ').toLowerCase();
}

let publicSearchIndexCache = {
  tokenBlobRef: null,
  records: null,
};

function getPublicSearchIndex() {
  const payload = getPublicTokenBlobPayload();
  if (!payload) return null;

  if (
    publicSearchIndexCache.tokenBlobRef === payload &&
    Array.isArray(publicSearchIndexCache.records)
  ) {
    return publicSearchIndexCache.records;
  }

  const records = payload.tokens
    .map((entry) => {
      const tokenId = Number.parseInt(String(entry?.id ?? entry?.i), 10);
      if (!Number.isFinite(tokenId)) return null;
      const name = String(entry?.n || `No-Punk #${tokenId}`);
      const attributes = getPublicTokenAttributes(tokenId);
      return {
        tokenId,
        name,
        attributes,
        searchText: buildPublicTokenSearchText(tokenId, name, attributes),
      };
    })
    .filter(Boolean);

  publicSearchIndexCache = {
    tokenBlobRef: payload,
    records,
  };
  return records;
}

function resolvePublicTraitType(rawTraitType) {
  const catalog = getPublicTraitCatalog();
  if (!catalog) return null;
  return catalog.traitTypeLookup.get(String(rawTraitType || '').trim().toLowerCase()) || null;
}

function resolvePublicTraitValue(traitType, rawValue) {
  const catalog = getPublicTraitCatalog();
  const lookup = catalog?.valueLookupByType?.[traitType];
  if (!(lookup instanceof Map)) return null;
  return lookup.get(String(rawValue || '').trim().toLowerCase()) || null;
}

function getPublicTraitTokenIds(traitType, traitValue) {
  const traitIndex = readJsonFileCached(explorerTraitIndexPath);
  const ids = traitIndex?.traitToTokenIds?.[`${traitType}|${traitValue}`];
  return Array.isArray(ids)
    ? ids
        .map((value) => Number.parseInt(String(value), 10))
        .filter((value) => Number.isFinite(value))
    : [];
}

function getPublicTokenLinks(req, tokenId) {
  const origin = getRequestOrigin(req);
  return {
    api: toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/tokens/${tokenId}`),
    image: toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/tokens/${tokenId}/image`),
    website: toAbsoluteUrl(origin, `/#collection`),
    opensea: `https://opensea.io/assets/base/${CONTRACT}/${tokenId}`,
  };
}

function buildPublicTokenResponse(req, tokenId) {
  const tokenEntry = getPublicTokenBlobEntry(tokenId);
  const snapshotMeta = getOnchainSnapshotMetadata(tokenId);
  const name = String(
    snapshotMeta?.name ||
      tokenEntry?.n ||
      `No-Punk #${tokenId}`
  );
  const attributes = getPublicTokenAttributes(tokenId);
  const imageAssetPath = getPublicExplorerImagePath(tokenId, tokenEntry);
  const origin = getRequestOrigin(req);

  return {
    tokenId,
    name,
    collection: PUBLIC_COLLECTION_NAME,
    contract: CONTRACT,
    chain: CHAIN,
    chainId: PUBLIC_CHAIN_ID,
    image: toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/tokens/${tokenId}/image`),
    imageAsset: imageAssetPath ? toAbsoluteUrl(origin, imageAssetPath) : null,
    attributes,
    links: getPublicTokenLinks(req, tokenId),
    source: {
      type: imageAssetPath ? 'local-snapshot' : snapshotMeta?.source || 'onchain-tokenURI',
      generatedAt:
        getPublicTokenBlobPayload()?.generatedAt ||
        readJsonFileCached(onchainTraitsSnapshotPath)?.generatedAt ||
        null,
    },
  };
}

function buildPublicDatasetManifest(req) {
  const origin = getRequestOrigin(req);
  const onchainTraits = readJsonFileCached(onchainTraitsSnapshotPath);
  const tokenBlob = getPublicTokenBlobPayload();
  const traitIndex = readJsonFileCached(explorerTraitIndexPath);

  return {
    generatedAt:
      onchainTraits?.generatedAt ||
      tokenBlob?.generatedAt ||
      traitIndex?.generatedAt ||
      null,
    items: [
      {
        id: 'onchain-traits',
        label: 'Onchain traits snapshot',
        format: 'json',
        url: toAbsoluteUrl(origin, '/public/data/explorer/onchain_traits.json'),
        generatedAt: onchainTraits?.generatedAt || null,
      },
      {
        id: 'token-search-blob',
        label: 'Token search blob',
        format: 'json',
        url: toAbsoluteUrl(origin, '/public/data/explorer/token_trait_blob.json'),
        generatedAt: tokenBlob?.generatedAt || null,
      },
      {
        id: 'trait-index',
        label: 'Trait to token index',
        format: 'json',
        url: toAbsoluteUrl(origin, '/public/data/explorer/trait_to_token_ids.json'),
        generatedAt: traitIndex?.generatedAt || null,
      },
      {
        id: 'images',
        label: 'Published SVG image base',
        format: 'svg',
        url: toAbsoluteUrl(origin, '/public/data/explorer/images/'),
        generatedAt: onchainTraits?.generatedAt || null,
      },
    ],
  };
}

function buildPublicCollectionResponse(req) {
  const origin = getRequestOrigin(req);
  const datasets = buildPublicDatasetManifest(req);

  return {
    name: PUBLIC_COLLECTION_NAME,
    slug: PUBLIC_COLLECTION_SLUG,
    contract: CONTRACT,
    chain: CHAIN,
    chainId: PUBLIC_CHAIN_ID,
    network: PUBLIC_CHAIN_NAME,
    totalSupply: NOPUNKS_SUPPLY,
    docs: toAbsoluteUrl(origin, PUBLIC_API_DOCS_PATH),
    api: toAbsoluteUrl(origin, PUBLIC_API_BASE_PATH),
    openapi: toAbsoluteUrl(origin, PUBLIC_API_OPENAPI_PATH),
    llms: toAbsoluteUrl(origin, '/llms.txt'),
    sampleTokenId: PUBLIC_SAMPLE_TOKEN_ID,
    sampleToken: toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/tokens/${PUBLIC_SAMPLE_TOKEN_ID}`),
    imageBase: toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/tokens/`),
    datasets: datasets.items,
    licensing: {
      usage: 'CC0 / CCO',
      note: 'Public NoPunks V2 collection infrastructure for builders, archives, and community tools.',
    },
  };
}

let onchainTraitsLookupCache = {
  sourceRef: null,
  byTokenId: null,
};

function normalizeOnchainTupleTraits(attrs) {
  return (Array.isArray(attrs) ? attrs : [])
    .map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const trait_type = String(pair[0] || '').trim();
      const value = String(pair[1] || '').trim();
      if (!trait_type || !value) return null;
      return { trait_type, value };
    })
    .filter(Boolean);
}

function getOnchainTraitsLookupMap() {
  const payload = readJsonFileCached(onchainTraitsSnapshotPath);
  if (!payload || !Array.isArray(payload.tokens)) return null;

  if (
    onchainTraitsLookupCache.sourceRef === payload &&
    onchainTraitsLookupCache.byTokenId instanceof Map
  ) {
    return onchainTraitsLookupCache.byTokenId;
  }

  const byTokenId = new Map();
  payload.tokens.forEach((entry) => {
    if (!entry || entry.id == null) return;
    byTokenId.set(String(entry.id), entry);
  });

  onchainTraitsLookupCache = {
    sourceRef: payload,
    byTokenId,
  };
  return byTokenId;
}

function getOnchainSnapshotMetadata(tokenId) {
  const lookup = getOnchainTraitsLookupMap();
  if (!(lookup instanceof Map)) return null;

  const entry = lookup.get(String(tokenId));
  if (!entry || typeof entry !== 'object') return null;

  const attributes = normalizeOnchainTupleTraits(entry.a || entry.attributes || entry.traits);
  const image = normalizeIpfsUri(entry.im || entry.image || entry.image_url || '');

  return {
    tokenId,
    tokenURI: '',
    name: String(entry.n || entry.name || `No-Punk #${tokenId}`),
    description: '',
    attributes,
    image,
    image_data: '',
    external_url: '',
    raw: { attributes, image },
    source: 'onchain-traits-snapshot',
  };
}

function normaliseAddress(addr) {
  if (!addr) return '';
  const value = String(addr).trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(value) ? value : '';
}

const HOLDER_OWNER_OF_SELECTOR = '6352211e';
const HOLDER_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
let holderLiveRpcIdCounter = 1;

const holderLiveState = {
  snapshot: null,
  previousSnapshot: null,
  generatedAtMs: 0,
  inflight: null,
  lastError: null,
  refreshCount: 0,
};

function parseHexInt(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim();
  if (!text) return 0;
  const n = text.startsWith('0x')
    ? Number.parseInt(text.slice(2), 16)
    : Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

function getHolderLiveRpcCandidates() {
  const configured = String(
    process.env.HOLDER_LIVE_RPC_URLS || process.env.HOLDER_RPC_URLS || ''
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const fallback = Array.isArray(ONCHAIN_RPC_URLS) ? ONCHAIN_RPC_URLS : [];
  const seen = new Set();
  const merged = [];
  [...configured, ...fallback].forEach((url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    merged.push(url);
  });
  return merged;
}

function getHolderLiveTokenIds() {
  if (!USE_TOKEN_MAP || !tokenMap || typeof tokenMap !== 'object') {
    return Array.from({ length: NOPUNKS_SUPPLY }, (_, idx) => idx);
  }

  const ids = Object.keys(tokenMap)
    .map((key) => Number.parseInt(String(key), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((index) => {
      const mapped = tokenMap[String(index)];
      const parsed = Number.parseInt(String(mapped), 10);
      return Number.isFinite(parsed) ? parsed : index;
    });

  if (!ids.length) {
    return Array.from({ length: NOPUNKS_SUPPLY }, (_, idx) => idx);
  }

  return Array.from(new Set(ids));
}

function encodeHolderOwnerOfCall(tokenId) {
  const n = Number(tokenId);
  if (!Number.isFinite(n) || n < 0) return null;
  return `0x${HOLDER_OWNER_OF_SELECTOR}${n.toString(16).padStart(64, '0')}`;
}

function parseHolderOwnerOfResult(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (hex.length < 40) return '';
  return normaliseAddress(`0x${hex.slice(-40)}`);
}

async function callRpcJson(rpcUrl, method, params, timeoutMs = HOLDER_LIVE_RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      jsonrpc: '2.0',
      id: holderLiveRpcIdCounter++,
      method,
      params,
    };

    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RPC ${method} failed (${res.status}): ${text.slice(0, 180)}`);
    }

    const json = await res.json();
    if (json && json.error) {
      const msg = json.error.message || JSON.stringify(json.error);
      throw new Error(`RPC ${method} error: ${msg}`);
    }

    return json && Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callRpcBatchJson(rpcUrl, calls, timeoutMs = HOLDER_LIVE_RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = calls.map((call) => ({
      jsonrpc: '2.0',
      id: call.id,
      method: call.method,
      params: call.params,
    }));

    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RPC batch failed (${res.status}): ${text.slice(0, 180)}`);
    }

    const json = await res.json();
    if (!Array.isArray(json)) {
      throw new Error('RPC batch returned non-array result');
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function callRpcWithFallback(rpcUrls, method, params) {
  let lastErr = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const result = await callRpcJson(rpcUrl, method, params);
      return { result, rpcUrl };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `All RPC endpoints failed for ${method}. Last error: ${String(lastErr?.message || lastErr)}`
  );
}

async function callRpcBatchWithFallback(rpcUrls, calls) {
  let lastErr = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const result = await callRpcBatchJson(rpcUrl, calls);
      return { result, rpcUrl };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `All RPC endpoints failed for batch call. Last error: ${String(lastErr?.message || lastErr)}`
  );
}

async function fetchLiveHolderOwnerEntries() {
  const rpcUrls = getHolderLiveRpcCandidates();
  if (!rpcUrls.length) {
    throw new Error('No RPC URL available for live holder mode.');
  }

  const tokenIds = getHolderLiveTokenIds();
  const contract = normaliseAddress(CONTRACT);
  if (!contract) {
    throw new Error(`Invalid contract address: ${CONTRACT}`);
  }

  const latestBlockResult = await callRpcWithFallback(rpcUrls, 'eth_blockNumber', []);
  const latestBlock = parseHexInt(latestBlockResult.result);
  const ownerEntries = [];
  const unresolvedTokenIds = [];
  const batchSize = Math.max(10, Number(HOLDER_LIVE_BATCH_SIZE) || 150);

  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const slice = tokenIds.slice(i, i + batchSize);
    const calls = [];

    slice.forEach((tokenId) => {
      const data = encodeHolderOwnerOfCall(tokenId);
      if (!data) return;
      calls.push({
        id: `${i}:${tokenId}`,
        method: 'eth_call',
        params: [{ to: contract, data }, 'latest'],
        tokenId,
      });
    });

    const rpcResponse = await callRpcBatchWithFallback(rpcUrls, calls);
    const rowsById = new Map();
    rpcResponse.result.forEach((row) => {
      rowsById.set(String(row.id), row);
    });

    calls.forEach((call) => {
      const row = rowsById.get(String(call.id));
      if (!row || row.error) {
        unresolvedTokenIds.push(call.tokenId);
        return;
      }

      const owner = parseHolderOwnerOfResult(row.result);
      if (!owner || owner === HOLDER_ZERO_ADDRESS) {
        unresolvedTokenIds.push(call.tokenId);
        return;
      }
      ownerEntries.push({ tokenId: call.tokenId, owner });
    });
  }

  if (unresolvedTokenIds.length) {
    for (let i = 0; i < unresolvedTokenIds.length; i += 1) {
      const tokenId = unresolvedTokenIds[i];
      const data = encodeHolderOwnerOfCall(tokenId);
      if (!data) continue;

      let resolvedOwner = '';
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const rpcResponse = await callRpcWithFallback(rpcUrls, 'eth_call', [
            { to: contract, data },
            'latest',
          ]);
          resolvedOwner = parseHolderOwnerOfResult(rpcResponse.result);
          if (resolvedOwner && resolvedOwner !== HOLDER_ZERO_ADDRESS) break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!resolvedOwner || resolvedOwner === HOLDER_ZERO_ADDRESS) {
        throw new Error(
          `ownerOf unresolved for token ${tokenId}: ${String(lastErr?.message || lastErr || 'unknown')}`
        );
      }
      ownerEntries.push({ tokenId, owner: resolvedOwner });
    }
  }

  const coverageSet = new Set(ownerEntries.map((entry) => String(entry.tokenId)));
  const missingCoverage = tokenIds.filter((tokenId) => !coverageSet.has(String(tokenId)));
  if (missingCoverage.length) {
    throw new Error(
      `ownerOf coverage mismatch: missing ${missingCoverage.length} token IDs (first few: ${missingCoverage
        .slice(0, 12)
        .join(', ')})`
    );
  }

  return {
    tokenIds,
    ownerEntries,
    source: {
      type: 'live-rpc-ownerOf',
      rpcUrls,
      chainId: String(ONCHAIN_CHAIN_ID || ''),
      totalSupply: tokenIds.length,
      ownerReads: ownerEntries.length,
      latestBlock,
      batchSize,
      tokenIdSource: USE_TOKEN_MAP ? 'token-map' : 'onchain-range',
      tokenMapPath: USE_TOKEN_MAP ? tokenMapPath : null,
    },
  };
}

function buildLiveHolderSnapshotFromOwnerEntries(payload) {
  const ownerEntries = Array.isArray(payload?.ownerEntries) ? payload.ownerEntries : [];
  const source = payload?.source || {};
  const holdersByAddress = new Map();

  ownerEntries.forEach((entry) => {
    const address = normaliseAddress(entry.owner);
    const tokenId = Number.parseInt(String(entry.tokenId), 10);
    if (!address || !Number.isFinite(tokenId)) return;

    if (!holdersByAddress.has(address)) {
      holdersByAddress.set(address, {
        address,
        balance: 0,
        tokenIds: [],
        lastActivity: null,
      });
    }
    const holder = holdersByAddress.get(address);
    holder.balance += 1;
    holder.tokenIds.push(tokenId);
  });

  const holders = Array.from(holdersByAddress.values())
    .map((holder) => ({
      ...holder,
      tokenIds: holder.tokenIds.sort((a, b) => a - b),
    }))
    .sort((a, b) => {
      if (b.balance !== a.balance) return b.balance - a.balance;
      return a.address.localeCompare(b.address);
    });

  const supplyAccounted = holders.reduce((sum, holder) => sum + holder.balance, 0);
  const holderCount = holders.length;
  const top10Tokens = holders.slice(0, 10).reduce((sum, holder) => sum + holder.balance, 0);
  const top25Tokens = holders.slice(0, 25).reduce((sum, holder) => sum + holder.balance, 0);
  const top10SharePct =
    supplyAccounted > 0 ? Number(((top10Tokens / supplyAccounted) * 100).toFixed(3)) : 0;
  const top25SharePct =
    supplyAccounted > 0 ? Number(((top25Tokens / supplyAccounted) * 100).toFixed(3)) : 0;
  const avgTokensPerHolder =
    holderCount > 0 ? Number((supplyAccounted / holderCount).toFixed(4)) : 0;

  const topHolders = holders.slice(0, 250).map((holder, idx) => ({
    rank: idx + 1,
    address: holder.address,
    balance: holder.balance,
    shareOfSupplyPct:
      supplyAccounted > 0
        ? Number(((holder.balance / supplyAccounted) * 100).toFixed(3))
        : 0,
    tokenPreview: holder.tokenIds.slice(0, 12),
    lastActivity: holder.lastActivity,
  }));

  const summary = {
    holderCount,
    supplyAccounted,
    top10SharePct,
    top25SharePct,
    avgTokensPerHolder,
  };

  return {
    generatedAt: new Date().toISOString(),
    chain: CHAIN,
    contract: CONTRACT,
    source,
    summary,
    cohorts: buildCohortsFromHolders(holders, supplyAccounted),
    topHolders,
    holders,
  };
}

async function refreshLiveHolderSnapshot(reason = 'manual') {
  if (!HOLDER_LIVE_MODE_ENABLED) {
    return null;
  }
  if (holderLiveState.inflight) {
    return holderLiveState.inflight;
  }

  holderLiveState.inflight = (async () => {
    const startedAt = Date.now();
    const payload = await fetchLiveHolderOwnerEntries();
    const snapshot = buildLiveHolderSnapshotFromOwnerEntries(payload);
    snapshot.source = {
      ...(snapshot.source || {}),
      mode: 'live',
      refreshReason: reason,
      refreshDurationMs: Date.now() - startedAt,
      refreshCount: holderLiveState.refreshCount + 1,
    };

    holderLiveState.previousSnapshot = holderLiveState.snapshot;
    holderLiveState.snapshot = snapshot;
    holderLiveState.generatedAtMs = Date.now();
    holderLiveState.lastError = null;
    holderLiveState.refreshCount += 1;
    return snapshot;
  })()
    .catch((err) => {
      holderLiveState.lastError = err;
      throw err;
    })
    .finally(() => {
      holderLiveState.inflight = null;
    });

  return holderLiveState.inflight;
}

async function getLiveHolderSnapshot(options = {}) {
  if (!HOLDER_LIVE_MODE_ENABLED) {
    return null;
  }

  const requireFresh = Boolean(options.requireFresh);
  const now = Date.now();
  const hasSnapshot = holderLiveState.snapshot != null;
  const isFresh =
    hasSnapshot && now - holderLiveState.generatedAtMs <= HOLDER_LIVE_CACHE_TTL_MS;

  if (requireFresh) {
    if (isFresh) return holderLiveState.snapshot;
    try {
      return await refreshLiveHolderSnapshot('require-fresh');
    } catch (err) {
      if (hasSnapshot) {
        return holderLiveState.snapshot;
      }
      throw err;
    }
  }

  if (isFresh) {
    return holderLiveState.snapshot;
  }

  if (hasSnapshot) {
    refreshLiveHolderSnapshot('stale-background').catch((err) => {
      console.error('[holders:live] Background refresh failed:', err.message || err);
    });
    return holderLiveState.snapshot;
  }

  return refreshLiveHolderSnapshot('initial');
}

function getLiveHolderBalanceMap(snapshot) {
  const holders = getSnapshotHolders(snapshot);
  const map = new Map();
  holders.forEach((holder) => {
    map.set(holder.address, holder.balance);
  });
  return map;
}

async function resolveHolderSnapshot(options = {}) {
  const requireFresh = Boolean(options.requireFresh);
  let liveError = null;
  const fallbackSnapshot = readJsonFileCached(holderLatestPath);

  if (HOLDER_LIVE_MODE_ENABLED) {
    const hasLiveSnapshot = holderLiveState.snapshot != null;
    if (!requireFresh && !hasLiveSnapshot && fallbackSnapshot) {
      refreshLiveHolderSnapshot('fallback-background').catch((err) => {
        console.error('[holders:live] Background warm-up from fallback failed:', err.message || err);
      });
      return {
        snapshot: fallbackSnapshot,
        isLive: false,
        liveError: null,
      };
    }

    try {
      const liveSnapshot = await getLiveHolderSnapshot({ requireFresh });
      if (liveSnapshot) {
        return {
          snapshot: liveSnapshot,
          isLive: true,
          liveError: null,
        };
      }
    } catch (err) {
      liveError = err;
      console.error('[holders:live] Snapshot resolve failed:', err.message || err);
    }
  }

  if (fallbackSnapshot) {
    return {
      snapshot: fallbackSnapshot,
      isLive: false,
      liveError,
    };
  }

  return {
    snapshot: null,
    isLive: false,
    liveError,
  };
}

function buildHoldersFromBalancesObject(balancesObj) {
  if (!balancesObj || typeof balancesObj !== 'object') return [];

  return Object.entries(balancesObj)
    .map(([address, balance]) => ({
      address: normaliseAddress(address),
      balance: Number(balance) || 0,
      tokenIds: [],
      lastActivity: null,
    }))
    .filter((h) => h.address && h.balance > 0)
    .sort((a, b) => {
      if (b.balance !== a.balance) return b.balance - a.balance;
      return a.address.localeCompare(b.address);
    });
}

function getSnapshotHolders(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];

  if (Array.isArray(snapshot.holders)) {
    return snapshot.holders
      .map((holder) => ({
        address: normaliseAddress(holder.address),
        balance:
          Number(holder.balance) ||
          (Array.isArray(holder.tokenIds) ? holder.tokenIds.length : 0),
        tokenIds: Array.isArray(holder.tokenIds) ? holder.tokenIds : [],
        lastActivity: holder.lastActivity || null,
      }))
      .filter((holder) => holder.address && holder.balance > 0)
      .sort((a, b) => {
        if (b.balance !== a.balance) return b.balance - a.balance;
        return a.address.localeCompare(b.address);
      });
  }

  if (snapshot.balances && typeof snapshot.balances === 'object') {
    return buildHoldersFromBalancesObject(snapshot.balances);
  }

  return [];
}

function getSnapshotBalanceMap(snapshot) {
  const map = new Map();

  if (snapshot && snapshot.balances && typeof snapshot.balances === 'object') {
    Object.entries(snapshot.balances).forEach(([address, balance]) => {
      const addr = normaliseAddress(address);
      if (!addr) return;
      const amount = Number(balance) || 0;
      if (amount > 0) map.set(addr, amount);
    });
    return map;
  }

  const holders = getSnapshotHolders(snapshot);
  holders.forEach((holder) => {
    map.set(holder.address, holder.balance);
  });
  return map;
}

function getTopHoldersFromSnapshot(snapshot, limit) {
  const max = Math.max(1, Math.min(Number(limit) || 25, 250));
  const summarySupply =
    Number(snapshot?.summary?.supplyAccounted) || null;

  if (Array.isArray(snapshot?.topHolders) && snapshot.topHolders.length > 0) {
    return snapshot.topHolders.slice(0, max).map((holder, idx) => ({
      rank: Number(holder.rank) || idx + 1,
      address: normaliseAddress(holder.address),
      balance: Number(holder.balance) || 0,
      shareOfSupplyPct:
        holder.shareOfSupplyPct != null
          ? Number(holder.shareOfSupplyPct)
          : summarySupply && summarySupply > 0
          ? Number((((Number(holder.balance) || 0) / summarySupply) * 100).toFixed(3))
          : 0,
      tokenPreview: Array.isArray(holder.tokenPreview) ? holder.tokenPreview : [],
      lastActivity: holder.lastActivity || null,
    }));
  }

  const holders = getSnapshotHolders(snapshot);
  const supply =
    summarySupply || holders.reduce((sum, holder) => sum + holder.balance, 0);

  return holders.slice(0, max).map((holder, idx) => ({
    rank: idx + 1,
    address: holder.address,
    balance: holder.balance,
    shareOfSupplyPct:
      supply > 0 ? Number(((holder.balance / supply) * 100).toFixed(3)) : 0,
    tokenPreview: holder.tokenIds.slice(0, 12),
    lastActivity: holder.lastActivity || null,
  }));
}

function buildCohortsFromHolders(holders, supplyAccounted) {
  const groups = [
    { id: 'single', label: '1 Token', min: 1, max: 1 },
    { id: 'small', label: '2-4 Tokens', min: 2, max: 4 },
    { id: 'medium', label: '5-19 Tokens', min: 5, max: 19 },
    { id: 'large', label: '20-49 Tokens', min: 20, max: 49 },
    { id: 'whale', label: '50+ Tokens', min: 50, max: Number.POSITIVE_INFINITY },
  ];

  return groups.map((group) => {
    const inGroup = holders.filter((holder) => {
      if (holder.balance < group.min) return false;
      if (group.max === Number.POSITIVE_INFINITY) return true;
      return holder.balance <= group.max;
    });

    const tokenCount = inGroup.reduce((sum, holder) => sum + holder.balance, 0);

    return {
      id: group.id,
      label: group.label,
      min: group.min,
      max: Number.isFinite(group.max) ? group.max : null,
      holders: inGroup.length,
      tokenCount,
      holderSharePct:
        holders.length > 0
          ? Number(((inGroup.length / holders.length) * 100).toFixed(2))
          : 0,
      tokenSharePct:
        supplyAccounted > 0
          ? Number(((tokenCount / supplyAccounted) * 100).toFixed(2))
          : 0,
    };
  });
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
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function setExplorerStaticHeaders(res, filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.json') {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Vary', 'Accept-Encoding');
    return;
  }
  if (ext === '.svg' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
}

const immutableImageStaticOptions = {
  maxAge: ONE_YEAR_MS,
  immutable: true,
  etag: true,
  fallthrough: true,
};

const explorerDataStaticOptions = {
  maxAge: ONE_HOUR_MS,
  etag: true,
  fallthrough: true,
  setHeaders: setExplorerStaticHeaders,
};

app.use('/explorer-data/images', express.static(explorerPublishedImagesDir, immutableImageStaticOptions));
app.use('/explorer-data', express.static(explorerPublishedDir, explorerDataStaticOptions));
app.use('/public/data/explorer/images', express.static(explorerPublicImagesDir, immutableImageStaticOptions));
app.use('/public/data/explorer', express.static(explorerPublicDir, explorerDataStaticOptions));

// Expose service worker at root while keeping source under /public.
app.get('/sw.js', (req, res) => {
  const swPath = path.join(__dirname, 'public', 'sw.js');
  if (!fs.existsSync(swPath)) {
    return res.sendStatus(404);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(swPath);
});

app.get('/manifest.json', (req, res) => {
  const manifestPath = path.join(__dirname, 'public', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return res.sendStatus(404);
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(manifestPath);
});

// Serve everything from project root
app.use(express.static(path.join(__dirname), { maxAge: 0, etag: true }));

// Also explicitly serve /public for anything you’ve parked in there
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));

// Traits index for frontend
app.use(
  '/traits',
  express.static(path.join(__dirname, 'public', 'traits'))
);

function buildPublicStatusResponse(req) {
  const tokenBlob = getPublicTokenBlobPayload();
  const traitIndex = readJsonFileCached(explorerTraitIndexPath);
  const onchainTraits = readJsonFileCached(onchainTraitsSnapshotPath);
  const traitCatalog = getPublicTraitCatalog();
  const datasets = buildPublicDatasetManifest(req);

  return {
    ready: Boolean(tokenBlob && traitIndex && onchainTraits && traitCatalog),
    version: PUBLIC_API_VERSION,
    name: PUBLIC_COLLECTION_NAME,
    contract: CONTRACT,
    chain: CHAIN,
    chainId: PUBLIC_CHAIN_ID,
    sampleTokenId: PUBLIC_SAMPLE_TOKEN_ID,
    generatedAt:
      onchainTraits?.generatedAt ||
      tokenBlob?.generatedAt ||
      traitIndex?.generatedAt ||
      null,
    docs: toAbsoluteUrl(getRequestOrigin(req), PUBLIC_API_DOCS_PATH),
    files: {
      tokenBlob: Boolean(tokenBlob),
      traitIndex: Boolean(traitIndex),
      onchainTraits: Boolean(onchainTraits),
      traitCatalog: Boolean(traitCatalog),
    },
    datasets: datasets.items,
  };
}

function buildPublicOpenApiDocument(req) {
  const origin = getRequestOrigin(req);
  return {
    openapi: '3.1.0',
    info: {
      title: 'No-Punks API',
      version: PUBLIC_API_VERSION,
      description:
        'Official public collection infrastructure for the No-Punks V2 contract on Base.',
    },
    servers: [
      {
        url: toAbsoluteUrl(origin, '/'),
        description: 'Current host',
      },
    ],
    tags: [
      { name: 'Collection' },
      { name: 'Tokens' },
      { name: 'Traits' },
      { name: 'Search' },
      { name: 'Datasets' },
      { name: 'Holders', description: 'Chain-derived holder snapshots and live owner data.' },
      { name: 'Market', description: 'Non-canonical market data derived from OpenSea.' },
    ],
    paths: {
      [`${PUBLIC_API_BASE_PATH}/status`]: { get: { tags: ['Collection'], summary: 'API readiness and dataset status' } },
      [`${PUBLIC_API_BASE_PATH}/collection`]: { get: { tags: ['Collection'], summary: 'No-Punks V2 collection manifest' } },
      [`${PUBLIC_API_BASE_PATH}/tokens/{tokenId}`]: {
        get: {
          tags: ['Tokens'],
          summary: 'Canonical No-Punks V2 token metadata',
          parameters: [
            {
              name: 'tokenId',
              in: 'path',
              required: true,
              schema: { type: 'integer', minimum: 0, maximum: 9999 },
            },
          ],
        },
      },
      [`${PUBLIC_API_BASE_PATH}/tokens/{tokenId}/image`]: {
        get: {
          tags: ['Tokens'],
          summary: 'Canonical No-Punks V2 token image',
          parameters: [
            {
              name: 'tokenId',
              in: 'path',
              required: true,
              schema: { type: 'integer', minimum: 0, maximum: 9999 },
            },
          ],
        },
      },
      [`${PUBLIC_API_BASE_PATH}/traits`]: { get: { tags: ['Traits'], summary: 'Public trait types' } },
      [`${PUBLIC_API_BASE_PATH}/traits/{traitType}`]: {
        get: {
          tags: ['Traits'],
          summary: 'Values and counts for one trait type',
          parameters: [{ name: 'traitType', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
      [`${PUBLIC_API_BASE_PATH}/traits/{traitType}/{value}`]: {
        get: {
          tags: ['Traits'],
          summary: 'Token IDs for a trait value',
          parameters: [
            { name: 'traitType', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'value', in: 'path', required: true, schema: { type: 'string' } },
          ],
        },
      },
      [`${PUBLIC_API_BASE_PATH}/search`]: {
        get: {
          tags: ['Search'],
          summary: 'Search No-Punks V2 tokens by id, name, or trait text',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
        },
      },
      [`${PUBLIC_API_BASE_PATH}/datasets`]: { get: { tags: ['Datasets'], summary: 'Bulk No-Punks V2 dataset URLs' } },
      [`${PUBLIC_API_BASE_PATH}/holders/summary`]: { get: { tags: ['Holders'], summary: 'Current holder summary from snapshot/live owner data' } },
      [`${PUBLIC_API_BASE_PATH}/holders/top`]: { get: { tags: ['Holders'], summary: 'Top holder rankings from snapshot/live owner data' } },
      [`${PUBLIC_API_BASE_PATH}/holders/{address}`]: {
        get: {
          tags: ['Holders'],
          summary: 'Holder detail by wallet address from snapshot/live owner data',
          parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
      [`${PUBLIC_API_BASE_PATH}/market/stats`]: { get: { tags: ['Market'], summary: 'Non-canonical market summary derived from OpenSea' } },
      [`${PUBLIC_API_BASE_PATH}/market/recent-sales`]: { get: { tags: ['Market'], summary: 'Non-canonical recent sales derived from OpenSea' } },
      [`${PUBLIC_API_BASE_PATH}/market/listings`]: { get: { tags: ['Market'], summary: 'Non-canonical current listings derived from OpenSea' } },
    },
  };
}

app.get('/llms.txt', publicCoreRateLimit, (req, res) => {
  const origin = getRequestOrigin(req);
  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(
    [
      '# No-Punks API',
      '',
      `Official public collection infrastructure for the No-Punks V2 contract on Base.`,
      `Contract: ${CONTRACT}`,
      `Chain: ${CHAIN} (${PUBLIC_CHAIN_ID})`,
      '',
      'Primary endpoints:',
      `${toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/status`)}`,
      `${toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/collection`)}`,
      `${toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/tokens/${PUBLIC_SAMPLE_TOKEN_ID}`)}`,
      `${toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/tokens/${PUBLIC_SAMPLE_TOKEN_ID}/image`)}`,
      `${toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/traits`)}`,
      `${toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/search?q=knitted%20cap`)}`,
      `${toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/datasets`)}`,
      '',
      'Holder endpoints are chain-derived from snapshot/live owner data.',
      'Market endpoints are non-canonical and derived from OpenSea.',
      `Docs: ${toAbsoluteUrl(origin, PUBLIC_API_DOCS_PATH)}`,
      `OpenAPI: ${toAbsoluteUrl(origin, PUBLIC_API_OPENAPI_PATH)}`,
    ].join('\n')
  );
});

app.get(PUBLIC_API_OPENAPI_PATH, publicCoreRateLimit, (req, res) => {
  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  res.json(buildPublicOpenApiDocument(req));
});

app.get(PUBLIC_API_DOCS_PATH, (req, res) => {
  const docsPath = path.join(__dirname, 'public', 'api.html');
  if (!fs.existsSync(docsPath)) {
    return res.sendStatus(404);
  }

  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; ')
  );
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  return res.sendFile(docsPath);
});

app.get(getPublicApiRoutePaths(), publicCoreRateLimit, (req, res) => {
  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  return res.json({
    version: PUBLIC_API_VERSION,
    docs: toAbsoluteUrl(getRequestOrigin(req), PUBLIC_API_DOCS_PATH),
    collection: buildPublicCollectionResponse(req),
  });
});

app.get(getPublicApiRoutePaths('/status'), publicCoreRateLimit, (req, res) => {
  setPublicCacheControl(res, 'public, max-age=60, stale-while-revalidate=300');
  return res.json(buildPublicStatusResponse(req));
});

app.get(getPublicApiRoutePaths('/collection'), publicCoreRateLimit, (req, res) => {
  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  return res.json(buildPublicCollectionResponse(req));
});

app.get(getPublicApiRoutePaths('/tokens/:tokenId'), publicCoreRateLimit, (req, res) => {
  const tokenId = parseOnChainTokenId(req.params.tokenId);
  if (tokenId == null) {
    return sendPublicApiError(res, 400, 'invalid_token_id', 'Token ID must be an integer between 0 and 9999.');
  }

  const tokenEntry = getPublicTokenBlobEntry(tokenId) || getOnchainSnapshotMetadata(tokenId);
  if (!tokenEntry) {
    return sendPublicApiError(res, 404, 'token_not_found', 'Token metadata was not found.');
  }

  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  return res.json(buildPublicTokenResponse(req, tokenId));
});

app.get(getPublicApiRoutePaths('/tokens/:tokenId/image'), publicCoreRateLimit, async (req, res) => {
  try {
    const tokenId = parseOnChainTokenId(req.params.tokenId);
    if (tokenId == null) {
      return sendPublicApiError(res, 400, 'invalid_token_id', 'Token ID must be an integer between 0 and 9999.');
    }

    const tokenEntry = getPublicTokenBlobEntry(tokenId);
    const imagePath = getPublicExplorerImagePath(tokenId, tokenEntry);
    if (imagePath) {
      setPublicCacheControl(res, 'public, max-age=31536000, immutable');
      return res.sendFile(path.join(__dirname, imagePath.replace(/^\/+/, '')));
    }

    return await sendTokenImageResponse(res, tokenId);
  } catch (err) {
    console.error('Public token image error:', err.message || err);
    return sendPublicApiError(res, 502, 'image_unavailable', 'Token image is unavailable right now.');
  }
});

app.get(getPublicApiRoutePaths('/traits'), publicCoreRateLimit, (req, res) => {
  const catalog = getPublicTraitCatalog();
  if (!catalog) {
    return sendPublicApiError(res, 503, 'trait_catalog_unavailable', 'Trait catalog is unavailable.');
  }

  const origin = getRequestOrigin(req);
  const traitIndex = readJsonFileCached(explorerTraitIndexPath);
  const traitTypes = catalog.traitTypes.map((traitType) => ({
    traitType,
    valueCount: catalog.typeValues[traitType]?.length || 0,
    url: toAbsoluteUrl(origin, `${PUBLIC_API_BASE_PATH}/traits/${encodeURIComponent(traitType)}`),
    totalMatches: Object.entries(traitIndex?.traitToTokenIds || {})
      .filter(([key]) => key.startsWith(`${traitType}|`))
      .reduce((sum, [, ids]) => sum + (Array.isArray(ids) ? ids.length : 0), 0),
  }));

  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  return res.json({
    contract: CONTRACT,
    chain: CHAIN,
    traitTypes,
  });
});

app.get(getPublicApiRoutePaths('/traits/:traitType/:value'), publicCoreRateLimit, (req, res) => {
  const traitType = resolvePublicTraitType(req.params.traitType);
  if (!traitType) {
    return sendPublicApiError(res, 404, 'trait_type_not_found', 'Trait type was not found.');
  }

  const traitValue = resolvePublicTraitValue(traitType, req.params.value);
  if (!traitValue) {
    return sendPublicApiError(res, 404, 'trait_value_not_found', 'Trait value was not found for this trait type.');
  }

  const limit = parseBoundedInt(req.query.limit, 250, 1, 1000);
  const offset = parseBoundedInt(req.query.offset, 0, 0, 9999);
  const tokenIds = getPublicTraitTokenIds(traitType, traitValue);
  const selected = tokenIds.slice(offset, offset + limit);

  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  return res.json({
    contract: CONTRACT,
    chain: CHAIN,
    traitType,
    value: traitValue,
    total: tokenIds.length,
    limit,
    offset,
    hasMore: offset + selected.length < tokenIds.length,
    tokenIds: selected,
  });
});

app.get(getPublicApiRoutePaths('/traits/:traitType'), publicCoreRateLimit, (req, res) => {
  const catalog = getPublicTraitCatalog();
  const traitType = resolvePublicTraitType(req.params.traitType);
  if (!catalog || !traitType) {
    return sendPublicApiError(res, 404, 'trait_type_not_found', 'Trait type was not found.');
  }

  const origin = getRequestOrigin(req);
  const values = (catalog.typeValues[traitType] || []).map((value) => {
    const tokenIds = getPublicTraitTokenIds(traitType, value);
    return {
      value,
      count: tokenIds.length,
      url: toAbsoluteUrl(
        origin,
        `${PUBLIC_API_BASE_PATH}/traits/${encodeURIComponent(traitType)}/${encodeURIComponent(value)}`
      ),
    };
  });

  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  return res.json({
    contract: CONTRACT,
    chain: CHAIN,
    traitType,
    values,
  });
});

app.get(getPublicApiRoutePaths('/search'), publicCoreRateLimit, (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  if (!query) {
    return sendPublicApiError(res, 400, 'missing_query', 'Query parameter "q" is required.');
  }

  const limit = parseBoundedInt(req.query.limit, 20, 1, 100);
  const searchIndex = getPublicSearchIndex();
  if (!searchIndex) {
    return sendPublicApiError(res, 503, 'search_unavailable', 'Search index is unavailable.');
  }

  const matches = searchIndex.filter((record) => record.searchText.includes(query));
  const results = matches
    .slice(0, limit)
    .map((record) => buildPublicTokenResponse(req, record.tokenId));

  setPublicCacheControl(res, 'public, max-age=120, stale-while-revalidate=900');
  return res.json({
    contract: CONTRACT,
    chain: CHAIN,
    query,
    total: matches.length,
    results,
  });
});

app.get(getPublicApiRoutePaths('/datasets'), publicCoreRateLimit, (req, res) => {
  setPublicCacheControl(res, 'public, max-age=300, stale-while-revalidate=3600');
  return res.json(buildPublicDatasetManifest(req));
});

app.get(getPublicApiRoutePaths('/holders/summary'), publicLiveRateLimit, async (req, res) => {
  const resolved = await resolveHolderSnapshot({ requireFresh: false });
  const latest = resolved.snapshot;
  if (!latest) {
    return sendPublicApiError(res, 503, 'holders_unavailable', 'Holder data is unavailable right now.');
  }

  setPublicCacheControl(res, 'public, max-age=15, stale-while-revalidate=45');
  return res.json({
    contract: CONTRACT,
    chain: CHAIN,
    generatedAt: latest.generatedAt || null,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
    },
    summary: latest.summary || {},
  });
});

app.get(getPublicApiRoutePaths('/holders/top'), publicLiveRateLimit, async (req, res) => {
  const resolved = await resolveHolderSnapshot({ requireFresh: false });
  const latest = resolved.snapshot;
  if (!latest) {
    return sendPublicApiError(res, 503, 'holders_unavailable', 'Holder data is unavailable right now.');
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 25, 100));
  const includeTokens = String(req.query.includeTokens || '') === '1';
  const holdersByAddress = new Map(
    getSnapshotHolders(latest).map((holder) => [holder.address, holder])
  );

  setPublicCacheControl(res, 'public, max-age=15, stale-while-revalidate=45');
  return res.json({
    contract: CONTRACT,
    chain: CHAIN,
    generatedAt: latest.generatedAt || null,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
    },
    summary: latest.summary || {},
    holders: getTopHoldersFromSnapshot(latest, limit).map((holder) => ({
      rank: holder.rank,
      address: holder.address,
      balance: holder.balance,
      shareOfSupplyPct: holder.shareOfSupplyPct,
      tokenPreview: holder.tokenPreview,
      tokenIds: includeTokens ? holdersByAddress.get(holder.address)?.tokenIds || [] : undefined,
      lastActivity: holder.lastActivity,
    })),
  });
});

app.get(getPublicApiRoutePaths('/holders/:address'), publicLiveRateLimit, async (req, res) => {
  const address = normaliseAddress(req.params.address);
  if (!address) {
    return sendPublicApiError(res, 400, 'invalid_address', 'Wallet address is invalid.');
  }

  let resolved = await resolveHolderSnapshot({ requireFresh: false });
  let latest = resolved.snapshot;
  if (!latest) {
    return sendPublicApiError(res, 503, 'holders_unavailable', 'Holder data is unavailable right now.');
  }

  let holders = getSnapshotHolders(latest);
  let found = holders.find((holder) => holder.address === address) || null;

  if (!found && HOLDER_LIVE_MODE_ENABLED && HOLDER_LIVE_FORCE_REFRESH_ON_LOOKUP) {
    const refreshed = await resolveHolderSnapshot({ requireFresh: true });
    if (refreshed.snapshot) {
      resolved = refreshed;
      latest = refreshed.snapshot;
      holders = getSnapshotHolders(latest);
      found = holders.find((holder) => holder.address === address) || null;
    }
  }

  if (!found) {
    return sendPublicApiError(res, 404, 'holder_not_found', 'No holder data was found for this address.', {
      address,
    });
  }

  let rank = 1;
  holders.forEach((holder) => {
    if (holder.address === address) return;
    if (holder.balance > found.balance) rank += 1;
    if (holder.balance === found.balance && holder.address < address) rank += 1;
  });

  setPublicCacheControl(res, 'public, max-age=15, stale-while-revalidate=45');
  return res.json({
    contract: CONTRACT,
    chain: CHAIN,
    generatedAt: latest.generatedAt || null,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
    },
    address,
    balance: found.balance,
    rank,
    percentile:
      holders.length > 0
        ? Number((((holders.length - rank + 1) / holders.length) * 100).toFixed(2))
        : 0,
    tokenIds: Array.isArray(found.tokenIds) ? found.tokenIds : [],
    lastActivity: found.lastActivity || null,
  });
});

app.get(getPublicApiRoutePaths('/market/stats'), publicLiveRateLimit, async (req, res) => {
  try {
    const payload = await loadCollectionStatsPayload();
    setPublicCacheControl(res, 'public, max-age=30, stale-while-revalidate=120');
    return res.json({
      contract: CONTRACT,
      chain: CHAIN,
      source: {
        type: 'opensea',
        collectionSlug: COLLECTION_SLUG,
      },
      ...payload,
    });
  } catch (err) {
    console.error('Public market stats error:', err.message || err);
    return sendPublicApiError(res, 502, 'market_stats_unavailable', 'Market stats are unavailable right now.');
  }
});

app.get(getPublicApiRoutePaths('/market/recent-sales'), publicLiveRateLimit, async (req, res) => {
  try {
    const limit = parseBoundedInt(req.query.limit, 5, 1, 20);
    const payload = await loadRecentSalesPayload(limit);
    setPublicCacheControl(res, 'public, max-age=15, stale-while-revalidate=90');
    return res.json({
      contract: CONTRACT,
      chain: CHAIN,
      source: {
        type: 'opensea',
        collectionSlug: COLLECTION_SLUG,
      },
      limit,
      sales: payload.sales || [],
    });
  } catch (err) {
    console.error('Public recent sales error:', err.message || err);
    return sendPublicApiError(res, 502, 'recent_sales_unavailable', 'Recent sales are unavailable right now.');
  }
});

app.get(getPublicApiRoutePaths('/market/listings'), publicLiveRateLimit, async (req, res) => {
  try {
    const hasPagesOverride = req.query.pages != null && String(req.query.pages).trim() !== '';
    const maxPages = hasPagesOverride
      ? parseBoundedInt(req.query.pages, LISTED_DEFAULT_MAX_PAGES, 1, LISTED_MAX_PAGES_CAP)
      : null;
    const limit = parseBoundedInt(
      req.query.limit,
      LISTED_DEFAULT_RESULT_LIMIT,
      8,
      LISTED_RESULT_LIMIT_CAP
    );
    const pageSize = parseBoundedInt(
      req.query.pageSize,
      LISTED_PAGE_SIZE_DEFAULT,
      20,
      50
    );

    const payload = await loadCollectionListingsPayload({ maxPages, limit, pageSize });
    setPublicCacheControl(res, 'public, max-age=20, stale-while-revalidate=120');
    return res.json({
      contract: CONTRACT,
      chain: CHAIN,
      source: {
        type: 'opensea',
        collectionSlug: COLLECTION_SLUG,
      },
      totalListed: payload.totalListed || 0,
      listings: payload.listings || [],
    });
  } catch (err) {
    console.error('Public listings error:', err.message || err);
    return sendPublicApiError(res, 502, 'listings_unavailable', 'Listings are unavailable right now.');
  }
});

// In case icons / no-meta / team live under /public, wire these paths too:
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
app.use('/no-meta', express.static(path.join(__dirname, 'public', 'no-meta')));
app.use('/team', express.static(path.join(__dirname, 'public', 'team')));
app.use('/marketplace', express.static(path.join(__dirname, 'public', 'marketplace')));
app.use(
  '/generated/world3d-share',
  express.static(NOPUNKS_3D_SHARE_EXPORT_ROOT_DIR, {
    maxAge: ONE_YEAR_MS,
    immutable: true,
    etag: true,
    fallthrough: true,
  })
);

// -----------------------------
// 3D WORLD – public NoPunks models + posters
// -----------------------------
const THREE_D_CACHE_TTL_MS = 60 * 1000;
let threeDManifestCache = {
  expiresAt: 0,
  payload: null,
};
let threeDShareJobCounter = 0;
const threeDShareJobs = new Map();
const threeDShareJobsByCacheKey = new Map();
const threeDShareVideoBuilds = new Map();
const threeDShareGifBuilds = new Map();

function isExistingFile(filePath) {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

ensureDirSync(NOPUNKS_3D_SHARE_EXPORT_ROOT_DIR);
ensureDirSync(NOPUNKS_3D_SHARE_JOB_ROOT_DIR);

function buildThreeDShareJobPath(jobId) {
  if (!jobId) return '';
  return path.join(NOPUNKS_3D_SHARE_JOB_ROOT_DIR, `${jobId}.json`);
}

function persistThreeDShareJob(job) {
  if (!job?.jobId) return job;
  try {
    fs.writeFileSync(buildThreeDShareJobPath(job.jobId), JSON.stringify(job, null, 2));
  } catch (err) {
    console.warn('[3d-share] Failed to persist job:', err?.message || err);
  }
  return job;
}

function loadThreeDShareJob(jobId) {
  if (!jobId) return null;
  const jobPath = buildThreeDShareJobPath(jobId);
  if (!isExistingFile(jobPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
    if (!parsed?.jobId) return null;
    threeDShareJobs.set(parsed.jobId, parsed);
    if (parsed.cacheKey) {
      threeDShareJobsByCacheKey.set(parsed.cacheKey, parsed.jobId);
    }
    return parsed;
  } catch (err) {
    console.warn('[3d-share] Failed to load job:', err?.message || err);
    return null;
  }
}

function build3dShareAssetPaths(tokenId) {
  const safeTokenId = parseOnChainTokenId(tokenId);
  if (safeTokenId == null) return null;

  const version = NOPUNKS_3D_SHARE_EXPORT_VERSION;
  const dirPath = path.join(NOPUNKS_3D_SHARE_EXPORT_ROOT_DIR, String(safeTokenId), version);
  const mp4Filename = `nopunk-${safeTokenId}-3d.mp4`;
  const gifFilename = `nopunk-${safeTokenId}-3d.gif`;

  return {
    tokenId: safeTokenId,
    version,
    dirPath,
    mp4Filename,
    gifFilename,
    mp4Path: path.join(dirPath, mp4Filename),
    gifPath: path.join(dirPath, gifFilename),
    mp4Url: `/generated/world3d-share/${safeTokenId}/${version}/${mp4Filename}`,
    gifUrl: `/generated/world3d-share/${safeTokenId}/${version}/${gifFilename}`,
  };
}

function getThreeDShareBaseUrl() {
  const explicit = String(process.env.NOPUNKS_3D_SHARE_BASE_URL || '').trim();
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }
  return `http://127.0.0.1:${PORT}`;
}

function getThreeDShareJob(jobId) {
  if (!jobId) return null;
  return threeDShareJobs.get(jobId) || loadThreeDShareJob(jobId) || null;
}

function serializeThreeDShareJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    tokenId: job.tokenId,
    format: job.format,
    status: job.status,
    stage: job.stage,
    progressPct: job.progressPct,
    downloadUrl: job.downloadUrl || '',
    error: job.error || '',
  };
}

function updateThreeDShareJob(job, patch = {}) {
  if (!job) return job;
  Object.assign(job, patch);
  job.updatedAt = Date.now();
  return persistThreeDShareJob(job);
}

function createThreeDShareJob(tokenId, format, downloadUrl = '') {
  const cacheKey = `${NOPUNKS_3D_SHARE_EXPORT_VERSION}:${tokenId}:${format}`;
  const existing = getThreeDShareJob(threeDShareJobsByCacheKey.get(cacheKey));
  if (existing && ['queued', 'rendering', 'encoding'].includes(existing.status)) {
    return existing;
  }
  if (existing) {
    threeDShareJobs.delete(existing.jobId);
    threeDShareJobsByCacheKey.delete(cacheKey);
  }

  const jobId = `share-${Date.now()}-${++threeDShareJobCounter}`;
  const job = {
    jobId,
    cacheKey,
    tokenId,
    format,
    status: 'queued',
    stage: 'Queued',
    progressPct: 0,
    downloadUrl,
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  threeDShareJobs.set(jobId, job);
  threeDShareJobsByCacheKey.set(cacheKey, jobId);
  return persistThreeDShareJob(job);
}

function listTokenIdsForExtension(dirPath, ext) {
  if (!dirPath || !ext) return [];
  if (!fs.existsSync(dirPath)) return [];

  try {
    return fs
      .readdirSync(dirPath)
      .map((file) => String(file || '').trim())
      .filter((file) => file.toLowerCase().endsWith(ext))
      .map((file) => Number.parseInt(path.basename(file, ext), 10))
      .filter((tokenId) => Number.isInteger(tokenId) && tokenId >= 0 && tokenId < NOPUNKS_SUPPLY)
      .sort((a, b) => a - b);
  } catch (err) {
    console.warn(`[3d] Failed to read ${dirPath}:`, err.message || err);
    return [];
  }
}

function build3dPosterPath(tokenId) {
  return path.join(NOPUNKS_3D_POSTERS_DIR, `${tokenId}.png`);
}

function build3dModelPath(tokenId) {
  return path.join(NOPUNKS_3D_MODELS_DIR, `${tokenId}.glb`);
}

function build3dTokenPayload(tokenId) {
  const safeTokenId = parseOnChainTokenId(tokenId);
  if (safeTokenId == null) return null;

  const posterPath = build3dPosterPath(safeTokenId);
  const modelPath = build3dModelPath(safeTokenId);
  const posterAvailable = isExistingFile(posterPath);
  const modelAvailable = isExistingFile(modelPath);

  return {
    tokenId: safeTokenId,
    name: `No-Punk #${safeTokenId}`,
    available: modelAvailable,
    posterAvailable,
    posterUrl: posterAvailable ? `/transparent/${safeTokenId}.png` : `/api/onchain/token/${safeTokenId}/image`,
    modelUrl: modelAvailable ? `/world3d-models/${safeTokenId}.glb` : '',
    imageUrl: posterAvailable ? `/transparent/${safeTokenId}.png` : `/api/onchain/token/${safeTokenId}/image`,
    openseaUrl: `https://opensea.io/item/base/${CONTRACT}/${safeTokenId}`,
  };
}

function sampleTokenIds(tokenIds, maxCount = 8) {
  const list = Array.isArray(tokenIds) ? tokenIds.slice() : [];
  if (list.length <= maxCount) return list;

  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }

  return list.slice(0, maxCount).sort((a, b) => a - b);
}

async function ensureThreeDShareVideo(tokenId, onProgress = () => {}) {
  const assetPaths = build3dShareAssetPaths(tokenId);
  if (!assetPaths) {
    throw new Error('Invalid tokenId');
  }

  ensureDirSync(assetPaths.dirPath);
  if (isExistingFile(assetPaths.mp4Path)) {
    onProgress({ status: 'ready', stage: 'Ready', progressPct: 100 });
    return assetPaths;
  }

  const existingBuild = threeDShareVideoBuilds.get(assetPaths.tokenId);
  if (existingBuild) {
    onProgress({ status: 'rendering', stage: 'Preparing scene', progressPct: 5 });
    await existingBuild;
    return assetPaths;
  }

  const buildPromise = renderWorld3dShareMp4({
    tokenId: assetPaths.tokenId,
    outputPath: assetPaths.mp4Path,
    baseUrl: getThreeDShareBaseUrl(),
    onProgress,
  });

  threeDShareVideoBuilds.set(assetPaths.tokenId, buildPromise);

  try {
    await buildPromise;
    return assetPaths;
  } finally {
    threeDShareVideoBuilds.delete(assetPaths.tokenId);
  }
}

async function ensureThreeDShareGif(tokenId, onProgress = () => {}) {
  const assetPaths = build3dShareAssetPaths(tokenId);
  if (!assetPaths) {
    throw new Error('Invalid tokenId');
  }

  ensureDirSync(assetPaths.dirPath);
  if (
    isExistingFile(assetPaths.gifPath) &&
    fs.statSync(assetPaths.gifPath).size <= NOPUNKS_3D_SHARE_GIF_MAX_BYTES
  ) {
    onProgress({ status: 'ready', stage: 'Ready', progressPct: 100 });
    return assetPaths;
  }

  const existingBuild = threeDShareGifBuilds.get(assetPaths.tokenId);
  if (existingBuild) {
    onProgress({ status: 'encoding', stage: 'Encoding GIF', progressPct: 84 });
    await existingBuild;
    return assetPaths;
  }

  const buildPromise = renderWorld3dShareGif({
    tokenId: assetPaths.tokenId,
    outputPath: assetPaths.gifPath,
    baseUrl: getThreeDShareBaseUrl(),
    onProgress,
    maxBytes: NOPUNKS_3D_SHARE_GIF_MAX_BYTES,
  });

  threeDShareGifBuilds.set(assetPaths.tokenId, buildPromise);

  try {
    await buildPromise;
    return assetPaths;
  } finally {
    threeDShareGifBuilds.delete(assetPaths.tokenId);
  }
}

function startThreeDShareJob(job) {
  if (!job || job.promise) return job;

  const run = async () => {
    try {
      if (job.format === 'gif') {
        const assetPaths = await ensureThreeDShareGif(job.tokenId, (progress) => {
          updateThreeDShareJob(job, progress);
        });
        updateThreeDShareJob(job, {
          status: 'ready',
          stage: 'Ready',
          progressPct: 100,
          downloadUrl: assetPaths.gifUrl,
        });
        return;
      }

      const assetPaths = await ensureThreeDShareVideo(job.tokenId, (progress) => {
        updateThreeDShareJob(job, progress);
      });
      updateThreeDShareJob(job, {
        status: 'ready',
        stage: 'Ready',
        progressPct: 100,
        downloadUrl: assetPaths.mp4Url,
      });
    } catch (err) {
      updateThreeDShareJob(job, {
        status: 'error',
        stage: 'Error',
        progressPct: 100,
        error: err?.message || String(err),
      });
    }
  };

  job.promise = run().finally(() => {
    delete job.promise;
  });

  return job;
}

function get3dManifest(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && threeDManifestCache.payload && now < threeDManifestCache.expiresAt) {
    return threeDManifestCache.payload;
  }

  const posterTokenIds = listTokenIdsForExtension(NOPUNKS_3D_POSTERS_DIR, '.png');
  const modelTokenIds = listTokenIdsForExtension(NOPUNKS_3D_MODELS_DIR, '.glb');
  const availableTokenIds = modelTokenIds;

  const payload = {
    totalSupply: NOPUNKS_SUPPLY,
    posterCount: posterTokenIds.length,
    generatedModelCount: availableTokenIds.length,
    availableTokenIds,
    suggestionTokenIds: sampleTokenIds(availableTokenIds, 8),
    updatedAt: new Date().toISOString(),
  };

  threeDManifestCache = {
    payload,
    expiresAt: now + THREE_D_CACHE_TTL_MS,
  };

  return payload;
}

app.get('/api/3d/manifest', (req, res) => {
  const manifest = get3dManifest();
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.json(manifest);
});

app.get('/api/3d/featured', (req, res) => {
  const manifest = get3dManifest();
  if (!manifest.availableTokenIds.length) {
    return res.status(404).json({ error: 'No public 3D models available yet' });
  }

  const tokenId =
    manifest.availableTokenIds[Math.floor(Math.random() * manifest.availableTokenIds.length)];
  const payload = build3dTokenPayload(tokenId);
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  return res.json(payload);
});

app.get('/api/3d/token/:tokenId', (req, res) => {
  const tokenId = parseOnChainTokenId(req.params.tokenId);
  if (tokenId == null) {
    return res.status(400).json({ error: 'Invalid tokenId' });
  }

  const payload = build3dTokenPayload(tokenId);
  return res.json(payload);
});

app.get('/api/3d/token/:tokenId/poster', (req, res) => {
  const tokenId = parseOnChainTokenId(req.params.tokenId);
  if (tokenId == null) {
    return res.status(400).json({ error: 'Invalid tokenId' });
  }

  const posterPath = build3dPosterPath(tokenId);
  if (!isExistingFile(posterPath)) {
    return res.status(404).json({ error: '3D poster unavailable' });
  }

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(posterPath);
});

app.get('/api/3d/token/:tokenId/model', (req, res) => {
  const tokenId = parseOnChainTokenId(req.params.tokenId);
  if (tokenId == null) {
    return res.status(400).json({ error: 'Invalid tokenId' });
  }

  const modelPath = build3dModelPath(tokenId);
  if (!isExistingFile(modelPath)) {
    return res.status(404).json({ error: '3D model unavailable' });
  }

  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(modelPath);
});

app.post('/api/3d/export', async (req, res) => {
  try {
    const tokenId = parseOnChainTokenId(req.body?.tokenId);
    const format = String(req.body?.format || '').trim().toLowerCase();

    if (tokenId == null) {
      return res.status(400).json({ error: 'Invalid tokenId' });
    }

    if (format !== 'mp4' && format !== 'gif') {
      return res.status(400).json({ error: 'Invalid format' });
    }

    const modelPath = build3dModelPath(tokenId);
    if (!isExistingFile(modelPath)) {
      return res.status(404).json({ error: '3D export not ready' });
    }

    const assetPaths = build3dShareAssetPaths(tokenId);
    ensureDirSync(assetPaths.dirPath);

    const cachedDownloadUrl = format === 'gif' ? assetPaths.gifUrl : assetPaths.mp4Url;
    const cachedFilePath = format === 'gif' ? assetPaths.gifPath : assetPaths.mp4Path;
    if (isExistingFile(cachedFilePath)) {
      const readyJob = createThreeDShareJob(tokenId, format, cachedDownloadUrl);
      updateThreeDShareJob(readyJob, {
        status: 'ready',
        stage: 'Ready',
        progressPct: 100,
        downloadUrl: cachedDownloadUrl,
        error: '',
      });
      return res.json(serializeThreeDShareJob(readyJob));
    }

    const job = createThreeDShareJob(tokenId, format);
    startThreeDShareJob(job);
    return res.status(202).json(serializeThreeDShareJob(job));
  } catch (err) {
    const message = err?.message || 'Could not start 3D export';
    console.error('[3d-share] Export route error:', message);
    return res.status(500).json({ error: message });
  }
});

app.get('/api/3d/export/:jobId', (req, res) => {
  const job = getThreeDShareJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Export job not found' });
  }

  return res.json(serializeThreeDShareJob(job));
});

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

function extractSvgFromInlineValue(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('<svg')) {
    return trimmed;
  }

  if (!/^data:image\/svg\+xml/i.test(trimmed)) {
    return '';
  }

  const commaIndex = trimmed.indexOf(',');
  if (commaIndex === -1) {
    return '';
  }

  const metadata = trimmed.slice(0, commaIndex);
  const payload = trimmed.slice(commaIndex + 1);

  try {
    let decoded = payload;
    if (/;base64/i.test(metadata)) {
      decoded = Buffer.from(payload, 'base64').toString('utf8');
    } else {
      try {
        decoded = decodeURIComponent(payload);
      } catch {
        decoded = payload;
      }
    }
    const svg = decoded.trim();
    return svg.startsWith('<svg') ? svg : '';
  } catch {
    return '';
  }
}

function shouldTryRemoteSvgFetch(value) {
  if (!value || typeof value !== 'string') return false;
  const normalized = normaliseImageUrl(value).toLowerCase();
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    return false;
  }

  if (
    /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(normalized) &&
    !normalized.includes('svg')
  ) {
    return false;
  }

  return (
    normalized.includes('.svg') ||
    normalized.includes('image/svg+xml') ||
    normalized.includes('format=svg') ||
    !/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(normalized)
  );
}

async function fetchTextFromUrl(url, label = 'Remote text', timeoutMs = 20000) {
  const normalizedUrl = normaliseImageUrl(url);
  if (!normalizedUrl) {
    throw new Error(`${label} URL missing`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(normalizedUrl, {
      headers: {
        accept: 'image/svg+xml,text/plain,*/*',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`${label} request failed with ${res.status}`);
    }

    const text = await res.text();
    return {
      text,
      contentType: (res.headers.get('content-type') || '').toLowerCase(),
      url: normalizedUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonFromUrl(url, label = 'Remote JSON', timeoutMs = 20000) {
  const normalizedUrl = normaliseImageUrl(url);
  if (!normalizedUrl) {
    throw new Error(`${label} URL missing`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(normalizedUrl, {
      headers: {
        accept: 'application/json,*/*',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`${label} request failed with ${res.status}`);
    }

    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function collectSvgCandidates(nft, metadata) {
  const candidates = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) {
      candidates.push(value.trim());
    }
  };

  push(nft && nft.image_data);
  push(nft && nft.image);
  push(nft && nft.image_original_url);
  push(nft && nft.image_url);
  push(nft && nft.display_image_url);

  if (Array.isArray(nft && nft.media)) {
    nft.media.forEach((entry) => {
      push(entry && entry.gateway);
      push(entry && entry.thumbnail);
      push(entry && entry.raw);
      push(entry && entry.url);
    });
  }

  if (metadata && typeof metadata === 'object') {
    push(metadata.image_data);
    push(metadata.image);
    push(metadata.image_url);
    push(metadata.animation_url);
  }

  return [...new Set(candidates)];
}

async function resolveOpenSeaSvgFromNft(nft) {
  let embeddedMetadata = null;

  if (nft && nft.metadata && typeof nft.metadata === 'object') {
    embeddedMetadata = nft.metadata;
  } else if (nft && typeof nft.metadata === 'string') {
    try {
      embeddedMetadata = JSON.parse(nft.metadata);
    } catch {
      embeddedMetadata = null;
    }
  }

  const candidates = collectSvgCandidates(nft, embeddedMetadata);

  for (const candidate of candidates) {
    const inlineSvg = extractSvgFromInlineValue(candidate);
    if (inlineSvg) {
      return {
        svg: inlineSvg,
        source: candidate.startsWith('<svg')
          ? 'inline-svg'
          : 'inline-svg-data-url',
      };
    }

    if (!shouldTryRemoteSvgFetch(candidate)) {
      continue;
    }

    try {
      const remote = await fetchTextFromUrl(candidate, 'SVG source', 20000);
      if (
        remote.contentType.includes('image/svg+xml') ||
        /<svg[\s>]/i.test(remote.text)
      ) {
        return {
          svg: remote.text,
          source: remote.url,
        };
      }
    } catch (err) {
      console.warn(
        `Could not fetch SVG candidate: ${candidate}`,
        err && (err.message || err)
      );
    }
  }

  if (nft && nft.metadata_url) {
    try {
      const metadata = await fetchJsonFromUrl(
        nft.metadata_url,
        'NFT metadata',
        20000
      );
      const metadataCandidates = collectSvgCandidates({}, metadata);

      for (const candidate of metadataCandidates) {
        const inlineSvg = extractSvgFromInlineValue(candidate);
        if (inlineSvg) {
          return {
            svg: inlineSvg,
            source: candidate.startsWith('<svg')
              ? 'metadata-inline-svg'
              : 'metadata-inline-svg-data-url',
          };
        }

        if (!shouldTryRemoteSvgFetch(candidate)) {
          continue;
        }

        try {
          const remote = await fetchTextFromUrl(
            candidate,
            'Metadata SVG source',
            20000
          );
          if (
            remote.contentType.includes('image/svg+xml') ||
            /<svg[\s>]/i.test(remote.text)
          ) {
            return {
              svg: remote.text,
              source: remote.url,
            };
          }
        } catch (err) {
          console.warn(
            `Could not fetch metadata SVG candidate: ${candidate}`,
            err && (err.message || err)
          );
        }
      }
    } catch (err) {
      console.warn(
        `Could not read metadata for SVG resolution: ${nft.metadata_url}`,
        err && (err.message || err)
      );
    }
  }

  return null;
}

async function fetchJsonFromOpenSea(url, label = 'OpenSea', timeoutMs = 20000) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        const shouldRetry =
          attempt < maxAttempts && [429, 500, 502, 503, 504].includes(res.status);

        if (shouldRetry) {
          const retryAfterHeader = res.headers.get('retry-after');
          const retryAfterSeconds = Number.parseInt(String(retryAfterHeader || '').trim(), 10);
          const retryDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : 1000 * 2 ** (attempt - 1);
          console.warn(
            `${label} error ${res.status}, retrying in ${retryDelayMs}ms (attempt ${attempt}/${maxAttempts})`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }

        console.error(`${label} error ${res.status}: ${shortBody}`);
        const error = new Error(`${label} request failed with ${res.status}`);
        error.noRetry = true;
        throw error;
      }

      try {
        return JSON.parse(text);
      } catch (e) {
        console.error(`${label} JSON parse error:`, e);
        e.noRetry = true;
        throw e;
      }
    } catch (err) {
      if (err?.noRetry) {
        throw err;
      }

      const shouldRetry = attempt < maxAttempts;
      if (!shouldRetry) {
        throw err;
      }

      const retryDelayMs = 1000 * 2 ** (attempt - 1);
      console.warn(
        `${label} transport error, retrying in ${retryDelayMs}ms (attempt ${attempt}/${maxAttempts}): ${
          err?.message || err
        }`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`${label} request failed after ${maxAttempts} attempts`);
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
const apiResponseCache = new Map(); // key -> { value, expiresAt, inflight }

async function getOrSetApiResponseCache(cacheKey, ttlMs, loader) {
  const now = Date.now();
  const cached = apiResponseCache.get(cacheKey);

  if (cached && cached.value != null && now < cached.expiresAt) {
    return cached.value;
  }
  if (cached && cached.inflight) {
    return cached.inflight;
  }

  const staleValue = cached && cached.value != null ? cached.value : null;

  const inflight = (async () => {
    try {
      const value = await loader();
      apiResponseCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + ttlMs,
        inflight: null,
      });
      return value;
    } catch (err) {
      if (staleValue != null) {
        apiResponseCache.set(cacheKey, {
          value: staleValue,
          expiresAt: Date.now() + Math.min(15000, Math.max(5000, Math.floor(ttlMs / 4))),
          inflight: null,
        });
        return staleValue;
      }
      apiResponseCache.delete(cacheKey);
      throw err;
    }
  })();

  apiResponseCache.set(cacheKey, {
    value: staleValue,
    expiresAt: cached ? cached.expiresAt : 0,
    inflight,
  });

  return inflight;
}

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value == null ? '' : value).trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

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
      setTimeout(processOpenSeaQueue, OPENSEA_QUEUE_DELAY_MS);
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
// /api/nft/token/:tokenId
// Direct on-chain token ID lookup (matches OpenSea item URL token ID)
// =======================
app.get('/api/nft/token/:tokenId', async (req, res) => {
  try {
    const tokenId = parseOnChainTokenId(req.params.tokenId);
    if (tokenId == null) {
      return res.status(400).json({ error: 'Invalid tokenId' });
    }

    const cacheKey = `${CONTRACT.toLowerCase()}:${tokenId}`;
    const cached = nftCache.get(cacheKey);
    const collectionIndex = getCollectionIndexForTokenId(tokenId);
    if (cached) {
      const canonicalTraits = getTraitsForToken(tokenId, collectionIndex);
      if (canonicalTraits && !cached.traits && !cached.attributes) {
        cached.traits = canonicalTraits;
        cached.attributes = canonicalTraits;
      }
      return res.json(cached);
    }

    const url = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${tokenId}`;
    const data = await queueOpenSeaRequest(url, 'NFT token');

    const nft = data.nft || data || {};

    const image_url = normaliseImageUrl(
      nft.image_url ||
        nft.display_image_url ||
        nft.image_original_url ||
        nft.image ||
        ''
    );

    const canonicalTraits = getTraitsForToken(tokenId, collectionIndex);

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
    console.error('NFT token API error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch NFT from OpenSea' });
  }
});

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

// =======================
// /api/nft/token/:tokenId/svg
// =======================
app.get('/api/nft/token/:tokenId/svg', async (req, res) => {
  try {
    const tokenId = parseOnChainTokenId(req.params.tokenId);
    if (tokenId == null) {
      return res.status(400).json({ error: 'Invalid tokenId' });
    }

    const url = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${tokenId}`;
    const data = await queueOpenSeaRequest(url, 'NFT token SVG');
    const nft = data.nft || data || {};
    const onChainId = nft.identifier || nft.token_id || tokenId;
    const image_url = normaliseImageUrl(
      nft.image_url ||
        nft.display_image_url ||
        nft.image_original_url ||
        nft.image ||
        ''
    );

    const resolved = await resolveOpenSeaSvgFromNft(nft);
    if (!resolved || !resolved.svg) {
      return res.status(404).json({
        error: 'SVG source unavailable for this NFT',
        tokenId,
        onChainId,
        image_url,
      });
    }

    res.json({
      tokenId,
      onChainId,
      image_url,
      source: resolved.source || null,
      svg: resolved.svg,
    });
  } catch (err) {
    console.error('NFT token SVG API error:', err.message || err);
    res
      .status(500)
      .json({ error: 'Failed to fetch NFT SVG source from OpenSea' });
  }
});

// =======================
// /api/nft/:index/svg
// =======================
app.get('/api/nft/:index/svg', async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    if (Number.isNaN(index) || index < 0 || index >= 10000) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    const tokenId = indexToTokenId(index);
    const url = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${tokenId}`;
    const data = await queueOpenSeaRequest(url, 'NFT SVG');
    const nft = data.nft || data || {};
    const onChainId = nft.identifier || nft.token_id || tokenId;
    const image_url = normaliseImageUrl(
      nft.image_url ||
        nft.display_image_url ||
        nft.image_original_url ||
        nft.image ||
        ''
    );

    const resolved = await resolveOpenSeaSvgFromNft(nft);
    if (!resolved || !resolved.svg) {
      return res.status(404).json({
        error: 'SVG source unavailable for this NFT',
        tokenId: index,
        onChainId,
        image_url,
      });
    }

    res.json({
      tokenId: index,
      onChainId,
      image_url,
      source: resolved.source || null,
      svg: resolved.svg,
    });
  } catch (err) {
    console.error('NFT SVG API error:', err.message || err);
    res
      .status(500)
      .json({ error: 'Failed to fetch NFT SVG source from OpenSea' });
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
  try {
    const seedBase = getDailySeedString();
    const cacheKey = `showcase:${CHAIN}:${seedBase}`;
    const payload = await getOrSetApiResponseCache(
      cacheKey,
      OPENSEA_SHOWCASE_CACHE_TTL_MS,
      async () => {
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
                const imageCacheKey = `${cfg.contract.toLowerCase()}:${onChainId}`;
                nftCache.set(imageCacheKey, {
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

                const onChainId = nft.identifier || nft.token_id || tokenId || null;

                const imageCacheKey = `${cfg.contract.toLowerCase()}:${onChainId}`;
                nftCache.set(imageCacheKey, {
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

        return {
          seed: seedBase,
          showcase,
          failedCollections,
        };
      }
    );

    if (SHOWCASE_DEBUG_LOGS) {
      console.log('Showcase debug:', JSON.stringify(payload, null, 2));
    }

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=900');
    res.json(payload);
  } catch (err) {
    console.error('Showcase API error:', err.message || err);
    res.status(502).json({
      seed: getDailySeedString(),
      showcase: [],
      failedCollections: SHOWCASE_COLLECTIONS.map((cfg) => cfg.key),
      error: 'Showcase unavailable',
    });
  }
});

function extractCollectionStatsPayload(rawStatsInput) {
  const rawStats = rawStatsInput || {};

  function coerceNumber(value) {
    if (value == null) return null;
    if (typeof value === 'object') {
      if (value.quantity != null) return coerceNumber(value.quantity);
      if (value.total != null) return coerceNumber(value.total);
      if (value.value != null) return coerceNumber(value.value);
    }
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
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
        const parsed = coerceNumber(value);
        if (parsed == null) continue;
        if (totalVolume == null || parsed > totalVolume) {
          totalVolume = parsed;
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

  return {
    floorPrice,
    totalVolume,
    numOwners,
    stats: rawStats,
  };
}

async function loadCollectionStatsPayload() {
  return getOrSetApiResponseCache(
    `stats:${CHAIN}:${COLLECTION_SLUG}`,
    OPENSEA_STATS_CACHE_TTL_MS,
    async () => {
      const url = `https://api.opensea.io/api/v2/collections/${COLLECTION_SLUG}/stats`;
      const data = await queueOpenSeaRequest(url, 'Stats', 25000);
      const rawStats = data.stats || data.total || data || {};
      return extractCollectionStatsPayload(rawStats);
    }
  );
}

async function loadRecentSalesPayload(limit) {
  return getOrSetApiResponseCache(
    `recent-sales:${CHAIN}:${COLLECTION_SLUG}:limit=${limit}`,
    OPENSEA_RECENT_SALES_CACHE_TTL_MS,
    async () => {
      const url =
        `https://api.opensea.io/api/v2/events/collection/${COLLECTION_SLUG}` +
        `?event_type=sale&limit=${limit}&chain=${CHAIN}`;

      const data = await queueOpenSeaRequest(url, 'Recent sales', 25000);
      const events = data.asset_events || data.events || [];

      const sales = events.map((ev) => {
        const asset = ev.asset || ev.nft || {};
        const tokenId = asset.token_id || asset.identifier || null;

        const payment = ev.payment || ev.payment_token || {};
        const totalPrice = payment.quantity || ev.total_price || null;
        const decimals = payment.decimals != null ? Number(payment.decimals) : 18;
        const symbol =
          (payment.token && payment.token.symbol) ||
          payment.symbol ||
          'ETH';

        const price = totalPrice != null ? Number(totalPrice) / 10 ** decimals : null;
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

      return { sales };
    }
  );
}

async function loadCollectionListingsPayload({ maxPages, limit, pageSize }) {
  const cacheKey =
    `listed:${CHAIN}:${COLLECTION_SLUG}:pages=${maxPages ?? 'all'}:limit=${limit}:pageSize=${pageSize}`;

  return getOrSetApiResponseCache(
    cacheKey,
    OPENSEA_LISTINGS_CACHE_TTL_MS,
    async () => {
      let allListings = [];
      let nextCursor = null;
      let page = 0;

      do {
        const url = nextCursor
          ? `https://api.opensea.io/api/v2/listings/collection/${COLLECTION_SLUG}/all?limit=${pageSize}&chain=${CHAIN}&next=${nextCursor}`
          : `https://api.opensea.io/api/v2/listings/collection/${COLLECTION_SLUG}/all?limit=${pageSize}&chain=${CHAIN}`;

        const data = await queueOpenSeaRequest(url, `Listings page ${page + 1}`);
        const listings = Array.isArray(data.listings) ? data.listings : [];
        if (!listings.length) break;
        allListings = allListings.concat(listings);
        nextCursor = data.next || null;
        page += 1;
      } while (nextCursor && (maxPages == null || page < maxPages));

      const mapped = allListings.map((listing) => {
        const nft = listing.nft || {};
        const tokenId =
          (listing.protocol_data &&
            listing.protocol_data.parameters &&
            listing.protocol_data.parameters.offer &&
            listing.protocol_data.parameters.offer[0] &&
            listing.protocol_data.parameters.offer[0].identifierOrCriteria) ||
          nft.identifier ||
          null;

        const priceRaw =
          listing.price && listing.price.current && listing.price.current.value
            ? String(listing.price.current.value)
            : null;
        const decimals =
          (listing.price &&
            listing.price.current &&
            listing.price.current.decimals &&
            Number(listing.price.current.decimals)) ||
          18;

        const price = priceRaw != null ? Number(priceRaw) / 10 ** decimals : null;
        const image_url = normaliseImageUrl(
          nft.image_url ||
            nft.image_original_url ||
            nft.display_image_url ||
            ''
        );
        const seller =
          (listing.maker && listing.maker.address) ||
          (listing.seller && listing.seller.address) ||
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

      const deduped = [];
      const seenTokenIds = new Map();

      for (const listing of mapped) {
        if (!listing.onChainId) continue;

        const tokenId = String(listing.onChainId);
        const existingIndex = seenTokenIds.get(tokenId);

        if (existingIndex === undefined) {
          seenTokenIds.set(tokenId, deduped.length);
          deduped.push(listing);
        } else {
          const existing = deduped[existingIndex];
          if (
            listing.price != null &&
            (existing.price == null || listing.price < existing.price)
          ) {
            deduped[existingIndex] = listing;
          }
        }
      }

      deduped.sort((a, b) => {
        if (a.price == null && b.price == null) return 0;
        if (a.price == null) return 1;
        if (b.price == null) return -1;
        return a.price - b.price;
      });

      const totalListed = deduped.length;
      const selected = deduped.slice(0, limit);
      const listingsWithImages = await Promise.all(
        selected.map(async (item) => {
          if (!item.onChainId) return item;

          const imageCacheKey = `${CONTRACT.toLowerCase()}:${item.onChainId}`;
          const cached = nftCache.get(imageCacheKey);

          if (cached && cached.image_url) {
            return { ...item, image_url: cached.image_url };
          }

          if (item.image_url) {
            nftCache.set(imageCacheKey, {
              ...(cached || {}),
              onChainId: String(item.onChainId),
              image_url: item.image_url,
            });
            return item;
          }

          try {
            const nftUrl = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${item.onChainId}`;
            const nftData = await queueOpenSeaRequest(nftUrl, 'Listing NFT image', 15000);
            const nft = nftData.nft || nftData || {};
            const image_url = normaliseImageUrl(
              nft.image_url ||
                nft.display_image_url ||
                nft.image_original_url ||
                nft.image ||
                ''
            );

            if (image_url) {
              nftCache.set(imageCacheKey, {
                ...(cached || {}),
                onChainId: String(item.onChainId),
                image_url,
              });
              return { ...item, image_url };
            }

            return item;
          } catch (err) {
            console.error('Failed to fetch listing NFT image', err.message || err);
            return item;
          }
        })
      );

      return {
        listings: listingsWithImages,
        totalListed,
      };
    }
  );
}

// =======================
// /api/stats
// =======================
app.get('/api/stats', async (req, res) => {
  try {
    const payload = await loadCollectionStatsPayload();

    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    res.json(payload);
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
    const limit = parseBoundedInt(req.query.limit, 5, 1, 20);
    const payload = await loadRecentSalesPayload(limit);

    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=90');
    res.json(payload);
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
    const hasPagesOverride =
      req.query.pages != null && String(req.query.pages).trim() !== '';
    const maxPages = hasPagesOverride
      ? parseBoundedInt(
          req.query.pages,
          LISTED_DEFAULT_MAX_PAGES,
          1,
          LISTED_MAX_PAGES_CAP
        )
      : null;
    const limit = parseBoundedInt(
      req.query.limit,
      LISTED_DEFAULT_RESULT_LIMIT,
      8,
      LISTED_RESULT_LIMIT_CAP
    );
    const pageSize = parseBoundedInt(
      req.query.pageSize,
      LISTED_PAGE_SIZE_DEFAULT,
      20,
      50
    );

    const payload = await loadCollectionListingsPayload({
      maxPages,
      limit,
      pageSize,
    });

    res.setHeader('Cache-Control', 'public, max-age=20, stale-while-revalidate=120');
    res.json(payload);
  } catch (err) {
    console.error('Listings API error:', err.message || err);
    res.status(502).json({ listings: [], totalListed: 0, error: 'Listings unavailable' });
  }
});

// =======================
// /api/explorer/status
// =======================
app.get('/api/explorer/status', (req, res) => {
  const traitIndex = readJsonFileCached(explorerTraitIndexPath);
  const tokenBlob = readJsonFileCached(explorerTokenBlobPath);
  res.setHeader('Cache-Control', 'no-store');

  res.json({
    ready: Boolean(traitIndex && tokenBlob),
    generatedAt:
      traitIndex?.generatedAt || tokenBlob?.generatedAt || null,
    totalSupply:
      Number(traitIndex?.totalSupply) || Number(tokenBlob?.totalSupply) || null,
    files: {
      traitIndex: Boolean(traitIndex),
      tokenBlob: Boolean(tokenBlob),
    },
  });
});

// =======================
// /api/holders/summary
// =======================
app.get('/api/holders/summary', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const resolved = await resolveHolderSnapshot({ requireFresh: false });
  const latest = resolved.snapshot;
  if (!latest) {
    return res.status(503).json({
      error: 'Holder data unavailable',
      message: 'Live holder scan failed and no fallback snapshot exists.',
      details: resolved.liveError ? String(resolved.liveError.message || resolved.liveError) : null,
    });
  }

  return res.json({
    generatedAt: latest.generatedAt || null,
    chain: latest.chain || CHAIN,
    contract: latest.contract || CONTRACT,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
      stale:
        resolved.isLive &&
        holderLiveState.generatedAtMs > 0 &&
        Date.now() - holderLiveState.generatedAtMs > HOLDER_LIVE_CACHE_TTL_MS,
      cacheAgeMs:
        resolved.isLive && holderLiveState.generatedAtMs > 0
          ? Math.max(0, Date.now() - holderLiveState.generatedAtMs)
          : null,
    },
    summary: latest.summary || {},
  });
});

// =======================
// /api/holders/top
// =======================
app.get('/api/holders/top', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const resolved = await resolveHolderSnapshot({ requireFresh: false });
  const latest = resolved.snapshot;
  if (!latest) {
    return res.status(503).json({
      holders: [],
      error: 'Holder data unavailable',
    });
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 25, 250));
  const includeTokens = String(req.query.includeTokens || '') === '1';

  const topHolders = getTopHoldersFromSnapshot(latest, limit).map((holder) => ({
    rank: holder.rank,
    address: holder.address,
    balance: holder.balance,
    shareOfSupplyPct: holder.shareOfSupplyPct,
    tokenPreview: holder.tokenPreview,
    tokenIds: includeTokens ? holder.tokenPreview : undefined,
    lastActivity: holder.lastActivity,
  }));

  return res.json({
    generatedAt: latest.generatedAt || null,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
    },
    summary: latest.summary || {},
    holders: topHolders,
  });
});

// =======================
// /api/holders/cohorts
// =======================
app.get('/api/holders/cohorts', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const resolved = await resolveHolderSnapshot({ requireFresh: false });
  const latest = resolved.snapshot;
  if (!latest) {
    return res.status(503).json({
      cohorts: [],
      error: 'Holder data unavailable',
    });
  }

  const holders = getSnapshotHolders(latest);
  const supplyAccounted =
    Number(latest?.summary?.supplyAccounted) ||
    holders.reduce((sum, holder) => sum + holder.balance, 0);

  const cohorts =
    Array.isArray(latest.cohorts) && latest.cohorts.length > 0
      ? latest.cohorts
      : buildCohortsFromHolders(holders, supplyAccounted);

  return res.json({
    generatedAt: latest.generatedAt || null,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
    },
    supplyAccounted,
    cohorts,
  });
});

// =======================
// /api/holders/deltas
// =======================
app.get('/api/holders/deltas', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const resolved = await resolveHolderSnapshot({ requireFresh: false });
  const latest = resolved.snapshot;
  if (!latest) {
    return res.status(503).json({
      error: 'Holder data unavailable',
    });
  }

  let previous = null;
  if (resolved.isLive && holderLiveState.previousSnapshot) {
    previous = holderLiveState.previousSnapshot;
  } else {
    const history = readJsonFileCached(holderHistoryPath);
    const snapshots = Array.isArray(history?.snapshots)
      ? [...history.snapshots].sort((a, b) => {
          const at = new Date(a?.generatedAt || 0).getTime();
          const bt = new Date(b?.generatedAt || 0).getTime();
          return at - bt;
        })
      : [];
    previous = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 25, 100));

  if (!previous) {
    return res.json({
      generatedAt: latest.generatedAt || null,
      previousGeneratedAt: null,
      summaryDelta: {
        holderCount: 0,
        supplyAccounted: 0,
        top10SharePct: 0,
        top25SharePct: 0,
        entrants: 0,
        exits: 0,
      },
      movers: [],
    });
  }

  const latestBalances = getSnapshotBalanceMap(latest);
  const previousBalances = getSnapshotBalanceMap(previous);
  const allAddresses = new Set([
    ...latestBalances.keys(),
    ...previousBalances.keys(),
  ]);

  let entrants = 0;
  let exits = 0;
  const movers = [];

  for (const address of allAddresses) {
    const currentBalance = latestBalances.get(address) || 0;
    const previousBalance = previousBalances.get(address) || 0;
    const delta = currentBalance - previousBalance;

    if (previousBalance === 0 && currentBalance > 0) entrants += 1;
    if (previousBalance > 0 && currentBalance === 0) exits += 1;

    if (delta !== 0) {
      movers.push({
        address,
        delta,
        currentBalance,
        previousBalance,
      });
    }
  }

  movers.sort((a, b) => {
    const absDiff = Math.abs(b.delta) - Math.abs(a.delta);
    if (absDiff !== 0) return absDiff;
    if (b.delta !== a.delta) return b.delta - a.delta;
    return a.address.localeCompare(b.address);
  });

  const latestSummary = latest.summary || {};
  const prevSummary = previous.summary || {};

  return res.json({
    generatedAt: latest.generatedAt || null,
    previousGeneratedAt: previous.generatedAt || null,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
    },
    summaryDelta: {
      holderCount:
        (Number(latestSummary.holderCount) || latestBalances.size) -
        (Number(prevSummary.holderCount) || previousBalances.size),
      supplyAccounted:
        (Number(latestSummary.supplyAccounted) || 0) -
        (Number(prevSummary.supplyAccounted) || 0),
      top10SharePct:
        Number(
          (
            (Number(latestSummary.top10SharePct) || 0) -
            (Number(prevSummary.top10SharePct) || 0)
          ).toFixed(3)
        ),
      top25SharePct:
        Number(
          (
            (Number(latestSummary.top25SharePct) || 0) -
            (Number(prevSummary.top25SharePct) || 0)
          ).toFixed(3)
        ),
      entrants,
      exits,
    },
    movers: movers.slice(0, limit),
  });
});

// =======================
// /api/holders/:address
// =======================
app.get('/api/holders/:address', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const address = normaliseAddress(req.params.address);
  if (!address) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  let resolved = await resolveHolderSnapshot({ requireFresh: false });
  let latest = resolved.snapshot;
  if (!latest) {
    return res.status(503).json({
      error: 'Holder data unavailable',
      details: resolved.liveError ? String(resolved.liveError.message || resolved.liveError) : null,
    });
  }

  let holders = getSnapshotHolders(latest);
  let found =
    holders.find((holder) => holder.address === address) || null;

  if (
    !found &&
    HOLDER_LIVE_MODE_ENABLED &&
    HOLDER_LIVE_FORCE_REFRESH_ON_LOOKUP
  ) {
    const refreshed = await resolveHolderSnapshot({ requireFresh: true });
    if (refreshed.snapshot) {
      resolved = refreshed;
      latest = refreshed.snapshot;
      holders = getSnapshotHolders(latest);
      found = holders.find((holder) => holder.address === address) || null;
    }
  }

  if (!found) {
    return res.status(404).json({
      generatedAt: latest.generatedAt || null,
      address,
      balance: 0,
      rank: null,
      percentile: 0,
      tokenIds: [],
      lastActivity: null,
    });
  }

  let rank = 1;
  holders.forEach((holder) => {
    if (holder.address === address) return;
    if (holder.balance > found.balance) rank += 1;
    if (holder.balance === found.balance && holder.address < address) rank += 1;
  });

  const totalHolders = holders.length;
  const percentile =
    totalHolders > 0
      ? Number((((totalHolders - rank + 1) / totalHolders) * 100).toFixed(2))
      : 0;

  return res.json({
    generatedAt: latest.generatedAt || null,
    source: {
      ...(latest.source || {}),
      mode: resolved.isLive ? 'live' : 'snapshot',
    },
    address,
    balance: found.balance,
    rank,
    percentile,
    tokenIds: Array.isArray(found.tokenIds) ? found.tokenIds : [],
    lastActivity: found.lastActivity || null,
  });
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

// =======================
// ONCHAIN TOKEN METADATA + IMAGES
// =======================
const ONCHAIN_TOKEN_URI_ABI = ['function tokenURI(uint256 tokenId) view returns (string)'];
const ONCHAIN_CHAIN_ID = Number(process.env.CHAIN_ID || (CHAIN.toLowerCase() === 'base' ? 8453 : 1));
const ONCHAIN_RPC_URLS = String(
  process.env.ONCHAIN_RPC_URLS ||
    process.env.BASE_RPC_URL ||
    'https://mainnet.base.org,https://base.llamarpc.com,https://base-rpc.publicnode.com,https://1rpc.io/base'
)
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

const onchainTokenCache = new Map();
let onchainContracts = null;
const publicAssetExistsCache = new Map();

function normalizeIpfsUri(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (text.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${text.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  }
  return text;
}

function isLocalPublicPath(value) {
  const text = String(value || '').trim();
  return text.startsWith('/public/');
}

function doesLocalPublicAssetExist(publicPath) {
  const normalized = String(publicPath || '').trim();
  if (!normalized || !isLocalPublicPath(normalized)) return false;

  const cached = publicAssetExistsCache.get(normalized);
  if (cached != null) return cached;

  const absPath = path.join(__dirname, normalized.replace(/^\/+/, ''));
  let exists = false;
  try {
    exists = fs.existsSync(absPath);
  } catch {
    exists = false;
  }
  publicAssetExistsCache.set(normalized, exists);
  return exists;
}

function decodeDataJsonUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const lower = uri.toLowerCase();

  if (lower.startsWith('data:application/json;base64,')) {
    const payload = uri.slice('data:application/json;base64,'.length);
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  }
  if (lower.startsWith('data:application/json;utf8,')) {
    const payload = uri.slice('data:application/json;utf8,'.length);
    return JSON.parse(decodeURIComponent(payload));
  }
  if (lower.startsWith('data:application/json,')) {
    const payload = uri.slice('data:application/json,'.length);
    return JSON.parse(decodeURIComponent(payload));
  }

  return null;
}

function parseDataUri(value) {
  if (!value || typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^data:/i.test(text)) return null;

  const commaIndex = text.indexOf(',');
  if (commaIndex === -1) return null;

  const metadata = text.slice(5, commaIndex);
  const payload = text.slice(commaIndex + 1);
  const parts = metadata
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const contentType = (parts[0] || 'application/octet-stream').toLowerCase();
  const isBase64 = parts.some((part) => part.toLowerCase() === 'base64');

  if (isBase64) {
    return {
      contentType,
      body: Buffer.from(payload, 'base64'),
    };
  }

  let decoded = payload;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    decoded = payload;
  }

  return {
    contentType,
    body: Buffer.from(decoded, 'utf8'),
  };
}

function normalizeTokenAttributes(metadata) {
  const attrs = Array.isArray(metadata?.attributes)
    ? metadata.attributes
    : Array.isArray(metadata?.traits)
    ? metadata.traits
    : [];

  return attrs
    .map((entry) => {
      const trait_type = String(entry?.trait_type || entry?.type || '').trim();
      const value = String(entry?.value ?? '').trim();
      if (!trait_type || !value) return null;
      return { trait_type, value };
    })
    .filter(Boolean);
}

function getOnchainContracts() {
  if (!ethers) return [];
  if (Array.isArray(onchainContracts)) return onchainContracts;

  onchainContracts = ONCHAIN_RPC_URLS.map((rpcUrl) => {
    const provider = Number.isFinite(ONCHAIN_CHAIN_ID)
      ? new ethers.providers.JsonRpcProvider(rpcUrl, ONCHAIN_CHAIN_ID)
      : new ethers.providers.JsonRpcProvider(rpcUrl);
    return new ethers.Contract(CONTRACT, ONCHAIN_TOKEN_URI_ABI, provider);
  });

  return onchainContracts;
}

async function resolveTokenUriFromChain(tokenId) {
  const contracts = getOnchainContracts();
  if (!contracts.length) {
    throw new Error('Onchain RPC contracts unavailable');
  }

  let lastErr = null;
  for (let i = 0; i < contracts.length; i += 1) {
    try {
      return await contracts[i].tokenURI(tokenId);
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('tokenURI failed across all RPC endpoints');
}

async function fetchJsonFromRemoteUrl(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      headers: { accept: 'application/json,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Remote JSON fetch failed (${res.status}): ${body.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getOnchainTokenMetadata(tokenId, options = {}) {
  const requireImage = options && options.requireImage === true;
  const bypassCache = options && options.bypassCache === true;
  const skipSnapshot = options && options.skipSnapshot === true;
  const key = String(tokenId);

  if (!bypassCache) {
    const cached = onchainTokenCache.get(key);
    if (cached) {
      const resolved = cached instanceof Promise ? await cached : cached;
      if (!requireImage || getImageCandidateFromMetadata(resolved)) {
        return resolved;
      }
    }
  }

  if (!skipSnapshot) {
    const snapshotMeta = getOnchainSnapshotMetadata(tokenId);
    if (snapshotMeta) {
      const snapshotImage = getImageCandidateFromMetadata(snapshotMeta);
      const snapshotImageUsable =
        !requireImage ||
        (snapshotImage &&
          (!isLocalPublicPath(snapshotImage) || doesLocalPublicAssetExist(snapshotImage)));

      if (snapshotImageUsable) {
        onchainTokenCache.set(key, snapshotMeta);
        return snapshotMeta;
      }
    }
  }

  const inflight = (async () => {
    const tokenUri = await resolveTokenUriFromChain(tokenId);
    let metadata = decodeDataJsonUri(tokenUri);
    if (!metadata) {
      const normalizedTokenUri = normalizeIpfsUri(tokenUri);
      if (!/^https?:\/\//i.test(normalizedTokenUri)) {
        throw new Error(`Unsupported tokenURI format for token ${tokenId}`);
      }
      metadata = await fetchJsonFromRemoteUrl(normalizedTokenUri, 20000);
    }

    const attributes = normalizeTokenAttributes(metadata);
    const image = normalizeIpfsUri(metadata?.image || metadata?.image_data || '');
    const image_data = normalizeIpfsUri(metadata?.image_data || '');

    return {
      tokenId,
      tokenURI: tokenUri,
      name: String(metadata?.name || `No-Punk #${tokenId}`),
      description: String(metadata?.description || ''),
      attributes,
      image,
      image_data,
      external_url: normalizeIpfsUri(metadata?.external_url || ''),
      raw: metadata,
      source: 'onchain-tokenURI',
    };
  })();

  if (!bypassCache) {
    onchainTokenCache.set(key, inflight);
  }
  try {
    const resolved = await inflight;
    onchainTokenCache.set(key, resolved);
    return resolved;
  } catch (err) {
    onchainTokenCache.delete(key);
    throw err;
  }
}

function getImageCandidateFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  const candidates = [
    metadata.image,
    metadata.image_data,
    metadata.raw?.image,
    metadata.raw?.image_data,
  ];

  for (const candidate of candidates) {
    const value = normalizeIpfsUri(candidate);
    if (value) return value;
  }
  return '';
}

async function sendTokenImageResponse(res, tokenId) {
  let metadata = await getOnchainTokenMetadata(tokenId, { requireImage: true });
  let imageValue = getImageCandidateFromMetadata(metadata);

  if (isLocalPublicPath(imageValue) && !doesLocalPublicAssetExist(imageValue)) {
    metadata = await getOnchainTokenMetadata(tokenId, {
      requireImage: true,
      bypassCache: true,
      skipSnapshot: true,
    });
    imageValue = getImageCandidateFromMetadata(metadata);
  }

  if (!imageValue) {
    return res.status(404).json({ error: 'Onchain image unavailable' });
  }

  if (imageValue.startsWith('<svg')) {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    return res.send(imageValue);
  }

  const dataUri = parseDataUri(imageValue);
  if (dataUri) {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', dataUri.contentType || 'application/octet-stream');
    return res.send(dataUri.body);
  }

  const normalizedUrl = normalizeIpfsUri(imageValue);
  if (normalizedUrl.startsWith('/public/')) {
    if (!doesLocalPublicAssetExist(normalizedUrl)) {
      return res.status(404).json({ error: 'Onchain image cache file unavailable' });
    }
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.redirect(302, normalizedUrl);
  }
  if (/^https?:\/\//i.test(normalizedUrl)) {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.redirect(302, normalizedUrl);
  }

  return res.status(404).json({ error: 'Unsupported onchain image format' });
}

app.get('/api/onchain/token/:tokenId', async (req, res) => {
  try {
    const tokenId = parseOnChainTokenId(req.params.tokenId);
    if (tokenId == null) {
      return res.status(400).json({ error: 'Invalid tokenId' });
    }
    const metadata = await getOnchainTokenMetadata(tokenId);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    return res.json(metadata);
  } catch (err) {
    console.error('Onchain token metadata error:', err.message || err);
    return res.status(502).json({ error: 'Onchain token metadata unavailable' });
  }
});

app.get('/api/onchain/token/:tokenId/image', async (req, res) => {
  try {
    const tokenId = parseOnChainTokenId(req.params.tokenId);
    if (tokenId == null) {
      return res.status(400).json({ error: 'Invalid tokenId' });
    }
    return await sendTokenImageResponse(res, tokenId);
  } catch (err) {
    console.error('Onchain token image error:', err.message || err);
    return res.status(502).json({ error: 'Onchain token image unavailable' });
  }
});

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
// HOLDER SNAPSHOT AUTO-REBUILD
// =======================
let holderAutoRebuildInFlight = false;
let holderAutoRebuildNextAllowedAt = 0;
let holderAutoRebuildIntervalHandle = null;
let holderAutoRebuildStartupHandle = null;

function formatMsAsSeconds(ms) {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

function buildHolderRebuildArgs() {
  const args = [
    path.join(__dirname, 'scripts', 'build-holder-snapshots.mjs'),
    '--source',
    HOLDER_AUTO_REBUILD_SOURCE,
    '--chain',
    CHAIN,
    '--contract',
    CONTRACT.toLowerCase(),
    '--rpc-url',
    HOLDER_AUTO_REBUILD_RPC_URL,
    '--owner-batch-size',
    String(HOLDER_AUTO_REBUILD_OWNER_BATCH_SIZE),
    '--total-supply',
    String(HOLDER_AUTO_REBUILD_SUPPLY),
  ];

  if (process.env.CHAIN_ID) {
    args.push('--chain-id', String(process.env.CHAIN_ID));
  }

  return args;
}

async function runHolderSnapshotAutoRebuild(trigger) {
  if (!HOLDER_AUTO_REBUILD_ENABLED) return false;
  if (holderAutoRebuildInFlight) {
    console.log(`[holders:auto] Skip ${trigger}; rebuild already running.`);
    return false;
  }

  const now = Date.now();
  if (now < holderAutoRebuildNextAllowedAt) {
    const waitMs = holderAutoRebuildNextAllowedAt - now;
    console.log(
      `[holders:auto] Skip ${trigger}; cooldown active (${formatMsAsSeconds(waitMs)} remaining).`
    );
    return false;
  }

  holderAutoRebuildInFlight = true;
  const startedAt = Date.now();
  const args = buildHolderRebuildArgs();

  console.log(
    `[holders:auto] Starting holder snapshot rebuild (${trigger}).`
  );

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, HOLDER_AUTO_REBUILD_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const line = String(chunk || '').trim();
      if (line) console.log(`[holders:auto] ${line}`);
    });

    child.stderr.on('data', (chunk) => {
      const line = String(chunk || '').trim();
      if (line) console.warn(`[holders:auto] ${line}`);
    });

    child.once('error', (err) => {
      clearTimeout(timeoutHandle);
      holderAutoRebuildInFlight = false;
      holderAutoRebuildNextAllowedAt =
        Date.now() + HOLDER_AUTO_REBUILD_RETRY_DELAY_MS;
      console.error(
        `[holders:auto] Rebuild process failed to start: ${err.message || err}`
      );
      resolve(false);
    });

    child.once('close', (code, signal) => {
      clearTimeout(timeoutHandle);
      holderAutoRebuildInFlight = false;

      const elapsedMs = Date.now() - startedAt;
      if (code === 0 && !timedOut) {
        holderAutoRebuildNextAllowedAt = 0;
        const latest = readJsonFileCached(holderLatestPath);
        const generatedAt = latest?.generatedAt || null;
        const generatedText = generatedAt
          ? new Date(generatedAt).toLocaleString()
          : 'unknown';
        console.log(
          `[holders:auto] Rebuild complete in ${formatMsAsSeconds(elapsedMs)}; snapshot=${generatedText}.`
        );
        resolve(true);
        return;
      }

      holderAutoRebuildNextAllowedAt =
        Date.now() + HOLDER_AUTO_REBUILD_RETRY_DELAY_MS;
      console.error(
        `[holders:auto] Rebuild failed (code=${code}, signal=${signal || 'none'}, timeout=${timedOut}) after ` +
          `${formatMsAsSeconds(elapsedMs)}. Retrying in ${formatMsAsSeconds(HOLDER_AUTO_REBUILD_RETRY_DELAY_MS)}.`
      );
      resolve(false);
    });
  });
}

function startHolderSnapshotAutoRebuild() {
  if (HOLDER_LIVE_MODE_ENABLED && !String(process.env.HOLDER_AUTO_REBUILD || '').trim()) {
    console.log('[holders:auto] Live holder mode is enabled; snapshot auto-rebuild is skipped.');
    return;
  }

  if (!HOLDER_AUTO_REBUILD_ENABLED) {
    console.log('[holders:auto] Disabled (set HOLDER_AUTO_REBUILD=1 to enable).');
    return;
  }

  if (holderAutoRebuildIntervalHandle || holderAutoRebuildStartupHandle) {
    return;
  }

  console.log(
    `[holders:auto] Enabled interval=${formatMsAsSeconds(HOLDER_AUTO_REBUILD_INTERVAL_MS)} ` +
      `startupDelay=${formatMsAsSeconds(HOLDER_AUTO_REBUILD_STARTUP_DELAY_MS)} ` +
      `timeout=${formatMsAsSeconds(HOLDER_AUTO_REBUILD_TIMEOUT_MS)}.`
  );

  holderAutoRebuildStartupHandle = setTimeout(() => {
    runHolderSnapshotAutoRebuild('startup').catch((err) => {
      console.error('[holders:auto] Startup rebuild threw:', err.message || err);
    });
  }, HOLDER_AUTO_REBUILD_STARTUP_DELAY_MS);

  holderAutoRebuildIntervalHandle = setInterval(() => {
    runHolderSnapshotAutoRebuild('interval').catch((err) => {
      console.error('[holders:auto] Interval rebuild threw:', err.message || err);
    });
  }, HOLDER_AUTO_REBUILD_INTERVAL_MS);
}

// =======================
// START SERVER
// =======================
function handleServerStartup(serverPort) {
  console.log(
    `NoPunks server running at http://localhost:${serverPort}\n` +
      `Collection slug: ${COLLECTION_SLUG} | Chain: ${CHAIN} | Contract: ${CONTRACT}` +
      (MARKETPLACE_CONTRACT ? `\nMarketplace: ${MARKETPLACE_CONTRACT}` : '')
  );

  if (HOLDER_LIVE_MODE_ENABLED) {
    setTimeout(() => {
      refreshLiveHolderSnapshot('startup')
        .then((snapshot) => {
          console.log(
            `[holders:live] Startup refresh ready (${snapshot?.summary?.holderCount || 0} holders, ${
              snapshot?.summary?.supplyAccounted || 0
            } tokens).`
          );
        })
        .catch((err) => {
          console.error('[holders:live] Startup refresh failed:', err.message || err);
        });
    }, 1200);
  }

  startHolderSnapshotAutoRebuild();
}

function startServer(port = PORT, host) {
  if (host) {
    return app.listen(port, host, () => handleServerStartup(port));
  }
  return app.listen(port, () => handleServerStartup(port));
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
};
