#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--root') parsed.rootDir = next;
    if (arg === '--total') parsed.total = Number.parseInt(next, 10);
    if (arg === '--out-dir') parsed.outDir = next;
    if (arg === '--publish-dir') parsed.publishDir = next;
    if (arg === '--image-source-dir') parsed.imageSourceDir = next;
    if (arg === '--image-publish-dir') parsed.imagePublishDir = next;
    if (arg === '--no-publish-images') parsed.publishImages = false;
    if (arg === '--token-map') parsed.tokenMapPath = next;
    if (arg === '--use-token-map') parsed.useTokenMap = true;
    if (arg === '--onchain-traits') parsed.onchainTraitsPath = next;
    if (arg === '--allow-local-fallback') parsed.allowLocalFallback = true;
  }

  return {
    rootDir: parsed.rootDir || '.',
    total: Number.isFinite(parsed.total) ? parsed.total : 10000,
    outDir: parsed.outDir || './public/data/explorer',
    publishDir: parsed.publishDir || './explorer-data',
    imageSourceDir: parsed.imageSourceDir || './public/data/explorer/images',
    imagePublishDir: parsed.imagePublishDir || './explorer-data/images',
    publishImages: parsed.publishImages !== false,
    tokenMapPath: parsed.tokenMapPath || './public/token_map.json',
    useTokenMap: Boolean(parsed.useTokenMap),
    onchainTraitsPath: parsed.onchainTraitsPath || './public/data/explorer/onchain_traits.json',
    allowLocalFallback: Boolean(parsed.allowLocalFallback),
  };
}

function normalizeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeTokenId(rawValue, fallbackIndex) {
  if (rawValue == null) return fallbackIndex;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue;
  }

  const text = String(rawValue).trim();
  if (!text) return fallbackIndex;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  return text;
}

function normalizeSearchText(value) {
  return normalizeString(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compareIds(a, b) {
  const an = Number(a);
  const bn = Number(b);
  const aIsNum = Number.isFinite(an) && String(an) === String(a);
  const bIsNum = Number.isFinite(bn) && String(bn) === String(b);

  if (aIsNum && bIsNum) return an - bn;
  return String(a).localeCompare(String(b));
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
      if (!Number.isFinite(index)) return;
      if (index < 0 || index >= totalSupply) return;
      out[index] = normalizeTokenId(tokenId, index);
    });
  }

  return out;
}

function normalizeTraitList(attrs) {
  const normalized = [];
  const seen = new Set();

  (Array.isArray(attrs) ? attrs : []).forEach((trait) => {
    const tupleType = Array.isArray(trait) ? trait[0] : undefined;
    const tupleValue = Array.isArray(trait) ? trait[1] : undefined;
    const traitType = normalizeString(tupleType ?? trait?.trait_type ?? trait?.type);
    const value = normalizeString(tupleValue ?? trait?.value);
    if (!traitType || !value) return;

    const key = `${traitType}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push([traitType, value]);
  });

  return normalized;
}

function normalizeImageUri(value) {
  const text = normalizeString(value);
  if (!text) return '';
  if (text.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${text.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  }
  return text;
}

function normalizeTraits(meta) {
  const attrs = Array.isArray(meta?.attributes)
    ? meta.attributes
    : Array.isArray(meta?.traits)
    ? meta.traits
    : [];
  return normalizeTraitList(attrs);
}

function mergeTraitPairs(primaryPairs, secondaryPairs) {
  const merged = [];
  const seen = new Set();

  [primaryPairs, secondaryPairs].forEach((pairs) => {
    (Array.isArray(pairs) ? pairs : []).forEach(([type, value]) => {
      const traitType = normalizeString(type);
      const traitValue = normalizeString(value);
      if (!traitType || !traitValue) return;
      const key = `${traitType}|${traitValue}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push([traitType, traitValue]);
    });
  });

  return merged;
}

function parseOnchainTraits(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;

  const consumeEntry = (entry, fallbackTokenId = null) => {
    if (!entry || typeof entry !== 'object') return;
    const tokenId = normalizeTokenId(entry.id ?? fallbackTokenId, fallbackTokenId);
    if (tokenId == null) return;

    const attrs = Array.isArray(entry.a)
      ? entry.a
      : Array.isArray(entry.attributes)
      ? entry.attributes
      : Array.isArray(entry.traits)
      ? entry.traits
      : [];

    out[String(tokenId)] = {
      id: tokenId,
      n: normalizeString(entry.n || entry.name),
      im: normalizeImageUri(entry.im || entry.image || entry.image_url),
      t: normalizeTraitList(attrs),
    };
  };

  if (Array.isArray(raw.tokens)) {
    raw.tokens.forEach((entry) => consumeEntry(entry));
  }

  if (raw.tokenTraitsById && typeof raw.tokenTraitsById === 'object') {
    Object.entries(raw.tokenTraitsById).forEach(([tokenId, entry]) => {
      consumeEntry(entry, tokenId);
    });
  }

  return out;
}

