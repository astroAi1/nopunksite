// NoPunks front-end logic
// - Tabs
// - Paginated collection grid (with trait hover)
// - Daily showcase playing-cards
// - Stats + recent sales + listings

(function () {
  const COLLECTION_SIZE = 10000;
  const PAGE_SIZE = 50; // 10 x 5 grid per page
  const TOTAL_PAGES = Math.ceil(COLLECTION_SIZE / PAGE_SIZE);
  const COLLECTION_CONTRACT = "0x4ed83635e2309a7c067d0f98efca47b920bf79b1";
  const CHAIN_KEY = "base"; // for OpenSea links

  let currentPage = 1;
  let showcaseLoaded = false;
  let salesLoaded = false;

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function qs(sel) {
    return document.querySelector(sel);
  }

  function qsa(sel) {
    return Array.from(document.querySelectorAll(sel));
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function initTabs() {
    const tabButtons = qsa(".np-tab");
    const sections = qsa("[data-tab-section]");

    function setActiveTab(tabName) {
      tabButtons.forEach((btn) => {
        const isActive = btn.dataset.tab === tabName;
        btn.classList.toggle("np-tab--active", isActive);
      });

      sections.forEach((sec) => {
        const isActive = sec.dataset.tabSection === tabName;
        sec.classList.toggle("hidden", !isActive);
      });

      if (tabName === "showcase") {
        loadShowcaseOnce();
      } else if (tabName === "sales") {
        loadSalesOnce();
      }
    }

    tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tabName = btn.dataset.tab;
        if (!tabName) return;
        setActiveTab(tabName);
      });
    });

    // Default tab
    setActiveTab("collection");
  }

  // ---------------------------------------------------------------------------
  // Trait tooltip (liquid glass)
  // ---------------------------------------------------------------------------

  const traitTooltip = document.createElement("div");
  traitTooltip.className = "np-traits-tooltip";
  traitTooltip.style.display = "none";
  document.body.appendChild(traitTooltip);

  function buildTraitTooltipHtml(title, traits) {
    const rows = traits
      .map((t) => {
        const type = (t.trait_type || t.type || "").toString();
        const value = (t.value || "").toString();
        if (!type && !value) return "";
        return `
          <div class="np-traits-row">
            <span class="np-traits-type">${escapeHtml(type)}</span>
            <span class="np-traits-value">${escapeHtml(value)}</span>
          </div>`;
      })
      .filter(Boolean)
      .join("");

    return `
      <div class="np-traits-header">${escapeHtml(title)}</div>
      <div class="np-traits-body">
        ${
          rows ||
          '<div class="np-traits-row"><span class="np-traits-value">No traits</span></div>'
        }
      </div>`;
  }

  // Anchor tooltip to the side of the card (left/right), not covering the NoPunk
  function positionTooltipForCard(cardEl) {
    const padding = 12;
    const rect = cardEl.getBoundingClientRect();

    // Reset so we can measure correctly with new content
    traitTooltip.style.left = "0px";
    traitTooltip.style.top = "0px";
    const tooltipRect = traitTooltip.getBoundingClientRect();

    // Decide whether to place tooltip on the right or left of the card
    const placeRight = rect.left + rect.width / 2 < window.innerWidth / 2;

    let x;
    let y = rect.top + (rect.height - tooltipRect.height) / 2;

    if (placeRight) {
      // To the right of the card
      x = rect.right + 16;
    } else {
      // To the left of the card
      x = rect.left - tooltipRect.width - 16;
    }

    // Clamp inside viewport
    const minX = padding;
    const maxX = window.innerWidth - tooltipRect.width - padding;
    const minY = padding;
    const maxY = window.innerHeight - tooltipRect.height - padding;

    x = Math.min(Math.max(x, minX), maxX);
    y = Math.min(Math.max(y, minY), maxY);

    traitTooltip.style.left = `${x}px`;
    traitTooltip.style.top = `${y}px`;
  }

  function attachTraitHover(cardEl, nft, displayId) {
    const traits =
      nft.traits ||
      nft.attributes ||
      (nft.metadata && nft.metadata.attributes) ||
      [];

    if (!traits || !traits.length) return;

    const title = `NO-PUNK #${displayId}`;

    cardEl.addEventListener("mouseenter", () => {
      traitTooltip.innerHTML = buildTraitTooltipHtml(title, traits);
      traitTooltip.style.display = "block";

      // Wait one frame so the tooltip has its final size, then position
      requestAnimationFrame(() => {
        positionTooltipForCard(cardEl);
      });
    });

    cardEl.addEventListener("mouseleave", () => {
      traitTooltip.style.display = "none";
    });
  }

  // ---------------------------------------------------------------------------
  // Collection grid
  // ---------------------------------------------------------------------------

  const collectionGrid = qs("#collection-grid");
  const collectionSummary = qs("#collection-summary");
  const collectionError = qs("#collection-error");
  const prevPageBtn = qs("#prev-page");
  const nextPageBtn = qs("#next-page");
  const pageInfo = qs("#page-info");

  async function loadCollectionPage(page) {
    currentPage = page;

    const startIndex = (page - 1) * PAGE_SIZE;
    const endIndex = Math.min(startIndex + PAGE_SIZE, COLLECTION_SIZE);

    if (collectionSummary) {
      collectionSummary.textContent = `10,000 NoPunks on Base. Showing ${
        startIndex + 1
      }–${endIndex} via OpenSea (proxied through the server).`;
    }
    if (pageInfo) {
      pageInfo.textContent = `Page ${page} / ${TOTAL_PAGES}`;
    }
    if (prevPageBtn) prevPageBtn.disabled = page === 1;
    if (nextPageBtn) nextPageBtn.disabled = page === TOTAL_PAGES;

    if (collectionGrid) collectionGrid.innerHTML = "";
    if (collectionError) {
      collectionError.textContent = "";
      collectionError.style.display = "none";
    }

    const indices = [];
    for (let i = startIndex; i < endIndex; i++) indices.push(i);

    try {
      const promises = indices.map((idx) =>
        fetch(`/api/nft/${idx}`)
          .then((res) => {
            if (!res.ok) throw new Error(`Index ${idx} HTTP ${res.status}`);
            return res.json();
          })
          .catch((err) => {
            console.error("NFT load failed for index", idx, err);
            return null;
          })
      );

      const results = await Promise.all(promises);

      if (!collectionGrid) return;

      for (let i = 0; i < results.length; i++) {
        const nft = results[i];
        const slotIndex = indices[i];
        if (!nft || !nft.image_url) continue;

        const card = buildCollectionCard(nft, slotIndex);
        collectionGrid.appendChild(card);
      }

      if (!collectionGrid.children.length && collectionError) {
        collectionError.textContent =
          "NoPunks failed to load from the server. Try refreshing.";
        collectionError.style.display = "block";
      }
    } catch (err) {
      console.error("Collection page error", err);
      if (collectionError) {
        collectionError.textContent =
          "Unexpected error loading collection. Please retry.";
        collectionError.style.display = "block";
      }
    }
  }

  function buildCollectionCard(nft, slotIndex) {
    const tokenId =
      nft.onChainId ||
      nft.identifier ||
      nft.token_id ||
      nft.tokenId ||
      String(slotIndex + 1);

    const osUrl = `https://opensea.io/assets/${CHAIN_KEY}/${COLLECTION_CONTRACT}/${tokenId}`;

    const card = document.createElement("article");
    card.className = "np-card";

    const link = document.createElement("a");
    link.className = "np-card-link";
    link.href = osUrl;
    link.target = "_blank";
    link.rel = "noreferrer";

    const imgWrap = document.createElement("div");
    imgWrap.className = "np-card-image-wrap";

    const img = document.createElement("img");
    img.src = nft.image_url;
    img.alt = `NoPunk #${tokenId}`;
    img.loading = "lazy";
    imgWrap.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "np-card-meta";

    const title = document.createElement("div");
    title.className = "np-card-title";
    title.textContent = `NO-PUNK #${tokenId}`;

    meta.appendChild(title);
    // No SLOT line – keep clean

    link.appendChild(imgWrap);
    link.appendChild(meta);
    card.appendChild(link);

    attachTraitHover(card, nft, tokenId);

    return card;
  }

  // ---------------------------------------------------------------------------
  // Showcase (playing card layout)
  // ---------------------------------------------------------------------------

  const showcaseGrid = qs("#showcase-grid");
  const showcaseStatus = qs("#showcase-status");

  function loadShowcaseOnce() {
    if (showcaseLoaded) return;
    showcaseLoaded = true;
    loadShowcase();
  }

  async function loadShowcase() {
    if (showcaseStatus) {
      showcaseStatus.textContent = "NoMeta loading...";
    }
    if (showcaseGrid) {
      showcaseGrid.innerHTML = "";
    }

    try {
      const res = await fetch("/api/showcase");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const picks = Array.isArray(data.showcase) ? data.showcase : [];

      if (!showcaseGrid) return;

      if (!picks.length) {
        showcaseGrid.innerHTML = "";
        if (showcaseStatus) {
          showcaseStatus.textContent = "NoMeta loading...";
        }
        return;
      }

      picks.forEach((pick) => {
        const card = buildShowcaseCard(pick);
        showcaseGrid.appendChild(card);
      });

      if (showcaseStatus) {
        showcaseStatus.textContent = "Showcase updates once every 24 hours.";
      }
    } catch (err) {
      console.error("Showcase error", err);
      if (showcaseStatus) {
        showcaseStatus.textContent = "Showcase unavailable. Check back later.";
      }
    }
  }

  function buildShowcaseCard(pick) {
    const tokenId = pick.tokenId || pick.onChainId || "";
    const label = pick.label || pick.key || "Collection";
    const osUrl = tokenId
      ? `https://opensea.io/assets/${CHAIN_KEY}/${pick.contract}/${tokenId}`
      : null;

    const wrap = document.createElement("div");
    wrap.className = "np-playing-card-wrap";

    const card = document.createElement("article");
    card.className = "np-playing-card";
    wrap.appendChild(card);

    const inner = document.createElement("div");
    inner.className = "np-playing-card-inner";
    card.appendChild(inner);

    // Header
    const header = document.createElement("div");
    header.className = "np-playing-card-header";

    const kicker = document.createElement("div");
    kicker.className = "np-playing-card-kicker";

    const dot = document.createElement("div");
    dot.className = "np-playing-card-kicker-dot";
    kicker.appendChild(dot);

    const kickerLabel = document.createElement("span");
    kickerLabel.className = "np-playing-card-kicker-label";
    const displayLabel = label ? String(label).toUpperCase() : "COLLECTION";
    kickerLabel.textContent = `${displayLabel} • NOMETA`;
    kicker.appendChild(kickerLabel);

    const idEl = document.createElement("div");
    idEl.className = "np-playing-card-id";
    idEl.textContent = tokenId ? `#${tokenId}` : "--";

    header.appendChild(kicker);
    header.appendChild(idEl);
    inner.appendChild(header);

    const headerLine = document.createElement("div");
    headerLine.className = "np-playing-card-header-line";
    inner.appendChild(headerLine);

    // Image region
    const media = document.createElement("div");
    media.className = "np-playing-card-media";

    const frame = document.createElement("div");
    frame.className = "np-playing-card-image-frame";

    const imgWrap = document.createElement("div");
    imgWrap.className = "np-playing-card-image-wrap";

    const img = document.createElement("img");
    img.className = "np-playing-card-image";
    img.src = pick.image_url || "";
    img.alt = `${label} #${tokenId}`;
    img.loading = "lazy";

    imgWrap.appendChild(img);
    frame.appendChild(imgWrap);
    media.appendChild(frame);
    inner.appendChild(media);

    // Bottom stats
    const bottom = document.createElement("div");
    bottom.className = "np-playing-card-bottom";

    const divider = document.createElement("div");
    divider.className = "np-playing-card-divider";
    bottom.appendChild(divider);

    const stats = document.createElement("div");
    stats.className = "np-playing-card-stats";

    const stat1 = document.createElement("div");
    stat1.className = "np-playing-card-stat";
    stat1.innerHTML =
      '<div class="np-playing-card-stat-label">Collection</div>' +
      `<div class="np-playing-card-stat-value">${escapeHtml(label)}</div>`;

    const stat2 = document.createElement("div");
    stat2.className = "np-playing-card-stat";
    stat2.innerHTML =
      '<div class="np-playing-card-stat-label">Token</div>' +
      `<div class="np-playing-card-stat-value">${
        tokenId ? "#" + escapeHtml(String(tokenId)) : "—"
      }</div>`;

    const stat3 = document.createElement("div");
    stat3.className = "np-playing-card-stat";
    stat3.innerHTML =
      '<div class="np-playing-card-stat-label">Chain</div>' +
      '<div class="np-playing-card-stat-value">Base</div>';

    stats.appendChild(stat1);
    stats.appendChild(stat2);
    stats.appendChild(stat3);
    bottom.appendChild(stats);

    const footer = document.createElement("div");
    footer.className = "np-playing-card-footer";
    footer.innerHTML =
      '<div class="np-playing-card-footer-dot"></div>' +
      "<span>Verified</span>";
    bottom.appendChild(footer);

    inner.appendChild(bottom);

    // Corner lines
    ["tl", "tr", "bl", "br"].forEach((pos) => {
      const corner = document.createElement("div");
      corner.className = `np-playing-card-corner np-playing-card-corner--${pos}`;
      card.appendChild(corner);
    });

    if (osUrl) {
      wrap.addEventListener("click", () => {
        window.open(osUrl, "_blank", "noopener,noreferrer");
      });
    }

    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Stats + sales
  // ---------------------------------------------------------------------------

  const floorEl = qs("#floor-price");
  const volumeEl = qs("#total-volume");
  const ownersEl = qs("#num-owners");
  const salesStatusEl = qs("#sales-status");
  const recentSalesList = qs("#recent-sales-list");
  const listedTokensList = qs("#listed-tokens-list");

  function loadSalesOnce() {
    if (salesLoaded) return;
    salesLoaded = true;
    loadStatsAndSales();
  }

  async function loadStatsAndSales() {
    if (salesStatusEl) {
      salesStatusEl.textContent = "NoMeta loading...";
    }

    try {
      // Stats
      const statsRes = await fetch("/api/stats");
      if (statsRes.ok) {
        const stats = await statsRes.json();
        if (floorEl) floorEl.textContent = formatEth(stats.floorPrice);
        if (volumeEl) floorEl && (volumeEl.textContent = formatEth(stats.totalVolume));
        if (ownersEl) {
          ownersEl.textContent =
            stats.numOwners != null ? stats.numOwners.toLocaleString() : "--";
        }
      }

      // Recent sales
      const salesRes = await fetch("/api/recent-sales");
      if (salesRes.ok) {
        const data = await salesRes.json();
        renderRecentSales(Array.isArray(data.sales) ? data.sales : []);
      }

      // Listed tokens
      const listedRes = await fetch("/api/listed");
      if (listedRes.ok) {
        const data = await listedRes.json();
        renderListings(Array.isArray(data.listings) ? data.listings : []);
      }

      if (salesStatusEl) {
        salesStatusEl.textContent = "Stats refresh each time you open this tab.";
      }
    } catch (err) {
      console.error("Stats/sales error", err);
      if (salesStatusEl) {
        salesStatusEl.textContent =
          "Market data currently unavailable. Try again later.";
      }
    }
  }

  function renderRecentSales(sales) {
    if (!recentSalesList) return;
    recentSalesList.innerHTML = "";

    if (!sales.length) {
      recentSalesList.textContent = "No recent sales found.";
      return;
    }

    sales.forEach((sale) => {
      const row = document.createElement("div");
      row.className = "np-sale-row";

      const left = document.createElement("div");
      left.className = "np-sale-left";
      const img = document.createElement("img");
      img.src = sale.image_url || "";
      img.alt = sale.onChainId ? `NoPunk #${sale.onChainId}` : "NoPunk";
      img.loading = "lazy";
      left.appendChild(img);

      const main = document.createElement("div");
      main.className = "np-sale-main";
      main.style.width = "100%";

      const token = document.createElement("div");
      token.className = "np-sale-token";
      token.textContent = sale.onChainId
        ? `NoPunk #${sale.onChainId}`
        : "Sale";

      const price = document.createElement("div");
      price.className = "np-sale-price";
      if (sale.price != null) {
        price.textContent = `${sale.price.toFixed(3)} ${sale.unit || "ETH"}`;
      } else {
        price.textContent = "--";
      }

      main.appendChild(token);
      main.appendChild(price);

      const meta = document.createElement("div");
      meta.className = "np-sale-meta";
      meta.textContent = sale.time ? timeAgo(sale.time) : "";

      const rightWrapper = document.createElement("div");
      rightWrapper.style.display = "flex";
      rightWrapper.style.flexDirection = "column";
      rightWrapper.style.flex = "1";
      rightWrapper.appendChild(main);
      rightWrapper.appendChild(meta);

      row.appendChild(left);
      row.appendChild(rightWrapper);

      // Make row clickable -> OpenSea
      const saleTokenId = sale.onChainId || sale.tokenId || sale.identifier;
      const saleContract = sale.contract || COLLECTION_CONTRACT;
      const saleChain = sale.chain || CHAIN_KEY;
      if (saleTokenId != null) {
        const osUrl = `https://opensea.io/assets/${saleChain}/${saleContract}/${saleTokenId}`;
        row.style.cursor = "pointer";
        row.addEventListener("click", () => {
          window.open(osUrl, "_blank", "noopener,noreferrer");
        });
      }

      recentSalesList.appendChild(row);
    });
  }

  function renderListings(listings) {
    if (!listedTokensList) return;
    listedTokensList.innerHTML = "";

    if (!listings.length) {
      listedTokensList.textContent = "No NoPunks currently listed.";
      return;
    }

    listings.forEach((lst) => {
      const row = document.createElement("div");
      row.className = "np-listing-row";

      const left = document.createElement("div");
      left.className = "np-listing-left";
      const img = document.createElement("img");
      img.src = lst.image_url || "";
      img.alt = lst.onChainId ? `NoPunk #${lst.onChainId}` : "Listing";
      img.loading = "lazy";
      left.appendChild(img);

      const main = document.createElement("div");
      main.className = "np-listing-main";
      main.style.width = "100%";

      const token = document.createElement("div");
      token.className = "np-listing-token";
      token.textContent = lst.onChainId
        ? `NoPunk #${lst.onChainId}`
        : "Listing";

      const price = document.createElement("div");
      price.className = "np-listing-price";
      if (lst.price != null) {
        price.textContent = `${lst.price.toFixed(3)} ${lst.unit || "ETH"}`;
      } else {
        price.textContent = "--";
      }

      main.appendChild(token);
      main.appendChild(price);

      const meta = document.createElement("div");
      meta.className = "np-listing-meta";
      meta.textContent = lst.source || "OpenSea";

      const rightWrapper = document.createElement("div");
      rightWrapper.style.display = "flex";
      rightWrapper.style.flexDirection = "column";
      rightWrapper.style.flex = "1";
      rightWrapper.appendChild(main);
      rightWrapper.appendChild(meta);

      row.appendChild(left);
      row.appendChild(rightWrapper);

      // Make row clickable -> OpenSea
      const listTokenId = lst.onChainId || lst.tokenId || lst.identifier;
      const listContract = lst.contract || COLLECTION_CONTRACT;
      const listChain = lst.chain || CHAIN_KEY;
      if (listTokenId != null) {
        const osUrl = `https://opensea.io/assets/${listChain}/${listContract}/${listTokenId}`;
        row.style.cursor = "pointer";
        row.addEventListener("click", () => {
          window.open(osUrl, "_blank", "noopener,noreferrer");
        });
      }

      listedTokensList.appendChild(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatEth(value) {
    if (value == null || !isFinite(value)) return "--";
    const n = Number(value);
    if (n === 0) return "0";
    if (n < 0.001) return n.toExponential(2);
    return n.toFixed(3).replace(/\.?0+$/, "");
  }

  function timeAgo(iso) {
    const now = Date.now();
    const t = new Date(iso).getTime();
    if (!t) return "";
    const diff = Math.max(0, now - t);
    const sec = Math.floor(diff / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (day > 0) return `${day}d ago`;
    if (hr > 0) return `${hr}h ago`;
    if (min > 0) return `${min}m ago`;
    return `${sec}s ago`;
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    initTabs();

    if (prevPageBtn) {
      prevPageBtn.addEventListener("click", () => {
        if (currentPage > 1) {
          loadCollectionPage(currentPage - 1);
        }
      });
    }

    if (nextPageBtn) {
      nextPageBtn.addEventListener("click", () => {
        if (currentPage < TOTAL_PAGES) {
          loadCollectionPage(currentPage + 1);
        }
      });
    }

    // Initial load
    loadCollectionPage(1);
  });
})();