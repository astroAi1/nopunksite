#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { ethers } from 'ethers';

const DEFAULT_CONTRACT = '0xa62f65d503068684e7228df98090F94322b8ed54';
const DEFAULT_TOKEN_MAP_PATH = './public/token_map.json';
const DEFAULT_OUT_PATH = './public/data/explorer/onchain_traits.json';
const DEFAULT_TOTAL = 10000;
const DEFAULT_RPC_URLS = [
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base',
  'https://mainnet.base.org',
];
const TOKEN_URI_ABI = ['function tokenURI(uint256 tokenId) view returns (string)'];
const TOKEN_URI_INTERFACE = new ethers.utils.Interface(TOKEN_URI_ABI);

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    total: DEFAULT_TOTAL,
    tokenMapPath: DEFAULT_TOKEN_MAP_PATH,
    useTokenMap: false,
    outPath: DEFAULT_OUT_PATH,
    imageCacheDir: './public/data/explorer/images',
    writeImageCache: true,
    contract: DEFAULT_CONTRACT,
    rpcUrls: DEFAULT_RPC_URLS.join(','),
    start: 0,
    end: DEFAULT_TOTAL - 1,
    concurrency: 16,
    retries: 2,
    httpTimeoutMs: 15000,
    resume: true,
    allowPartial: false,
    logEvery: 250,
    chainId: '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--total') parsed.total = Number.parseInt(next, 10);
    if (arg === '--token-map') parsed.tokenMapPath = next;
    if (arg === '--use-token-map') parsed.useTokenMap = true;
    if (arg === '--out') parsed.outPath = next;
    if (arg === '--image-cache-dir') parsed.imageCacheDir = next;
    if (arg === '--no-image-cache') parsed.writeImageCache = false;
    if (arg === '--image-cache') parsed.writeImageCache = true;
    if (arg === '--contract') parsed.contract = next;
    if (arg === '--rpc-url') parsed.rpcUrls = next;
    if (arg === '--start') parsed.start = Number.parseInt(next, 10);
    if (arg === '--end') parsed.end = Number.parseInt(next, 10);
    if (arg === '--concurrency') parsed.concurrency = Number.parseInt(next, 10);
    if (arg === '--retries') parsed.retries = Number.parseInt(next, 10);
    if (arg === '--http-timeout-ms') parsed.httpTimeoutMs = Number.parseInt(next, 10);
    if (arg === '--log-every') parsed.logEvery = Number.parseInt(next, 10);
    if (arg === '--chain-id') parsed.chainId = String(next || '').trim();
    if (arg === '--resume') parsed.resume = true;
    if (arg === '--no-resume') parsed.resume = false;
    if (arg === '--allow-partial') parsed.allowPartial = true;
  }

  parsed.total = Number.isFinite(parsed.total) ? parsed.total : DEFAULT_TOTAL;
  parsed.total = Math.max(1, parsed.total);
  parsed.start = Number.isFinite(parsed.start) ? Math.max(0, parsed.start) : 0;
  parsed.end =
    Number.isFinite(parsed.end) ? Math.min(parsed.total - 1, parsed.end) : parsed.total - 1;
  if (parsed.end < parsed.start) {
    parsed.end = parsed.start;
  }
  parsed.concurrency = Number.isFinite(parsed.concurrency)
    ? Math.max(1, Math.min(parsed.concurrency, 64))
    : 16;
  parsed.retries = Number.isFinite(parsed.retries) ? Math.max(0, parsed.retries) : 2;
  parsed.httpTimeoutMs = Number.isFinite(parsed.httpTimeoutMs)
    ? Math.max(1000, parsed.httpTimeoutMs)
    : 15000;
  parsed.logEvery = Number.isFinite(parsed.logEvery) ? Math.max(1, parsed.logEvery) : 250;

  return parsed;
}

function normalizeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function splitRpcUrls(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function countStoredTokens(payload) {
  return Array.isArray(payload?.tokens) ? payload.tokens.length : 0;
}

function normalizeTokenId(rawValue, fallbackIndex) {
  if (rawValue == null) return fallbackIndex;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
  const text = String(rawValue).trim();
  if (!text) return fallbackIndex;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  return text;
}

function buildIndexToTokenId(tokenMapRaw, totalSupply) {
  const out = new Array(totalSupply);
  for (let i = 0; i < totalSupply; i += 1) {
    out[i] = i;
  }

  if (Array.isArray(tokenMapRaw)) {
    tokenMapRaw.forEach((tokenId, index) => {
      if (index >= 0 && index < totalSupply) {
        out[index] = normalizeTokenId(tokenId, index);
      }
    });
    return out;
  }

  if (tokenMapRaw && typeof tokenMapRaw === 'object') {
    Object.entries(tokenMapRaw).forEach(([indexKey, tokenId]) => {
      const index = Number.parseInt(indexKey, 10);
      if (!Number.isFinite(index) || index < 0 || index >= totalSupply) return;
      out[index] = normalizeTokenId(tokenId, index);
    });
  }

  return out;
}

function normalizeAttributes(meta) {
  const attrs = Array.isArray(meta?.attributes)
    ? meta.attributes
    : Array.isArray(meta?.traits)
    ? meta.traits
    : [];

  const out = [];
  const seen = new Set();

  attrs.forEach((trait) => {
    const type = normalizeString(trait?.trait_type || trait?.type);
    const value = normalizeString(trait?.value);
    if (!type || !value) return;

    const key = `${type}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([type, value]);
  });

  return out;
}

function decodeDataJsonUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const lower = uri.toLowerCase();

  if (lower.startsWith('data:application/json;base64,')) {
    const base64Payload = uri.slice('data:application/json;base64,'.length);
    const decoded = Buffer.from(base64Payload, 'base64').toString('utf8');
    return JSON.parse(decoded);
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

function normalizeExternalUri(uri) {
  if (!uri) return '';
  const text = String(uri).trim();
  if (!text) return '';

  if (text.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${text.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  }
  return text;
}

function parseDataUri(value) {
  const text = normalizeString(value);
  if (!text || !/^data:/i.test(text)) return null;

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

function extensionForContentType(contentType) {
  const type = normalizeString(contentType).toLowerCase();
  if (type.includes('svg')) return 'svg';
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'bin';
}

async function writeImageCacheFile(ctx, tokenId, contentType, body) {
  if (!ctx.writeImageCache) return '';
  const safeTokenId = String(tokenId).replace(/[^a-z0-9_-]/gi, '_');
  const ext = extensionForContentType(contentType);
  const fileName = `${safeTokenId}.${ext}`;
  const absPath = path.join(ctx.imageCacheDirAbs, fileName);
  await fs.writeFile(absPath, body);
  const rel = path.relative(ctx.cwd, absPath).split(path.sep).join('/');
  return `/${rel.replace(/^\/+/, '')}`;
}

async function extractMetadataImage(meta, tokenId, ctx) {
  if (!meta || typeof meta !== 'object') return '';
  const candidates = [meta.image, meta.image_data, meta.imageUrl, meta.image_url];
  for (const candidate of candidates) {
    const raw = normalizeString(candidate);
    if (!raw) continue;

    if (raw.startsWith('<svg')) {
      const cached = await writeImageCacheFile(
        ctx,
        tokenId,
        'image/svg+xml',
        Buffer.from(raw, 'utf8')
      );
      if (cached) return cached;
      continue;
    }

    const dataUri = parseDataUri(raw);
    if (dataUri) {
      const cached = await writeImageCacheFile(
        ctx,
        tokenId,
        dataUri.contentType,
        dataUri.body
      );
      if (cached) return cached;
      continue;
    }

    const value = normalizeExternalUri(raw);
    if (!value) continue;
    return value;
  }
  return '';
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function metadataFromTokenUri(tokenUri, timeoutMs) {
  const inline = decodeDataJsonUri(tokenUri);
  if (inline) return inline;

  const external = normalizeExternalUri(tokenUri);
  if (!external || !/^https?:\/\//i.test(external)) {
    throw new Error(`Unsupported tokenURI format: ${String(tokenUri).slice(0, 80)}`);
  }

  return fetchJsonWithTimeout(external, timeoutMs);
}

let rpcIdCounter = 1;

async function rpcCall(rpcUrl, method, params) {
  const body = {
    jsonrpc: '2.0',
    id: rpcIdCounter++,
    method,
    params,
  };

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${method} failed (${res.status}): ${text.slice(0, 220)}`);
  }

  const json = await res.json();
  if (json?.error) {
    const message = json.error?.message || JSON.stringify(json.error);
    throw new Error(`RPC ${method} error: ${message}`);
  }

  return json?.result;
}

async function rpcCallWithFallback(rpcUrls, method, params) {
  let lastError = null;

  for (let i = 0; i < rpcUrls.length; i += 1) {
    const rpcUrl = rpcUrls[i];
    try {
      const result = await rpcCall(rpcUrl, method, params);
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`RPC ${method} failed across all endpoints`);
}

function encodeTokenUriCall(tokenId) {
  try {
    return TOKEN_URI_INTERFACE.encodeFunctionData('tokenURI', [tokenId]);
  } catch {
    return null;
  }
}

function decodeTokenUriResult(rawResult) {
  try {
    const [value] = TOKEN_URI_INTERFACE.decodeFunctionResult('tokenURI', rawResult);
    return String(value || '');
  } catch {
    return '';
  }
}

async function resolveTokenUriWithTimeout(rpcUrls, contractAddress, tokenId, timeoutMs) {
  const timeout = Math.max(1000, Number(timeoutMs) || 15000);
  let lastError = null;
  const callData = encodeTokenUriCall(tokenId);
  if (!callData) {
    throw new Error(`Could not encode tokenURI call for tokenId=${tokenId}`);
  }

  for (let i = 0; i < rpcUrls.length; i += 1) {
    const rpcUrl = rpcUrls[i];
    try {
      const rawResult = await Promise.race([
        rpcCall(rpcUrl, 'eth_call', [{ to: contractAddress, data: callData }, 'latest']),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`tokenURI timeout after ${timeout}ms`)), timeout);
        }),
      ]);
      const tokenUri = decodeTokenUriResult(rawResult);
      if (!tokenUri) {
        throw new Error(`Empty tokenURI result for tokenId=${tokenId}`);
      }
      return tokenUri;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('tokenURI failed across all RPC endpoints');
}