async function main() {
  const cfg = parseArgs();
  const cwd = process.cwd();

  const rootDir = path.resolve(cwd, cfg.rootDir);
  const outDir = path.resolve(cwd, cfg.outDir);
  const publishDir = path.resolve(cwd, cfg.publishDir);
  const imageSourceDir = path.resolve(cwd, cfg.imageSourceDir);
  const imagePublishDir = path.resolve(cwd, cfg.imagePublishDir);
  const tokenMapPath = path.resolve(cwd, cfg.tokenMapPath);
  const onchainTraitsPath = path.resolve(cwd, cfg.onchainTraitsPath);

  const tokenMapRaw = cfg.useTokenMap ? await readJsonSafe(tokenMapPath) : null;
  const indexToTokenId = buildIndexToTokenId(tokenMapRaw, cfg.total);
  const onchainTraitsRaw = await readJsonSafe(onchainTraitsPath);
  const onchainTraitsByTokenId = parseOnchainTraits(onchainTraitsRaw);
  const onchainTraitCount = Object.keys(onchainTraitsByTokenId).length;

  if (!onchainTraitCount && !cfg.allowLocalFallback) {
    throw new Error(
      `Onchain traits file missing or empty: ${onchainTraitsPath}. Run build-onchain-traits first.`
    );
  }

  const traitToTokenIdSets = Object.create(null);
  const typeValueSets = Object.create(null);
  const traitTypeOrder = [];
  const traitTypeSeen = new Set();

  const tokenIdToIndex = Object.create(null);
  const tokenTraitBlobs = new Array(cfg.total);
  const missingMetadata = [];
  let usedOnchainTraits = 0;

  for (let index = 0; index < cfg.total; index += 1) {
    const tokenId = indexToTokenId[index];
    tokenIdToIndex[String(tokenId)] = index;

    const onchainEntry = onchainTraitsByTokenId[String(tokenId)];
    const onchainTraits = onchainEntry?.t || [];
    let meta = null;
    if (cfg.allowLocalFallback && !onchainTraits.length) {
      const metaPath = path.join(rootDir, `${index}.json`);
      meta = await readJsonSafe(metaPath);
      if (!meta) {
        missingMetadata.push(index);
      }
    }
    const localTraits = normalizeTraits(meta);
    const traits = onchainTraits.length
      ? onchainTraits
      : cfg.allowLocalFallback
      ? localTraits
      : [];
    const name = onchainTraits.length
      ? normalizeString(onchainEntry?.n) || `No-Punk #${tokenId}`
      : cfg.allowLocalFallback
      ? normalizeString(meta?.name) || `No-Punk #${tokenId}`
      : `No-Punk #${tokenId}`;
    const imageUrl = normalizeImageUri(
      onchainEntry?.im ||
        onchainEntry?.image ||
        onchainEntry?.image_url ||
        (cfg.allowLocalFallback ? meta?.image || meta?.image_url : '')
    );

    if (onchainTraits.length > 0) {
      usedOnchainTraits += 1;
    }

    const searchParts = [name, String(tokenId), `#${tokenId}`];
    traits.forEach(([type, value]) => {
      const traitKey = `${type}|${value}`;
      if (!traitToTokenIdSets[traitKey]) {
        traitToTokenIdSets[traitKey] = new Set();
      }
      traitToTokenIdSets[traitKey].add(tokenId);

      if (!typeValueSets[type]) {
        typeValueSets[type] = new Set();
      }
      typeValueSets[type].add(value);
      if (!traitTypeSeen.has(type)) {
        traitTypeSeen.add(type);
        traitTypeOrder.push(type);
      }

      searchParts.push(type, value, `${type}:${value}`, `${type} ${value}`);
    });

    const searchNormalized = normalizeSearchText(searchParts.join(' ').toLowerCase());

    tokenTraitBlobs[index] = {
      id: tokenId,
      i: index,
      im: imageUrl || undefined,
      z: searchNormalized,
      t: traits,
    };

    if ((index + 1) % 1000 === 0 || index + 1 === cfg.total) {
      console.log(`Indexed ${index + 1}/${cfg.total}`);
    }
  }

  const traitToTokenIds = Object.create(null);
  Object.entries(traitToTokenIdSets).forEach(([traitKey, idSet]) => {
    const ids = Array.from(idSet);
    ids.sort(compareIds);
    traitToTokenIds[traitKey] = ids;
  });

  const typeValues = Object.create(null);
  Object.entries(typeValueSets).forEach(([traitType, valueSet]) => {
    const values = Array.from(valueSet);
    values.sort((a, b) => String(a).localeCompare(String(b)));
    typeValues[traitType] = values;
  });

  const generatedAt = new Date().toISOString();
  const traitIndexPayload = {
    generatedAt,
    totalSupply: cfg.total,
    sources: {
      metadataRoot: cfg.allowLocalFallback ? rootDir : null,
      tokenIdSource: cfg.useTokenMap ? 'token-map' : 'onchain-range',
      tokenMapPath: cfg.useTokenMap ? tokenMapPath : null,
      onchainTraitsPath: onchainTraitCount ? onchainTraitsPath : null,
      onchainTraitCount,
      mergedFromOnchain: usedOnchainTraits,
      allowLocalFallback: Boolean(cfg.allowLocalFallback),
    },
    traitTypes: traitTypeOrder,
    traitToTokenIds,
    typeValues,
  };

  const tokenBlobPayload = {
    generatedAt,
    totalSupply: cfg.total,
    sources: traitIndexPayload.sources,
    tokenIdToIndex,
    tokens: tokenTraitBlobs,
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(publishDir, { recursive: true });
  const traitIndexPath = path.join(outDir, 'trait_to_token_ids.json');
  const tokenBlobPath = path.join(outDir, 'token_trait_blob.json');
  const publishTraitIndexPath = path.join(publishDir, 'trait_to_token_ids.json');
  const publishTokenBlobPath = path.join(publishDir, 'token_trait_blob.json');

  await fs.writeFile(traitIndexPath, JSON.stringify(traitIndexPayload));
  await fs.writeFile(tokenBlobPath, JSON.stringify(tokenBlobPayload));
  await fs.writeFile(publishTraitIndexPath, JSON.stringify(traitIndexPayload));
  await fs.writeFile(publishTokenBlobPath, JSON.stringify(tokenBlobPayload));

  let publishedImageCount = 0;
  if (cfg.publishImages) {
    try {
      await fs.mkdir(imagePublishDir, { recursive: true });
      // Node's fs.cp is incremental-friendly and fast for local rebuild loops.
      await fs.cp(imageSourceDir, imagePublishDir, { recursive: true, force: true });
      const imageFiles = await fs.readdir(imagePublishDir);
      publishedImageCount = imageFiles.length;
    } catch (err) {
      console.warn(`Could not publish explorer images from ${imageSourceDir} -> ${imagePublishDir}`);
      console.warn(err && (err.message || err));
    }
  }

  const [traitStat, blobStat] = await Promise.all([
    fs.stat(traitIndexPath),
    fs.stat(tokenBlobPath),
  ]);
  const [publishTraitStat, publishBlobStat] = await Promise.all([
    fs.stat(publishTraitIndexPath),
    fs.stat(publishTokenBlobPath),
  ]);

  console.log(`Trait index written: ${traitIndexPath} (${(traitStat.size / 1024).toFixed(1)} KB)`);
  console.log(`Token blob written: ${tokenBlobPath} (${(blobStat.size / 1024).toFixed(1)} KB)`);
  console.log(
    `Trait index published: ${publishTraitIndexPath} (${(publishTraitStat.size / 1024).toFixed(1)} KB)`
  );
  console.log(
    `Token blob published: ${publishTokenBlobPath} (${(publishBlobStat.size / 1024).toFixed(1)} KB)`
  );
  if (cfg.publishImages) {
    console.log(`Explorer images published: ${imagePublishDir} (${publishedImageCount} files)`);
  }

  if (missingMetadata.length) {
    console.warn(`Missing metadata files: ${missingMetadata.length}`);
  }

  if (onchainTraitCount) {
    console.log(
      `Onchain traits merged for ${usedOnchainTraits.toLocaleString()} tokens (from ${onchainTraitsPath})`
    );
  } else if (cfg.allowLocalFallback) {
    console.warn(`Onchain traits file missing or empty: ${onchainTraitsPath}`);
  }
}

main().catch((err) => {
  console.error('Explorer index build failed:', err);
  process.exit(1);
});
