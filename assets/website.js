// assets/website.js
// Frontend wiring for NoPunks • NoMeta

(() => {
  "use strict";

  // =========================
  // CONFIG
  // =========================

  // Backend API base:
  // - If you're on localhost (any port), use http://localhost:3000 as the API.
  // - If you're on Render, use same-origin.
  // - Otherwise (Netlify, file://, etc.), use Render as the API host.
  const hostname = window.location.hostname;
  let API_BASE = "";

  if (hostname === "nopunksite.onrender.com") {
    API_BASE = "";
  } else if (hostname === "localhost" || hostname === "127.0.0.1") {
    // Always talk to local Node server on port 3000
    API_BASE = "http://localhost:3000";
  } else {
    API_BASE = "https://nopunksite.onrender.com";
  }

  const TOTAL_SUPPLY = 10000;
  const PAGE_SIZE = 50;

  // =========================
  // Helpers
  // =========================

  function apiUrl(path) {
    if (path.startsWith("http")) return path;
    if (!API_BASE) return path;
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
  // Local traits index
  // =========================

  let traitsIndexPromise = null;
  let traitsByTokenId = null;
  let traitsByIndex = null;

  function normaliseTraitsEntry(entry) {
    if (!entry) return [];
    if (Array.isArray(entry)) return entry;
    if (Array.isArray(entry.traits)) return entry.traits;
    if (Array.isArray(entry.attributes)) return entry.attributes;
    return [];
  }

  function loadTraitsIndex() {
    if (traitsIndexPromise) return traitsIndexPromise;

    traitsIndexPromise = fetch("/traits/traits_index.json")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for traits_index.json`);
        }
        return res.json();
      })
      .then((data) => {
        traitsByTokenId = {};
        traitsByIndex = {};

        if (Array.isArray(data)) {
          data.forEach((entry, idx) => {
            const traits = normaliseTraitsEntry(entry);
            traitsByIndex[idx] = traits;
            if (entry && (entry.token_id || entry.tokenId || entry.id)) {
              const idKey = String(
                entry.token_id || entry.tokenId || entry.id
              );
              traitsByTokenId[idKey] = traits;
            }
          });
        } else if (data && typeof data === "object") {
          Object.keys(data).forEach((key) => {
            const entry = data[key];
            const traits = normaliseTraitsEntry(entry);
            const idx = Number(key);
            if (!Number.isNaN(idx)) {
              traitsByIndex[idx] = traits;
            }
            traitsByTokenId[String(key)] = traits;
          });
        }
      })
      .catch((err) => {
        console.error("Failed to load traits_index.json", err);
        traitsByTokenId = {};
        traitsByIndex = {};
      });

    return traitsIndexPromise;
  }

  async function getTraitsFromIndexOrId(index, tokenId) {
    await loadTraitsIndex();

    if (tokenId != null && tokenId !== "" && traitsByTokenId) {
      const byId = traitsByTokenId[String(tokenId)];
      if (Array.isArray(byId) && byId.length > 0) {
        return byId;
      }
    }

    if (
      typeof index === "number" &&
      !Number.isNaN(index) &&
      index >= 0 &&
      traitsByIndex
    ) {
      const byIndex = traitsByIndex[index];
      if (Array.isArray(byIndex) && byIndex.length > 0) {
        return byIndex;
      }
    }

    return [];
  }

  // =========================
  // TOKEN MAP (index <-> tokenId)
  // =========================

  let tokenIndexByIdPromise = null;
  let tokenIndexById = null;

  function loadTokenMap() {
    if (tokenIndexByIdPromise) return tokenIndexByIdPromise;

    tokenIndexByIdPromise = fetch("/token_map.json")
      .then((res) => {
        if (res.ok) return res.json();
        return fetch("/public/token_map.json").then((res2) => {
          if (!res2.ok) {
            throw new Error(
              `HTTP ${res.status} for token_map.json and ${res2.status} for /public/token_map.json`
            );
          }
          return res2.json();
        });
      })
      .then((data) => {
        const map = {};

        if (Array.isArray(data)) {
          data.forEach((tokenId, idx) => {
            if (tokenId != null) {
              map[String(tokenId)] = idx;
            }
          });
        } else if (data && typeof data === "object") {
          Object.keys(data).forEach((indexKey) => {
            const tokenId = data[indexKey];
            if (tokenId != null) {
              const idx = Number(indexKey);
              if (!Number.isNaN(idx)) {
                map[String(tokenId)] = idx;
              }
            }
          });
        }

        tokenIndexById = map;
      })
      .catch((err) => {
        console.error("Failed to load token_map.json", err);
        tokenIndexById = {};
      });

    return tokenIndexByIdPromise;
  }

  function getCollectionIndexForTokenId(tokenId, page, idxOnPage) {
    if (tokenIndexById && tokenId) {
      const idx = tokenIndexById[String(tokenId)];
      if (typeof idx === "number" && !Number.isNaN(idx)) {
        return idx;
      }
    }
    return (page - 1) * PAGE_SIZE + idxOnPage;
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
    return (
      token.name || token.title || (tokenId ? `NO-PUNK #${tokenId}` : "NO-PUNK")
    );
  }

  function getTokenImageUrl(token) {
    if (!token) return "";
    const t = token.nft || token;
    return (
      t.image_url ||
      t.image ||
      t.image_original_url ||
      t.display_image_url ||
      (t.media &&
        t.media[0] &&
        (t.media[0].gateway || t.media[0].thumbnail)) ||
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
    return `https://opensea.io/assets/base/0x4ed83635e2309a7c067d0f98efca47b920bf79b1/${tokenId}`;
  }

  function getTokenTraits(token) {
    if (!token) return [];

    if (Array.isArray(token.traits)) return token.traits;
    if (Array.isArray(token.attributes)) return token.attributes;

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

        const collectionIndex = getCollectionIndexForTokenId(
          tokenId,
          page,
          idx
        );

        return `
          <article
            class="np-card"
            data-token-id="${safeText(tokenId)}"
            data-index="${collectionIndex}"
            data-traits=""
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
      await loadTokenMap();

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
  // Trait tooltip
  // =========================

  let tooltipEl = null;
  let scrollListenerAttached = false;

  function ensureTooltipEl() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "np-traits-tooltip hidden";
    tooltipEl.style.pointerEvents = "none";
    tooltipEl.innerHTML = `
      <div class="np-traits-header"></div>
      <div class="np-traits-body"></div>
    `;
    document.body.appendChild(tooltipEl);
    tooltipEl.addEventListener("mouseleave", hideTooltip);
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

    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top =
      cardRect.top +
      window.scrollY +
      cardRect.height / 2 -
      tooltipRect.height / 2;
    let left = cardRect.right + 16 + window.scrollX;

    if (left + tooltipRect.width + 16 > viewportWidth + window.scrollX) {
      left = cardRect.left - tooltipRect.width - 16 + window.scrollX;
    }

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

    tooltip.classList.remove("hidden");

    let traits = parseTraitsFromDataset(cardEl);

    if (traits.length > 0) {
      bodyEl.innerHTML = formatTraitsForTooltip(traits);
      positionTooltip(cardEl.getBoundingClientRect());
      return;
    }

    bodyEl.innerHTML =
      '<div class="np-traits-empty">Loading traits…</div>';
    positionTooltip(cardEl.getBoundingClientRect());

    const indexStr = cardEl.dataset.index;
    const index = parseInt(indexStr, 10);

    if (cardEl.dataset.traitsLoading === "1") {
      return;
    }
    cardEl.dataset.traitsLoading = "1";

    getTraitsFromIndexOrId(
      Number.isNaN(index) ? null : index,
      tokenId || null
    )
      .then((fromIndex) => {
        if (Array.isArray(fromIndex) && fromIndex.length > 0) {
          return fromIndex;
        }

        if (
          typeof index === "number" &&
          !Number.isNaN(index) &&
          index >= 0 &&
          index < TOTAL_SUPPLY
        ) {
          return fetchJson(`/api/nft/${index}`).then((nft) => {
            const remoteTokenId =
              nft.token_id ||
              nft.tokenId ||
              nft.identifier ||
              nft.onChainId ||
              null;

            return getTraitsFromIndexOrId(
              Number.isNaN(index) ? null : index,
              tokenId || remoteTokenId
            ).then((fromLocal) => {
              if (Array.isArray(fromLocal) && fromLocal.length > 0) {
                return fromLocal;
              }
              return getTokenTraits(nft) || [];
            });
          });
        }

        return [];
      })
      .then((finalTraits) => {
        cardEl.dataset.traits = encodeURIComponent(
          JSON.stringify(finalTraits || [])
        );
        delete cardEl.dataset.traitsLoading;

        if (!tooltip.classList.contains("hidden")) {
          if (finalTraits && finalTraits.length > 0) {
            bodyEl.innerHTML = formatTraitsForTooltip(finalTraits);
          } else {
            bodyEl.innerHTML =
              '<div class="np-traits-empty">Traits unavailable.</div>';
          }
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
    // Use event delegation so that all cards on the page (and future ones)
    // get hover behaviour without needing per-card listeners.
    if (collectionGridEl.dataset.tooltipDelegationBound === "1") {
      return;
    }
    collectionGridEl.dataset.tooltipDelegationBound = "1";

    collectionGridEl.addEventListener("mouseover", (event) => {
      const card = event.target.closest(".np-card");
      if (!card || !collectionGridEl.contains(card)) return;
      showTooltipForCard(card);
    });

    collectionGridEl.addEventListener("mouseout", (event) => {
      const card = event.target.closest(".np-card");
      if (!card) return;

      const related = event.relatedTarget;
      // If the pointer is still inside the same card, do nothing.
      if (related && card.contains(related)) return;

      hideTooltip();
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

    if (item.projectLabel) return item.projectLabel;
    if (item.project_header) return item.project_header;

    const key = (item.key || "").toLowerCase();
    if (key.includes("pnuk")) return "NOPNUK • NOMETA";
    if (key.includes("pixelpepen")) return "NO-PIXELPEPEN • NOMETA";
    if (key.includes("tiny") || key.includes("dino"))
      return "NO-TINYDINOS • NOMETA";

    if (item.label) {
      return `${safeText(item.label, "").toUpperCase()} • NOMETA`;
    }

    const slug = (item.project || item.collection || "").toLowerCase();
    if (slug.includes("pnuk")) return "NOPNUK • NOMETA";
    if (slug.includes("pixelpepen")) return "NO-PIXELPEPEN • NOMETA";
    if (slug.includes("tiny") || slug.includes("dino"))
      return "NO-TINYDINOS • NOMETA";

    return "NOPUNKS • NOMETA";
  }

  function getShowcaseCollectionUrl(item) {
    if (!item) return "#";

    // Prefer explicit collection URL if provided by the API
    if (item.collection_url) return item.collection_url;

    // Try a generic collection slug if present
    if (item.collection_slug) {
      return `https://opensea.io/collection/${item.collection_slug}`;
    }

    // Fallback mappings based on project key / name
    const key = (
      item.key ||
      item.project ||
      item.collection ||
      ""
    ).toLowerCase();

    // Explicit mapping for the main NoPunks collection so it never uses a local URL
    if (
      key.includes("nopunkism") ||
      key.includes("nopunks") ||
      (item.contract &&
        (item.contract.toLowerCase() === "0x4ed83635e2309a7c067d0f98efca47b920bf79b1" ||
          item.contract.toLowerCase().includes("4ed83635e2309a7c067d0f98efca47b920bf79b1"))) ||
      (item.contract_address &&
        item.contract_address.toLowerCase() === "0x4ed83635e2309a7c067d0f98efca47b920bf79b1")
    ) {
      return "https://opensea.io/collection/nopunkism";
    }

    if (key.includes("pnuk")) {
      return "https://opensea.io/collection/no-pnuks";
    }
    if (key.includes("pixelpepen")) {
      return "https://opensea.io/collection/no-pixelpepen";
    }
    if (key.includes("tiny") || key.includes("dino")) {
      return "https://opensea.io/collection/no-tinydinopunks";
    }

    // Final fallback: whatever NFT-level permalink we have
    return (
      item.permalink ||
      item.external_url ||
      item.opensea_url ||
      "#"
    );
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
    const permalink = getShowcaseCollectionUrl(item);

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

  // Helper: dedupe array of items by tokenId, keeping first N unique
  function uniqueByTokenId(items, limit) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const id = getTokenId(item);
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

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

    // Now wired to server.js "buyer"
    const buyer =
      sale.buyer ||
      sale.to_address ||
      (sale.taker && sale.taker.address) ||
      "";
    const timeAgo = sale.timeAgo || sale.relative_time || "";
    const hasBuyer = !!buyer;
    const buyerLabel = hasBuyer ? formatShortAddress(buyer) : "";
    const metaText = hasBuyer
      ? `Sold to ${buyerLabel} ${safeText(timeAgo)}`
      : `Sold ${safeText(timeAgo)}`;

    return `
      <a class="np-sale-row" href="${permalink}" target="_blank" rel="noreferrer">
        <div class="np-sale-left">
          <img src="${imageUrl}" alt="No-Punk #${tokenId}" loading="lazy" />
        </div>
        <div class="np-sale-main">
          <div>
            <div class="np-sale-token">NO-PUNK #${safeText(tokenId)}</div>
            <div class="np-sale-meta">${metaText}</div>
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

    // Now wired to server.js "seller"
    const seller =
      listing.seller ||
      listing.from_address ||
      (listing.maker && listing.maker.address) ||
      "";
    const hasSeller = !!seller;
    const sellerLabel = hasSeller ? formatShortAddress(seller) : "";
    const metaText = hasSeller
      ? `Listed by ${sellerLabel}`
      : "Listed";

    return `
      <a class="np-listing-row" href="${permalink}" target="_blank" rel="noreferrer">
        <div class="np-listing-left">
          <img src="${imageUrl}" alt="No-Punk #${tokenId}" loading="lazy" />
        </div>
        <div class="np-listing-main">
          <div>
            <div class="np-listing-token">NO-PUNK #${safeText(tokenId)}</div>
            <div class="np-listing-meta">${metaText}</div>
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

      // IMPORTANT: no Ξ symbols here; HTML label can contain the unit.
      floorPriceEl.textContent = formatEth(floor);
      totalVolumeEl.textContent = formatEth(volume);
      numOwnersEl.textContent = safeText(owners, "--");

      const sales = recent.sales || recent.items || recent.events || [];
      if (Array.isArray(sales) && sales.length > 0) {
        const uniqueSales = uniqueByTokenId(sales, 10);
        recentSalesListEl.innerHTML = uniqueSales
          .map(createSaleRowHtml)
          .join("");
      } else {
        recentSalesListEl.innerHTML =
          '<div class="text-[11px] text-white/50">No recent sales cached.</div>';
      }

      const listings =
        listed.listings || listed.items || listed.events || [];
      if (Array.isArray(listings) && listings.length > 0) {
        const uniqueListings = uniqueByTokenId(listings, 10);
        listedTokensListEl.innerHTML = uniqueListings
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