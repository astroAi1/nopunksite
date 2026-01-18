// server.js
// Simple backend for No-Punks site
// - Serves index.html + assets
// - Proxies OpenSea API for stats, sales, listings
// - Provides NFT image info
// - Stubs buy-intent so buttons don't hard error

const path = require('path');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;

// OpenSea config
// Slug from your URL: https://opensea.io/collection/nopunkism
const OPENSEA_COLLECTION_SLUG = 'nopunkismv2';
// Base mainnet contract
const CONTRACT = '0xa62f65d503068684e7228df98090f94322b8ed54'; // NoPunks v2
// Chain for NFT metadata endpoint
const CHAIN = 'base';

const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || '';
const MCP_TOKEN = process.env.MCP_TOKEN || ''; // not used yet, reserved

if (!OPENSEA_API_KEY) {
  console.warn(
    '[WARN] OPENSEA_API_KEY is not set. /api/stats, /api/recent-sales, /api/listed will return stub data.'
  );
}

// ====== MIDDLEWARE ======
app.use(express.json());

// Serve static files (index.html, images, etc.)
const ROOT_DIR = __dirname;
app.use(express.static(ROOT_DIR));

/**
 * Helper to call OpenSea v2 API
 * Docs:
 * - Collection stats: /api/v2/collections/{slug}/stats
 * - Events by collection: /api/v2/events/collection/{slug}
 * - Best listings: /api/v2/listings/collection/{slug}/best
 */
async function osFetchJson(url, options = {}) {
  if (!OPENSEA_API_KEY) {
    throw new Error('Missing OPENSEA_API_KEY');
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'x-api-key': OPENSEA_API_KEY,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `OpenSea error ${res.status}: ${res.statusText} ${text ? '— ' + text : ''}`
    );
  }

  return res.json();
}

// ====== /api/stats ======
// Uses OpenSea "Get collection stats" endpoint  [oai_citation:0‡OpenSea Developer Documentation](https://docs.opensea.io/reference/get_collection_stats?utm_source=chatgpt.com)
app.get('/api/stats', async (req, res) => {
  if (!OPENSEA_API_KEY) {
    // Safe stub if no key
    return res.json({
      stats: {
        floor_price: 0,
        total_volume: 0,
        total_sales: 0,
        num_owners: 0,
        market_cap: 0,
      },
      stub: true,
    });
  }

  try {
    const url = `https://api.opensea.io/api/v2/collections/${OPENSEA_COLLECTION_SLUG}/stats`;
    const data = await osFetchJson(url);

    // Shape is { stats: { ... } } in v2
    const s = data.stats || data;

    res.json({
      stats: {
        floor_price: s.floor_price ?? 0,
        total_volume: s.total_volume ?? 0,
        total_sales: s.total_sales ?? 0,
        num_owners: s.num_owners ?? 0,
        market_cap: s.market_cap ?? 0,
      },
      stub: false,
    });
  } catch (err) {
    console.error('Error in /api/stats:', err);
    // Return stub data instead of 500
    res.json({
      stats: {
        floor_price: 0,
        total_volume: 0,
        total_sales: 0,
        num_owners: 0,
        market_cap: 0,
      },
      error: 'Failed to fetch stats from OpenSea',
      stub: true,
    });
  }
});

// ====== /api/recent-sales ======
// Uses "Get events (by collection)" with event_type=sale  [oai_citation:1‡OpenSea Developer Documentation](https://docs.opensea.io/reference/get_collection_stats?utm_source=chatgpt.com)
app.get('/api/recent-sales', async (req, res) => {
  if (!OPENSEA_API_KEY) {
    return res.json({ sales: [], stub: true });
  }

  try {
    const params = new URLSearchParams({
      event_type: 'sale',
      limit: '5',
      order_by: 'event_timestamp',
      order_direction: 'desc',
    });

    const url = `https://api.opensea.io/api/v2/events/collection/${OPENSEA_COLLECTION_SLUG}?${params.toString()}`;
    const data = await osFetchJson(url);

    const events = data.asset_events || data.events || [];

    const mapped = events.map((e) => {
      const nft = e.nft || e.asset || {};
      const tokenId = nft.identifier || nft.token_id || nft.id || null;

      // The price fields vary; keep it simple and best-effort
      let priceEth = 0;
      let unit = 'ETH';

      // Try a few common spots for price/token
      const payment = e.payment || e.payment_token || e.payment_token_contract || {};
      if (payment.symbol) unit = payment.symbol;

      // You can refine this mapping later once you inspect real payloads
      if (typeof e.total_price === 'string') {
        // Usually wei; you could divide by 1e18 if you want, but we'll leave for now
        priceEth = Number(e.total_price) || 0;
      } else if (typeof e.price === 'number') {
        priceEth = e.price;
      }

      const time =
        e.event_timestamp ||
        e.created_date ||
        e.transaction?.timestamp ||
        '';

      return {
        onChainId: tokenId ? Number(tokenId) || tokenId : null,
        price: priceEth,
        unit,
        time,
      };
    });

    res.json({ sales: mapped, stub: false });
  } catch (err) {
    console.error('Error in /api/recent-sales:', err);
    res.json({
      sales: [],
      error: 'Failed to fetch recent sales from OpenSea',
      stub: true,
    });
  }
});

