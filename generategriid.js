// download_invisiblefriends.js
//
// Local helper script to download ALL tokens for the Invisible Friends contract
// from the OpenSea v2 API, and save each image (GIFs in this collection) plus
// its JSON metadata to a local folder.
//
// Output folder is relative to this repo and the OpenSea API key is taken
// from the environment variable OPENSEA_API_KEY.
//
// Run with:
//   OPENSEA_API_KEY=your_key_here node generategriid.js

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// === CONFIG ===
// Save into a folder inside this project instead of an absolute Desktop path
const OUTPUT_DIR = path.join(__dirname || process.cwd(), 'invisiblefriends');

// IMPORTANT: do NOT hard‑code your API key in this file if it lives in a public repo.
// Set OPENSEA_API_KEY in your shell env before running, e.g.:
//   export OPENSEA_API_KEY=your_key_here
//   node generategriid.js
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || '';

// Invisible Friends contract address
const CONTRACT_ADDRESS = '0x59468516a8259058baD1cA5F8f4BFF190d30E066';

// OpenSea v2 NFT endpoint (contract-wide)
const BASE_URL = 'https://api.opensea.io/api/v2';

// How many NFTs per page to request (max 50 for v2)
const LIMIT = 50;

// Small delay between token requests to avoid rate limits (ms)
const SLEEP_MS = 400;

// Per-request network timeout (ms) to avoid hanging on slow IPFS/OpenSea responses
const FETCH_TIMEOUT_MS = 15000;

// Total number of tokens to fetch (Invisible Friends is 5000)
const TOTAL_TOKENS = 5000;

// Track image URLs we've already downloaded so the same GIF
// isn't saved to disk over and over.
const seenImageUrls = new Set();

// === HELPERS ===

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Sanitize filename
function safeFilename(str) {
  return String(str).replace(/[^a-z0-9_\-\.]/gi, '_');
}

// Get extension from image URL
function getExtensionFromUrl(url) {
  if (!url) return '.gif';
  const qIndex = url.indexOf('?');
  const cleanUrl = qIndex === -1 ? url : url.slice(0, qIndex);
  const ext = path.extname(cleanUrl).toLowerCase();
  if (ext) return ext;
  // Fallback to .gif for this collection
  return '.gif';
}

function ipfsToHttp(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) {
    return 'https://ipfs.io/ipfs/' + uri.slice('ipfs://'.length);
  }
  return uri;
}

// === CORE LOGIC ===

