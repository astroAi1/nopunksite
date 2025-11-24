// assets/website.js
// Frontend wiring for NoPunks • NoMeta

(() => {
  "use strict";

  // =========================
  // CONFIG
  // =========================

  // Backend API base
  // On Render (nopunksite.onrender.com) we can use same-origin requests.
  // On Netlify / nopunks.xyz we call the Render server directly.
  const API_BASE =
    window.location.hostname === "nopunksite.onrender.com"
      ? ""
      : "https://nopunksite.onrender.com";

  const TOTAL_SUPPLY = 10000;
  const PAGE_SIZE = 50;

  // =========================
  // Helpers
  // =========================

  function apiUrl(path) {
    if (path.startsWith("http")) return path;
    if (!API_BASE) return path; // same-origin relative requests
    return `${API_BASE}${path}`;
  }

  async function fetchJson(path) {
    const res = await fetch(apiUrl(path), {
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${path}`);
    }
    return res.json();
  }

  function safeText(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  // =========================
  // Tabs
  // =========================

  const tabButtons = document.querySelectorAll(".np-tab");
  const tabSections = document.querySelectorAll("[data-tab-section]");

  function setActiveTab(tabName) {
    tabButtons.forEach((btn) => {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle("np-tab--active", active);
    });

    tabSections.forEach((section) => {
      const show = section.dataset.tabSection === tabName;
      section.classList.toggle("hidden", !show);
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      setActiveTab(tab);
    });
  });

  // Start on collection tab
  setActiveTab("collection");

  // =========================
  // Collection grid
  // =========================

  const collectionGridEl = document.getElementById("collection-grid");
  const collectionSummaryEl = document.getElementById("collection-summary");
  const collectionErrorEl = document.getElementById("collection-error");
  const prevPageBtn = document.getElementById("prev-page");
  const nextPageBtn = document.getElementById("next-page");
  const pageInfoEl = document.getElementById("page-info");

  let currentPage = 1;
  let isLoadingCollection = false;

  function getTokenId(token) {
    if (!token) return "";
    return (
      token.token_id ||
      token.tokenId ||
      token.onChainId ||
      (token.id && token.id.tokenId) ||
      token.id ||
      token.identifier ||
      ""
    );
  }

  function getTokenName(token, tokenId) {
    return token.name || token.title || (tokenId ? `NO-PUNK #${tokenId}` : "NO-PUNK");
  }

  function getTokenImageUrl(token) {
    if (!token) return "";
    const t = token.nft || token; // handle nested nft objects just in case
    return (
      t.image_url ||
      t.image ||
      t.image_original_url ||
      t.display_image_url ||
      (t.media && t.media[0] && (t.media[0].gateway || t.media[0].thumbnail)) ||
      ""
    );
  }

  function getTokenPermalink(token, tokenId) {
    if (!token) return "#";
    const t = token.nft || token;
    if (t.permalink) return t.permalink;
    if (t.external_url) return t.external_url;
    if (t.opensea_url) return t.opensea_url;
    if (!tokenId) return "#";
    // Fallback OpenSea URL for Base
    return `https://opensea.io/assets/base/0x4ed83635e2309a7c067d0f98efca47b920bf79b1/${tokenId}`;
  }

  function getTokenTraits(token) {
    if (!token) return [];

    // direct traits/attributes
    if (Array.isArray(token.traits)) return token.traits;
    if (Array.isArray(token.attributes)) return token.attributes;

    // common metadata containers
    const metaSources = [
      token.metadata,
      token.raw_metadata,
      token.openSeaMetadata,
      token.meta
    ];
    for (const meta of metaSources) {
      if (!meta) continue;
      if (Array.isArray(meta.traits)) return meta.traits;
      if (Array.isArray(meta.attributes)) return meta.attributes;
    }

    // nested nft object (some OpenSea responses wrap it)
    if (token.nft && token.nft !== token) {
      return getTokenTraits(token.nft);
    }

    return [];
  }

  function renderCollection(tokens, page, total) {
    const totalPages = Math.ceil((total || TOTAL_SUPPLY) / PAGE_SIZE);

    const html = tokens
      .map((token, idx) => {
        const tokenId = getTokenId(token);
        const displayId = tokenId ? `NO-PUNK #${tokenId}` : "NO-PUNK";
        const name = getTokenName(token, tokenId);
        const imageUrl = getTokenImageUrl(token);
        const permalink = getTokenPermalink(token, tokenId);
        const traits = getTokenTraits(token);

        // 0–9999 index into the full collection (used for /api/nft/:index)
        const globalIndex = (page - 1) * PAGE_SIZE + idx;

        const traitsJson = encodeURIComponent(JSON.stringify(traits || []));

        return `
          <article
            class="np-card"
            data-token-id="${safeText(tokenId)}"
            data-index="${globalIndex}"
            data-traits="${traitsJson}"
          >
            <a class="np-card-link" href="${permalink}" target="_blank" rel="noreferrer">
              <div class="np-card-image-wrap">
                <img src="${imageUrl}" alt="${name}" loading="lazy" />
              </div>
              <div class="np-card-meta">
                <div class="np-card-title">${displayId}</div>
              </div>
            </a>
          </article>
        `;
      })
      .join("");

    collectionGridEl.innerHTML = html;

    // Summary + pagination UI
    collectionSummaryEl.textContent = `10,000 NoPunks on Base. Showing ${
      (page - 1) * PAGE_SIZE + 1
    }–${Math.min(page * PAGE_SIZE, total || TOTAL_SUPPLY)} via OpenSea (proxied through the server).`;

    pageInfoEl.textContent = `Page ${page} / ${totalPages}`;
    prevPageBtn.disabled = page <= 1;
    nextPageBtn.disabled = page >= totalPages;

    attachCardTooltipHandlers();
  }

  async function loadCollectionPage(page) {
    if (isLoadingCollection) return;
    isLoadingCollection = true;
    collectionErrorEl.style.display = "none";

    try {
      collectionGridEl.innerHTML = "";
      collectionGridEl.setAttribute("aria-busy", "true");

      const data = await fetchJson(
        `/api/collection?page=${page}&pageSize=${PAGE_SIZE}`
      );

      const tokens =
        data.tokens || data.items || data.assets || data.result || [];
      const total = data.total || data.totalSupply || TOTAL_SUPPLY;

      if (!Array.isArray(tokens) || tokens.length === 0) {
        throw new Error("No tokens returned");
      }

      currentPage = page;
      renderCollection(tokens, page, total);
    } catch (err) {
      console.error("Collection load error:", err);
      collectionGridEl.innerHTML = "";
      collectionErrorEl.textContent =
        "NoPunks failed to load from the server. Try refreshing.";
      collectionErrorEl.style.display = "block";
    } finally {
      isLoadingCollection = false;
      collectionGridEl.removeAttribute("aria-busy");
    }
  }

  prevPageBtn.addEventListener("click", () => {
    if (currentPage > 1) {
      loadCollectionPage(currentPage - 1);
    }
  });

  nextPageBtn.addEventListener("click", () => {
    loadCollectionPage(currentPage + 1);
  });

  // =========================
  // Trait tooltip (liquid glass)
  // =========================

  let tooltipEl = null;
  let scrollListenerAttached = false;

  function ensureTooltipEl() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "np-traits-tooltip hidden";
    tooltipEl.innerHTML = `
      <div class="np-traits-header"></div>
      <div class="np-traits-body"></div>
    `;
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function formatTraitsForTooltip(traits) {
    if (!Array.isArray(traits) || traits.length === 0) {
      return '<div class="np-traits-empty">No traits found.</div>';
    }

    const rows = traits.slice(0, 6).map((t) => {
      const type = safeText(t.trait_type || t.type || "", "").toUpperCase();
      const value = safeText(t.value || "", "");
      return `
        <div class="np-traits-row">
          <span class="np-traits-type">${type}</span>
          <span class="np-traits-value">${value}</span>
        </div>
      `;
    });

    return rows.join("");
  }

  function positionTooltip(cardRect) {
    const tooltip = ensureTooltipEl();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const tooltipRect = tooltip.getBoundingClientRect();

    // Default: to the right of the card
    let top =
      cardRect.top +
      window.scrollY +
      cardRect.height / 2 -
      tooltipRect.height / 2;
    let left = cardRect.right + 16 + window.scrollX;

    // If it would overflow right, flip to left side
    if (left + tooltipRect.width + 16 > viewportWidth + window.scrollX) {
      left = cardRect.left - tooltipRect.width - 16 + window.scrollX;
    }

    // Clamp vertically a bit
    const minTop = window.scrollY + 16;
    const maxTop = window.scrollY + viewportHeight - tooltipRect.height - 16;
    top = Math.max(minTop, Math.min(maxTop, top));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function parseTraitsFromDataset(cardEl) {
    try {
      const encoded = cardEl.dataset.traits;
      if (!encoded) return [];
      const decoded = decodeURIComponent(encoded);
      const traits = JSON.parse(decoded);
      return Array.isArray(traits) ? traits : [];
    } catch {
      return [];
    }
  }

  function showTooltipForCard(cardEl) {
    const tooltip = ensureTooltipEl();
    const headerEl = tooltip.querySelector(".np-traits-header");
    const bodyEl = tooltip.querySelector(".np-traits-body");

    const tokenId = cardEl.dataset.tokenId || "";
    headerEl.textContent = tokenId ? `NO-PUNK #${tokenId}` : "NO-PUNK";

    let traits = parseTraitsFromDataset(cardEl);

    // If we already have traits, render immediately.
    if (traits.length > 0) {
      bodyEl.innerHTML = formatTraitsForTooltip(traits);
      tooltip.classList.remove("hidden");
      positionTooltip(cardEl.getBoundingClientRect());
      return;
    }

    // Otherwise, show loading state and fetch from /api/nft/:index
    bodyEl.innerHTML =
      '<div class="np-traits-empty">Loading traits…</div>';
    tooltip.classList.remove("hidden");
    positionTooltip(cardEl.getBoundingClientRect());

    const indexStr = cardEl.dataset.index;
    const index = parseInt(indexStr, 10);
    if (Number.isNaN(index) || index < 0 || index >= TOTAL_SUPPLY) {
      bodyEl.innerHTML =
        '<div class="np-traits-empty">Traits unavailable.</div>';
      return;
    }

    // Avoid duplicate fetches
    if (cardEl.dataset.traitsLoading === "1") {
      return;
    }
    cardEl.dataset.traitsLoading = "1";

    fetchJson(`/api/nft/${index}`)
      .then((nft) => {
        const freshTraits = getTokenTraits(nft) || [];
        cardEl.dataset.traits = encodeURIComponent(
          JSON.stringify(freshTraits)
        );
        delete cardEl.dataset.traitsLoading;

        // Only update if tooltip is still visible for this card
        if (!tooltip.classList.contains("hidden")) {
          bodyEl.innerHTML = formatTraitsForTooltip(freshTraits);
          positionTooltip(cardEl.getBoundingClientRect());
        }
      })
      .catch((err) => {
        console.error("Trait fetch error:", err);
        delete cardEl.dataset.traitsLoading;
        if (!tooltip.classList.contains("hidden")) {
          bodyEl.innerHTML =
            '<div class="np-traits-empty">Traits unavailable.</div>';
        }
      });
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.classList.add("hidden");
  }

  function attachCardTooltipHandlers() {
    const cards = collectionGridEl.querySelectorAll(".np-card");

    cards.forEach((card) => {
      card.addEventListener("mouseenter", () => showTooltipForCard(card));
      card.addEventListener("mouseleave", hideTooltip);
    });

    if (!scrollListenerAttached) {
      window.addEventListener("scroll", hideTooltip, { passive: true });
      scrollListenerAttached = true;
    }
  }

  // =========================
  // Showcase
  // =========================

  const showcaseGridEl = document.getElementById("showcase-grid");
  const showcaseStatusEl = document.getElementById("showcase-status");

  function getProjectLabel(item) {
    if (!item) return "NOPUNKS • NOMETA";

    // Prefer explicit label from the API if present
    if (item.projectLabel) return item.projectLabel;
    if (item.project_header) return item.project_header;

    // Our server sends `key` and `label` for showcase entries
    const key = (item.key || "").toLowerCase();
    if (key.includes("pnuk")) return "NOPNUK • NOMETA";
    if (key.includes("pixelpepen")) return "NO-PIXELPEPEN • NOMETA";
    if (key.includes("tiny") || key.includes("dino"))
      return "NO-TINYDINOS • NOMETA";

    if (item.label) {
      // Generic label -> UPPERCASE • NOMETA, e.g. "NoPunks" -> "NOPUNKS • NOMETA"
      return `${safeText(item.label, "").toUpperCase()} • NOMETA`;
    }

    const slug = (item.project || item.collection || "").toLowerCase();
    if (slug.includes("pnuk")) return "NOPNUK • NOMETA";
    if (slug.includes("pixelpepen")) return "NO-PIXELPEPEN • NOMETA";
    if (slug.includes("tiny") || slug.includes("dino"))
      return "NO-TINYDINOS • NOMETA";

    return "NOPUNKS • NOMETA";
  }

  function createShowcaseCardHtml(item) {
    const tokenId =
      item.token_id ||
      item.tokenId ||
      item.id ||
      item.identifier ||
      item.onChainId ||
      "";
    const imageUrl = getTokenImageUrl(item);
    const permalink =
      item.permalink || item.external_url || item.opensea_url || "#";

    const header = getProjectLabel(item);
    const idLabel = tokenId ? `#${tokenId}` : "";

    return `
      <div class="np-playing-card-wrap">
        <article class="np-playing-card">
          <div class="np-playing-card-inner">
            <div class="np-playing-card-header">
              <div class="np-playing-card-kicker">
                <span class="np-playing-card-kicker-dot"></span>
                <span class="np-playing-card-kicker-label">${header}</span>
              </div>
              <div class="np-playing-card-id">${idLabel}</div>
            </div>
            <div class="np-playing-card-header-line"></div>

            <div class="np-playing-card-media">
              <div class="np-playing-card-image-frame">
                <div class="np-playing-card-image-wrap">
                  <a href="${permalink}" target="_blank" rel="noreferrer">
                    <img
                      src="${imageUrl}"
                      alt="${header} ${idLabel}"
                      class="np-playing-card-image"
                      loading="lazy"
                    />
                  </a>
                </div>
              </div>
            </div>

            <div class="np-playing-card-bottom">
              <div class="np-playing-card-divider"></div>
              <div class="np-playing-card-footer">
                <span class="np-playing-card-footer-dot"></span>
                <span>NO-META SHOWCASE</span>
              </div>
            </div>

            <div class="np-playing-card-corner np-playing-card-corner--tl"></div>
            <div class="np-playing-card-corner np-playing-card-corner--tr"></div>
            <div class="np-playing-card-corner np-playing-card-corner--bl"></div>
            <div class="np-playing-card-corner np-playing-card-corner--br"></div>
          </div>
        </article>
      </div>
    `;
  }

  async function loadShowcase() {
    try {
      showcaseStatusEl.textContent = "NoMeta loading...";
      const data = await fetchJson("/api/showcase");
      const items = data.items || data.showcase || data.tokens || [];

      if (!Array.isArray(items) || items.length === 0) {
        showcaseStatusEl.textContent =
          "Showcase unavailable. Check back later.";
        showcaseGridEl.innerHTML = "";
        return;
      }

      showcaseGridEl.innerHTML = items.map(createShowcaseCardHtml).join("");
      showcaseStatusEl.textContent =
        "Once a day, four pieces from across the NoMeta universe.";
    } catch (err) {
      console.error("Showcase load error:", err);
      showcaseStatusEl.textContent =
        "Showcase unavailable. Check back later.";
      showcaseGridEl.innerHTML = "";
    }
  }

  // =========================
  // Sales & stats
  // =========================

  const floorPriceEl = document.getElementById("floor-price");
  const totalVolumeEl = document.getElementById("total-volume");
  const numOwnersEl = document.getElementById("num-owners");
  const salesStatusEl = document.getElementById("sales-status");
  const recentSalesListEl = document.getElementById("recent-sales-list");
  const listedTokensListEl = document.getElementById("listed-tokens-list");

  function formatEth(v) {
    if (v === null || v === undefined || isNaN(v)) return "--";
    const n = Number(v);
    if (!isFinite(n)) return "--";
    return n.toFixed(n >= 1 ? 2 : 4).replace(/\.?0+$/, "");
  }

  function formatShortAddress(addr) {
    const a = safeText(addr, "");
    if (a.length <= 10) return a;
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  }

  function createSaleRowHtml(sale) {
    const tokenId = getTokenId(sale);
    const imageUrl = getTokenImageUrl(sale);
    const permalink = getTokenPermalink(sale, tokenId);
    const price =
      sale.priceEth ||
      sale.price_eth ||
      sale.total_price_eth ||
      sale.price ||
      null;
    const buyer =
      sale.buyer ||
      sale.to_address ||
      (sale.taker && sale.taker.address) ||
      "";
    const timeAgo = sale.timeAgo || sale.relative_time || "";

    return `
      <a class="np-sale-row" href="${permalink}" target="_blank" rel="noreferrer">
        <div class="np-sale-left">
          <img src="${imageUrl}" alt="No-Punk #${tokenId}" loading="lazy" />
        </div>
        <div class="np-sale-main">
          <div>
            <div class="np-sale-token">NO-PUNK #${safeText(tokenId)}</div>
            <div class="np-sale-meta">
              Sold to ${formatShortAddress(buyer)} ${safeText(timeAgo)}
            </div>
          </div>
          <div class="np-sale-price">${formatEth(price)} Ξ</div>
        </div>
      </a>
    `;
  }

  function createListingRowHtml(listing) {
    const tokenId = getTokenId(listing);
    const imageUrl = getTokenImageUrl(listing);
    const permalink = getTokenPermalink(listing, tokenId);
    const price =
      listing.priceEth ||
      listing.price_eth ||
      listing.current_price_eth ||
      listing.price ||
      null;
    const seller =
      listing.seller ||
      listing.from_address ||
      (listing.maker && listing.maker.address) ||
      "";

    return `
      <a class="np-listing-row" href="${permalink}" target="_blank" rel="noreferrer">
        <div class="np-listing-left">
          <img src="${imageUrl}" alt="No-Punk #${tokenId}" loading="lazy" />
        </div>
        <div class="np-listing-main">
          <div>
            <div class="np-listing-token">NO-PUNK #${safeText(tokenId)}</div>
            <div class="np-listing-meta">
              Listed by ${formatShortAddress(seller)}
            </div>
          </div>
          <div class="np-listing-price">${formatEth(price)} Ξ</div>
        </div>
      </a>
    `;
  }

  async function loadStatsAndSales() {
    try {
      salesStatusEl.textContent = "NoMeta loading...";

      const [stats, recent, listed] = await Promise.all([
        fetchJson("/api/stats").catch((err) => {
          console.warn("Stats fetch failed", err);
          return {};
        }),
        fetchJson("/api/recent-sales").catch((err) => {
          console.warn("Recent sales fetch failed", err);
          return {};
        }),
        fetchJson("/api/listed").catch((err) => {
          console.warn("Listed fetch failed", err);
          return {};
        })
      ]);

      // Stats
      const floor =
        stats.floorPrice ??
        stats.floorPriceEth ??
        stats.floor_price_eth ??
        stats.floor_price ??
        stats.floor ??
        (stats.stats &&
          (stats.stats.floor_price ??
            stats.stats.floorPrice ??
            stats.stats.floor_price_eth)) ??
        null;

      const volume =
        stats.totalVolume ??
        stats.totalVolumeEth ??
        stats.total_volume_eth ??
        stats.volume ??
        (stats.stats &&
          (stats.stats.total_volume ??
            stats.stats.volume ??
            stats.stats.total_volume_eth)) ??
        null;

      const owners =
        stats.numOwners || stats.num_owners || stats.owners || "--";

      floorPriceEl.textContent = `${formatEth(floor)} Ξ`;
      totalVolumeEl.textContent = `${formatEth(volume)} Ξ`;
      numOwnersEl.textContent = safeText(owners, "--");

      // Recent sales
      const sales = recent.sales || recent.items || recent.events || [];
      if (Array.isArray(sales) && sales.length > 0) {
        recentSalesListEl.innerHTML = sales
          .slice(0, 10)
          .map(createSaleRowHtml)
          .join("");
      } else {
        recentSalesListEl.innerHTML =
          '<div class="text-[11px] text-white/50">No recent sales cached.</div>';
      }

      // Listed tokens
      const listings =
        listed.listings || listed.items || listed.events || [];
      if (Array.isArray(listings) && listings.length > 0) {
        listedTokensListEl.innerHTML = listings
          .slice(0, 10)
          .map(createListingRowHtml)
          .join("");
      } else {
        listedTokensListEl.innerHTML =
          '<div class="text-[11px] text-white/50">No active listings cached.</div>';
      }

      salesStatusEl.textContent =
        "Stats pulled from recent OpenSea data (cached via the server).";
    } catch (err) {
      console.error("Stats/sales load error:", err);
      salesStatusEl.textContent =
        "Sales data unavailable. Check back later.";
    }
  }

  // =========================
  // Init
  // =========================

  document.addEventListener("DOMContentLoaded", () => {
    loadCollectionPage(1);
    loadShowcase();
    loadStatsAndSales();
  });
})();