// ====== /api/listed ======
// Uses "Get best listings (by collection)"  [oai_citation:2‡OpenSea Developer Documentation](https://docs.opensea.io/reference/get_best_listings_on_collection_v2?utm_source=chatgpt.com)
app.get('/api/listed', async (req, res) => {
  if (!OPENSEA_API_KEY) {
    return res.json({ listings: [], stub: true });
  }

  try {
    const params = new URLSearchParams({
      limit: '12',
    });

    const url = `https://api.opensea.io/api/v2/listings/collection/${OPENSEA_COLLECTION_SLUG}/best?${params.toString()}`;
    const data = await osFetchJson(url);

    const listings = data.listings || data.orders || [];

    const mapped = listings.map((order) => {
      // In v2, an order typically has an 'maker_asset' / 'protocol_data' block with token info
      const nft = order.nft || order.asset || order.maker_asset || {};
      const tokenId = nft.identifier || nft.token_id || nft.id || null;

      let priceEth = 0;
      let unit = 'ETH';

      const priceObj = order.price || order.current_price || {};
      if (typeof priceObj === 'number') {
        priceEth = priceObj;
      } else if (priceObj && typeof priceObj.eth === 'number') {
        priceEth = priceObj.eth;
      }

      const paymentToken = order.payment_token || order.payment_token_contract || {};
      if (paymentToken.symbol) {
        unit = paymentToken.symbol;
      }

      return {
        onChainId: tokenId ? Number(tokenId) || tokenId : null,
        price: priceEth,
        unit,
        source: order.source || 'OpenSea',
      };
    });

    res.json({ listings: mapped, stub: false });
  } catch (err) {
    console.error('Error in /api/listed:', err);
    res.json({
      listings: [],
      error: 'Failed to fetch listings from OpenSea',
      stub: true,
    });
  }
});

// ====== /api/nft/:tokenId ======
// Get NFT metadata + image URL from OpenSea v2 NFT endpoint  [oai_citation:3‡OpenSea Developer Documentation](https://docs.opensea.io/reference/list_collections?utm_source=chatgpt.com)
app.get('/api/nft/:tokenId', async (req, res) => {
  const { tokenId } = req.params;

  if (!OPENSEA_API_KEY) {
    return res.status(503).json({
      error: 'OPENSEA_API_KEY not set',
    });
  }

  try {
    const url = `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${tokenId}`;
    const data = await osFetchJson(url);

    const nft = data.nft || data;

    const imageUrl =
      nft.image_url ||
      nft.image ||
      nft.display_image_url ||
      nft.original_image_url ||
      null;

    res.json({
      token_id: tokenId,
      name: nft.name || `No-Punk #${tokenId}`,
      description: nft.description || '',
      image_url: imageUrl,
    });
  } catch (err) {
    console.error('Error in /api/nft/:tokenId', err);
    res.status(500).json({
      error: 'Failed to fetch NFT from OpenSea',
    });
  }
});

// ====== /api/opensea/buy-intent (stub) ======
// For now we *do not* build real fulfilment payloads;
// we just tell the frontend to send people to OpenSea.
app.post('/api/opensea/buy-intent', (req, res) => {
  const { tokenId, buyer } = req.body || {};
  console.log('Buy intent stub hit for token', tokenId, 'by', buyer);

  // Return 400 with a friendly message, so frontend can show alert
  return res.status(400).json({
    error:
      'On-site purchase not implemented yet. Use the "View item" link to buy on OpenSea.',
  });
});

// ====== FALLBACK: serve index.html for any other route ======
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`No-Punks server running at http://localhost:${PORT}`);
});