function decodeHexInt(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  if (text.startsWith('0x') || text.startsWith('0X')) {
    const n = Number.parseInt(text.slice(2), 16);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

async function detectChainId(rpcUrls) {
  try {
    const hexId = await rpcCallWithFallback(rpcUrls, 'eth_chainId', []);
    const chainId = decodeHexInt(hexId);
    return chainId > 0 ? String(chainId) : '';
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseExistingTokenMap(existingRaw) {
  const map = new Map();
  if (!existingRaw || typeof existingRaw !== 'object') return map;

  if (Array.isArray(existingRaw.tokens)) {
    existingRaw.tokens.forEach((entry) => {
      if (!entry || entry.id == null || entry.i == null) return;
      map.set(String(entry.id), {
        id: entry.id,
        i: Number(entry.i),
        n: normalizeString(entry.n) || `No-Punk #${entry.id}`,
        a: Array.isArray(entry.a) ? entry.a : [],
        im: normalizeString(entry.im || ''),
      });
    });
  }

  if (existingRaw.tokenTraitsById && typeof existingRaw.tokenTraitsById === 'object') {
    Object.entries(existingRaw.tokenTraitsById).forEach(([tokenId, entry]) => {
      if (!entry || entry.i == null) return;
      map.set(String(tokenId), {
        id: normalizeTokenId(tokenId, tokenId),
        i: Number(entry.i),
        n: normalizeString(entry.n) || `No-Punk #${tokenId}`,
        a: Array.isArray(entry.a) ? entry.a : [],
        im: normalizeString(entry.im || ''),
      });
    });
  }

  return map;
}

async function main() {
  const cfg = parseArgs();
  const cwd = process.cwd();

  const rpcUrls = splitRpcUrls(cfg.rpcUrls);
  if (!rpcUrls.length) {
    throw new Error('At least one RPC URL is required. Pass --rpc-url with comma-separated URLs.');
  }

  const tokenMapPath = path.resolve(cwd, cfg.tokenMapPath);
  const outPath = path.resolve(cwd, cfg.outPath);
  const partialOutPath = `${outPath}.partial`;
  const imageCacheDirAbs = path.resolve(cwd, cfg.imageCacheDir || './public/data/explorer/images');
  const imageContext = {
    cwd,
    writeImageCache: cfg.writeImageCache !== false,
    imageCacheDirAbs,
  };
  const contractAddress = normalizeString(cfg.contract).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(contractAddress)) {
    throw new Error(`Invalid contract address: ${cfg.contract}`);
  }

  if (imageContext.writeImageCache) {
    await fs.mkdir(imageCacheDirAbs, { recursive: true });
  }

  const tokenMapRaw = cfg.useTokenMap ? await readJsonSafe(tokenMapPath) : null;
  const indexToTokenId = buildIndexToTokenId(tokenMapRaw, cfg.total);

  const [existingMain, existingPartial] = cfg.resume
    ? await Promise.all([readJsonSafe(outPath), readJsonSafe(partialOutPath)])
    : [null, null];
  const existing =
    countStoredTokens(existingPartial) > countStoredTokens(existingMain)
      ? existingPartial
      : existingMain;
  const tokenById = parseExistingTokenMap(existing);

  const queue = [];
  for (let i = cfg.start; i <= cfg.end; i += 1) {
    queue.push(i);
  }

  const stats = {
    fetched: 0,
    skipped: 0,
    failed: 0,
  };
  const failures = [];
  const totalToProcess = queue.length;

  async function processIndex(index) {
    const tokenId = indexToTokenId[index];
    const tokenKey = String(tokenId);

    if (cfg.resume && tokenById.has(tokenKey)) {
      const existingEntry = tokenById.get(tokenKey);
      const hasImageRef = Boolean(normalizeString(existingEntry?.im));
      const shouldBackfillImage = imageContext.writeImageCache && !hasImageRef;
      if (!shouldBackfillImage) {
        stats.skipped += 1;
        return;
      }
    }

    let tokenUri = '';
    let metadata = null;
    let error = null;

    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      try {
        tokenUri = await resolveTokenUriWithTimeout(
          rpcUrls,
          contractAddress,
          tokenId,
          cfg.httpTimeoutMs
        );
        metadata = await metadataFromTokenUri(tokenUri, cfg.httpTimeoutMs);
        error = null;
        break;
      } catch (err) {
        error = err;
        if (attempt < cfg.retries) {
          await sleep(120 + attempt * 180);
        }
      }
    }

    if (error || !metadata || typeof metadata !== 'object') {
      stats.failed += 1;
      failures.push({
        index,
        tokenId,
        error: error ? String(error.message || error) : 'metadata unavailable',
      });
      return;
    }

    const attrs = normalizeAttributes(metadata);
    const image = await extractMetadataImage(metadata, tokenId, imageContext);
    tokenById.set(tokenKey, {
      id: tokenId,
      i: index,
      n: normalizeString(metadata.name) || `No-Punk #${tokenId}`,
      a: attrs,
      im: image,
    });
    stats.fetched += 1;

    const completed = stats.fetched + stats.skipped + stats.failed;
    if (completed % cfg.logEvery === 0 || completed === totalToProcess) {
      console.log(
        `Processed ${completed}/${totalToProcess} (fetched=${stats.fetched}, skipped=${stats.skipped}, failed=${stats.failed})`
      );
    }
  }

  async function worker() {
    while (queue.length) {
      const index = queue.shift();
      if (index == null) return;
      await processIndex(index);
    }
  }

  const workers = [];
  const workerCount = Math.min(cfg.concurrency, Math.max(1, queue.length));
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const chainId = cfg.chainId || (await detectChainId(rpcUrls));
  const tokens = Array.from(tokenById.values())
    .filter((entry) => Number.isFinite(entry.i) && entry.i >= 0 && entry.i < cfg.total)
    .sort((a, b) => a.i - b.i);
  const tokensWithImageRef = tokens.reduce((sum, entry) => sum + (entry.im ? 1 : 0), 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    contract: cfg.contract.toLowerCase(),
    chainId: chainId || '',
    totalSupply: cfg.total,
    source: {
      type: 'rpc-tokenURI',
      rpcUrls,
      tokenIdSource: cfg.useTokenMap ? 'token-map' : 'onchain-range',
      tokenMapPath: cfg.useTokenMap ? tokenMapPath : null,
      imageCacheDir: imageContext.writeImageCache ? imageCacheDirAbs : null,
      start: cfg.start,
      end: cfg.end,
      retries: cfg.retries,
      resume: cfg.resume,
    },
    tokens,
    failures,
  };

  if (tokens.length === 0) {
    const preview = failures
      .slice(0, 5)
      .map((f) => `#${f.tokenId}: ${f.error}`)
      .join(' | ');
    throw new Error(
      `Onchain traits build produced zero tokens. Check RPC connectivity/chain settings and rerun.${
        preview ? ` Sample failures: ${preview}` : ''
      }`
    );
  }

  if (stats.failed > 0 && !cfg.allowPartial) {
    await fs.mkdir(path.dirname(partialOutPath), { recursive: true });
    await fs.writeFile(partialOutPath, JSON.stringify(payload));
    throw new Error(
      `Onchain traits build has ${stats.failed} failures. Partial progress saved to ${partialOutPath}. Re-run with --resume or add --allow-partial.`
    );
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload));
  if (stats.failed === 0) {
    await fs.rm(partialOutPath, { force: true });
  }

  const stat = await fs.stat(outPath);
  console.log(`Onchain traits written: ${outPath} (${(stat.size / 1024).toFixed(1)} KB)`);
  console.log(
    `Summary: fetched=${stats.fetched}, skipped=${stats.skipped}, failed=${stats.failed}, tokensStored=${tokens.length}`
  );
  console.log(`Image refs stored: ${tokensWithImageRef}`);
}

main().catch((err) => {
  console.error('Onchain trait build failed:', err);
  process.exit(1);
});