async function fetchToken(tokenId) {
  const url = new URL(`${BASE_URL}/chain/ethereum/contract/${CONTRACT_ADDRESS}/nfts/${tokenId}`);

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-API-KEY': OPENSEA_API_KEY,
    },
    timeout: FETCH_TIMEOUT_MS,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSea API error for tokenId ${tokenId} (${res.status}): ${text}`);
  }

  return res.json();
}

// Resolve animation_url to direct .mp4 or .gif if it's an HTML wrapper
async function resolveAnimationMedia(animationUrl, tokenId) {
  if (!animationUrl) return null;
  try {
    const res = await fetch(animationUrl, {
      headers: {
        Accept: '*/*',
        'X-API-KEY': OPENSEA_API_KEY,
      },
      timeout: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) {
      console.warn(`  Failed to fetch animation_url for tokenId ${tokenId}: ${res.status}`);
      return null;
    }

    const contentType = res.headers.get('content-type') || '';

    // If it's already a direct video or GIF, just use this URL
    if (contentType.startsWith('video/')) {
      return animationUrl;
    }
    if (contentType.includes('image/gif')) {
      return animationUrl;
    }

    // If it's HTML, try to extract a .mp4 or .gif URL from the page
    if (contentType.includes('text/html')) {
      const html = await res.text();
      const mp4Match = html.match(/https?:\/\/[^"'\\s]+\.mp4/);
      if (mp4Match && mp4Match[0]) {
        return mp4Match[0];
      }
      const gifMatch = html.match(/https?:\/\/[^"'\\s]+\.gif/);
      if (gifMatch && gifMatch[0]) {
        return gifMatch[0];
      }
      console.warn(`  Could not find media URL inside HTML animation for tokenId ${tokenId}`);
      return null;
    }

    // Fallback: unknown but non-HTML content, still use the original animationUrl
    return animationUrl;
  } catch (err) {
    console.warn(`  Error resolving animation media for tokenId ${tokenId}: ${err.message}`);
    return null;
  }
}

async function fetchTokenMetadata(nft, tokenId) {
  const metadataFile = path.join(OUTPUT_DIR, `token_${safeFilename(tokenId)}.json`);
  if (fs.existsSync(metadataFile)) {
    console.log(`  Metadata already exists for tokenId ${tokenId}, skipping IPFS metadata fetch.`);
    return null;
  }

  const metaUri = nft.metadata_url || null;
  if (!metaUri) {
    console.warn(`  No metadata_url for tokenId ${tokenId}, skipping IPFS metadata fetch.`);
    return null;
  }

  const httpUrl = ipfsToHttp(metaUri);
  if (!httpUrl) {
    console.warn(`  Could not convert metadata_url to HTTP for tokenId ${tokenId}: ${metaUri}`);
    return null;
  }

  try {
    console.log(`  Fetching metadata.json for tokenId ${tokenId} from: ${httpUrl}`);
    const res = await fetch(httpUrl, { timeout: FETCH_TIMEOUT_MS });
    if (!res.ok) {
      console.warn(`  Failed to fetch metadata.json for tokenId ${tokenId}: ${res.status}`);
      return null;
    }
    const json = await res.json().catch(() => null);
    if (!json) {
      console.warn(`  Failed to parse metadata.json for tokenId ${tokenId}`);
      return null;
    }
    return json;
  } catch (err) {
    console.warn(`  Error fetching metadata.json for tokenId ${tokenId}: ${err.message}`);
    return null;
  }
}

async function downloadImage(imageUrl, tokenId) {
  if (!imageUrl) {
    console.log(`No image URL for tokenId ${tokenId}, skipping image download.`);
    return;
  }

  // If we've already downloaded a GIF for this exact URL, don't re-download
  if (seenImageUrls.has(imageUrl)) {
    console.log(`  Image URL already downloaded, skipping duplicate GIF for tokenId ${tokenId}`);
    return;
  }
  seenImageUrls.add(imageUrl);

  console.log(`  Downloading image for tokenId ${tokenId}`);

  let res;
  try {
    res = await fetch(imageUrl, { timeout: FETCH_TIMEOUT_MS });
  } catch (err) {
    console.warn(`  Error downloading image for tokenId ${tokenId}: ${err.message}`);
    return;
  }

  if (!res.ok) {
    console.warn(`  Failed to download image for tokenId ${tokenId}: ${res.status}`);
    return;
  }

  const ext = getExtensionFromUrl(imageUrl); // trust .gif from URL, fallback is .gif

  const filename = `token_${safeFilename(tokenId)}${ext}`;
  const filePath = path.join(OUTPUT_DIR, filename);

  // Skip if already exists (in case you re-run the script)
  if (fs.existsSync(filePath)) {
    console.log(`Image already exists for tokenId ${tokenId}, skipping: ${filename}`);
    return;
  }

  const buffer = await res.buffer();
  try {
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    console.warn(`  Failed to write image file for tokenId ${tokenId}: ${err.message}`);
  }
}

async function saveMetadata(nft) {
  const tokenId = nft.identifier || nft.token_id || 'unknown';
  const metadataFile = path.join(OUTPUT_DIR, `token_${safeFilename(tokenId)}.json`);

  // Skip if already exists
  if (fs.existsSync(metadataFile)) {
    console.log(`Metadata already exists for tokenId ${tokenId}, skipping JSON.`);
    return;
  }

  // OpenSea v2 NFT object
  const metadata = {
    contract: nft.contract || CONTRACT_ADDRESS,
    token_id: tokenId,
    name: nft.name || null,
    description: nft.description || null,
    // Use the resolved image/animation URLs plus any explicit original image field
    image_url: nft.image_url || nft.image || null,
    image_original_url: nft.image_original_url || nft.original_image_url || null,
    animation_url: nft.animation_url || nft.display_animation_url || null,
    traits: nft.traits || nft.attributes || [],
    // Keep the raw object as well
    raw: nft,
  };

  try {
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(`  Saved metadata for tokenId ${tokenId} -> token_${safeFilename(tokenId)}.json`);
  } catch (err) {
    console.warn(`  Failed to write metadata for tokenId ${tokenId}: ${err.message}`);
  }
}

async function main() {
  if (!OPENSEA_API_KEY) {
    console.error('Error: OPENSEA_API_KEY is not set.');
    console.error('Set it in your environment, e.g. `export OPENSEA_API_KEY=your_key_here` then rerun.');
    process.exit(1);
  }
  ensureDir(OUTPUT_DIR);
  console.log('Downloading NFTs for contract:', CONTRACT_ADDRESS);
  console.log('Output directory:', OUTPUT_DIR);
  console.log('Total tokens to fetch:', TOTAL_TOKENS);

  let totalCount = 0;

  for (let i = 1; i <= TOTAL_TOKENS; i++) {
    const tokenId = String(i);
    console.log(`\n=== Processing tokenId: ${tokenId} ===`);

    try {
      // Fetch v2 data for this token
      const data = await fetchToken(tokenId);
      const nft = data.nft || data;

      // First, try to get the original mint metadata from IPFS via metadata_url
      const tokenMeta = await fetchTokenMetadata(nft, tokenId);

      // Base image URL from the v2 NFT object (static or animated GIF preview)
      const baseImageUrl =
        nft.image_url ||
        (nft.display_image_url ? nft.display_image_url : null) ||
        nft.image ||
        (nft.media && nft.media[0] && (nft.media[0].gateway || nft.media[0].url)) ||
        null;

      // Raw animation URL from v2 (often an HTML wrapper) or from IPFS metadata if present
      let rawAnimationUrl =
        nft.animation_url ||
        nft.display_animation_url ||
        null;

      // If IPFS metadata has animation_url, prefer that as the "raw" animation reference
      if (tokenMeta && tokenMeta.animation_url) {
        rawAnimationUrl = ipfsToHttp(tokenMeta.animation_url);
      }

      // Start with the original minted GIF from IPFS if available
      let finalMediaUrl = null;
      if (tokenMeta && tokenMeta.image) {
        finalMediaUrl = ipfsToHttp(tokenMeta.image); // e.g. ipfs://.../1834.gif -> https://ipfs.io/ipfs/.../1834.gif
      }

      // If no IPFS image, fall back to the v2 base image (preview) and optionally resolve animation HTML
      if (!finalMediaUrl) {
        finalMediaUrl = baseImageUrl;
        if (rawAnimationUrl) {
          const resolved = await resolveAnimationMedia(rawAnimationUrl, tokenId);
          if (resolved) {
            finalMediaUrl = resolved;
          }
        }
      }

      await saveMetadata({
        ...nft,
        token_metadata: tokenMeta || null,           // keep full IPFS metadata for reference
        image_url: finalMediaUrl,                    // what we actually downloaded
        image_original_url: tokenMeta && tokenMeta.image ? tokenMeta.image : (nft.image_original_url || nft.original_image_url || null),
        animation_url: rawAnimationUrl,
      });

      // Download the media bytes from the chosen URL (ideally the original GIF from IPFS)
      await downloadImage(finalMediaUrl, tokenId);

      totalCount += 1;
    } catch (err) {
      console.error(`  Error processing tokenId ${tokenId}:`, err.message || err);
    }

    // Short delay between token requests to avoid hammering APIs
    await sleep(SLEEP_MS);
  }

  console.log(`\nDone. Total NFTs processed: ${totalCount}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
});
