// --- Game/layout constants -------------------------------------

const GAME_WIDTH = 800;
const GAME_HEIGHT = 400;

// Inner "table" bounds (inside the canvas)
const TABLE_TOP = 40;
const TABLE_BOTTOM = GAME_HEIGHT - 40;
const TABLE_LEFT = 40;
const TABLE_RIGHT = GAME_WIDTH - 40;

const BALL_SIZE = 14;
const BALL_SPEED = 4;
const PADDLE_HEIGHT = 100;
const PADDLE_WIDTH = 80; // Wider to match sprite size
// paddles sit just inside the table edges
const PADDLE_MARGIN = TABLE_LEFT + 8;
const PADDLE_SPEED = 5;
const RETRO_WHITE = "#ffffff"; // Classic white
const BASE_BLUE = "#0052ff";

const MATCH_POINTS = 7;
const FINAL_MATCH_POINTS = 9;

const FRAME_MS = 1000 / 60;
const MAX_DELTA = 48;

const AI_TARGET_REFRESH_MS = 90;
const AI_NOISE = 6;

// --- NoPunks Contract Constants ----------------------------------
const NOPUNKS_CONTRACT = "0xa62f65d503068684e7228df98090f94322b8ed54";
const BASE_CHAIN_ID = 8453; // Base mainnet
const BASE_RPC_URL = "https://mainnet.base.org";
const MAX_TOKEN_ID = 9999; // Only use tokens 0-9999

// Minimal ERC721 ABI for enumeration
const ERC721_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)"
];

const TOKEN_URI_ABI = ["function tokenURI(uint256 tokenId) view returns (string)"];

// --- DOM refs ---------------------------------------------------

const gameCanvas = document.getElementById("game");
const ctx = gameCanvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

const leftIdInput = document.getElementById("left-id");
const rightIdInput = document.getElementById("right-id");
const leftPreview = document.getElementById("left-preview");
const rightPreview = document.getElementById("right-preview");
const randomizeBtn = document.getElementById("randomize");
const resetBtn = document.getElementById("reset");
const scoreLeftEl = document.getElementById("score-left");
const scoreRightEl = document.getElementById("score-right");

const connectBtn = document.getElementById("connect-wallet");
const walletAddressEl = document.getElementById("wallet-address");
const walletNetworkEl = document.getElementById("wallet-network");
const leaderboardBody = document.getElementById("leaderboard-body");
const onlineBody = document.getElementById("online-body");

const tournamentSizeSelect = document.getElementById("tournament-size");
const startTournamentBtn = document.getElementById("start-tournament");
const resetTournamentBtn = document.getElementById("reset-tournament");
const setPrizeBtn = document.getElementById("set-prize");
const prizeSummaryEl = document.getElementById("prize-summary");
const tournamentBracketEl = document.getElementById("tournament-bracket");
const tournamentStatusEl = document.getElementById("tournament-status");

// NFT selection elements
const selectLeftBtn = document.getElementById("select-left");
const selectRightBtn = document.getElementById("select-right");
const leftNftDropdown = document.getElementById("left-nft-dropdown");
const rightNftDropdown = document.getElementById("right-nft-dropdown");

const lpCtx = leftPreview.getContext("2d");
const rpCtx = rightPreview.getContext("2d");
lpCtx.imageSmoothingEnabled = false;
rpCtx.imageSmoothingEnabled = false;

// --- State ------------------------------------------------------

let leftSprite = null;
let rightSprite = null;

let leftY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;
let rightY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;
let ballX = GAME_WIDTH / 2;
let ballY = GAME_HEIGHT / 2;
let ballVX = BALL_SPEED;
let ballVY = BALL_SPEED * 0.4;
let scoreLeft = 0;
let scoreRight = 0;
let matchTarget = MATCH_POINTS;
let activeMatch = null;

// Multiplayer state
let gameMode = 'practice'; // 'practice' or 'multiplayer'
let isMultiplayerPlayer1 = true; // Are we player 1 (left) or player 2 (right)?
let multiplayerMatchId = null;
let leftNftId = 0; // Track selected NFT ID for multiplayer

// Keyboard: human on left (W/S)
const keys = {
  w: false,
  s: false,
};

// Wallet + session leaderboard
let currentWallet = null;
let provider = null;
let signer = null;
let noPunksContract = null;
let ownedNoPunks = []; // Array of token IDs owned by connected wallet
let enumerationSupported = true;
const sessionStats = {}; // address -> { pointsFor, pointsAgainst }

// Players online (front-end only for now)
let onlinePlayers = []; // { address, status }

let tournament = null;
let prizeConfig = null;
let aiRefreshTimer = 0;
let aiTargetY = rightY;
let lastFrameTime = performance.now();
const imageCache = new Map();

const TOURNAMENT_STORAGE_KEY = "nopunks_pingpong_tournament";
const PRIZE_STORAGE_KEY = "nopunks_pingpong_prize";

// --- Helpers ----------------------------------------------------

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getReadProvider() {
  if (provider) return provider;
  if (typeof ethers !== "undefined") {
    return new ethers.providers.JsonRpcProvider(BASE_RPC_URL);
  }
  return null;
}

async function fetchTokenImage(tokenId) {
  if (imageCache.has(tokenId)) {
    return imageCache.get(tokenId);
  }

  const readProvider = getReadProvider();
  if (!readProvider) return null;

  try {
    const contract = new ethers.Contract(NOPUNKS_CONTRACT, TOKEN_URI_ABI, readProvider);
    const tokenUri = await contract.tokenURI(tokenId);
    if (!tokenUri) return null;

    let jsonText = "";
    if (tokenUri.startsWith("data:application/json;base64,")) {
      jsonText = atob(tokenUri.replace("data:application/json;base64,", ""));
    } else if (tokenUri.startsWith("data:application/json,")) {
      jsonText = decodeURIComponent(tokenUri.replace("data:application/json,", ""));
    } else {
      const resp = await fetch(tokenUri);
      jsonText = await resp.text();
    }

    const metadata = JSON.parse(jsonText);
    const image = metadata.image || "";
    if (!image) return null;

    let imageSrc = image;
    if (image.startsWith("data:image/svg+xml;utf8,")) {
      const raw = image.replace("data:image/svg+xml;utf8,", "");
      imageSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
    }

    imageCache.set(tokenId, imageSrc);
    return imageSrc;
  } catch (err) {
    console.warn("Failed to fetch onchain image:", err);
    return null;
  }
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function loadPrizeConfig() {
  const raw = localStorage.getItem(PRIZE_STORAGE_KEY);
  prizeConfig = safeJsonParse(raw, null);
  renderPrize();
}

function savePrizeConfig() {
  if (!prizeConfig) {
    localStorage.removeItem(PRIZE_STORAGE_KEY);
    return;
  }
  localStorage.setItem(PRIZE_STORAGE_KEY, JSON.stringify(prizeConfig));
}

function renderPrize() {
  if (!prizeSummaryEl) return;
  if (!prizeConfig) {
    prizeSummaryEl.textContent = "No prize loaded yet.";
    return;
  }

  const details = [
    `Name: ${prizeConfig.name || "Untitled"}`,
    prizeConfig.description ? `Desc: ${prizeConfig.description}` : null,
    prizeConfig.host ? `Host: ${shortAddress(prizeConfig.host)}` : null,
  ].filter(Boolean);

  prizeSummaryEl.textContent = details.join(" · ");
}

function promptPrize() {
  const name = prompt("Prize name?", prizeConfig?.name || "No-PingPong Champion");
  if (!name) return;
  const description = prompt("Prize description?", prizeConfig?.description || "Winner of the free No-PingPong bracket.");
  const imageUrl = prompt("Prize image URL (optional)?", prizeConfig?.imageUrl || "");
  prizeConfig = {
    name: name.trim(),
    description: description ? description.trim() : "",
    imageUrl: imageUrl ? imageUrl.trim() : "",
    host: currentWallet || "",
    createdAt: new Date().toISOString(),
  };
  savePrizeConfig();
  renderPrize();
}

function saveTournament() {
  if (!tournament) {
    localStorage.removeItem(TOURNAMENT_STORAGE_KEY);
    return;
  }
  localStorage.setItem(TOURNAMENT_STORAGE_KEY, JSON.stringify(tournament));
}

function loadTournament() {
  const raw = localStorage.getItem(TOURNAMENT_STORAGE_KEY);
  tournament = safeJsonParse(raw, null);
  renderTournament();
  if (tournament && tournament.status === "in-progress") {
    setControlsLocked(true);
    advanceTournament();
  }
}

function makePlayer(label, tokenId, isHuman) {
  return {
    label,
    tokenId,
    isHuman,
  };
}

function randomTokenId() {
  return Math.floor(Math.random() * 10000);
}

function buildTournament(size) {
  const players = [];
  const humanId = clampId(leftIdInput?.value || 0);
  players.push(makePlayer("You", humanId, true));

  for (let i = 1; i < size; i++) {
    const id = randomTokenId();
    players.push(makePlayer(`CPU-${i}`, id, false));
  }

  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }

  const rounds = [];
  let currentPlayers = players;
  let roundIndex = 0;

  while (currentPlayers.length > 1) {
    const matches = [];
    for (let i = 0; i < currentPlayers.length; i += 2) {
      matches.push({
        left: currentPlayers[i],
        right: currentPlayers[i + 1],
        winner: null,
        round: roundIndex,
      });
    }
    rounds.push(matches);
    currentPlayers = new Array(matches.length).fill(null);
    roundIndex += 1;
  }

  return {
    size,
    rounds,
    currentRound: 0,
    currentMatch: 0,
    status: "ready",
    startedAt: new Date().toISOString(),
    winner: null,
    claimCode: null,
  };
}

function getMatchDisplayName(player) {
  if (!player) return "TBD";
  if (player.isHuman) return `${player.label} (#${player.tokenId})`;
  return `${player.label} (#${player.tokenId})`;
}

function renderTournament() {
  if (!tournamentBracketEl || !tournamentStatusEl) return;
  tournamentBracketEl.innerHTML = "";

  if (startTournamentBtn) {
    startTournamentBtn.disabled = tournament && tournament.status === "in-progress";
  }
  if (resetTournamentBtn) {
    resetTournamentBtn.disabled = !tournament;
  }

  if (!tournament) {
    tournamentStatusEl.textContent = "No tournament running.";
    return;
  }

  tournament.rounds.forEach((round, roundIndex) => {
    const roundEl = document.createElement("div");
    roundEl.className = "tournament-round";
    const title = document.createElement("h4");
    title.textContent = roundIndex === tournament.rounds.length - 1 ? "Final" : `Round ${roundIndex + 1}`;
    roundEl.appendChild(title);

    round.forEach((match, matchIndex) => {
      const matchEl = document.createElement("div");
      matchEl.className = "tournament-match";
      if (roundIndex === tournament.currentRound && matchIndex === tournament.currentMatch && tournament.status === "in-progress") {
        matchEl.classList.add("match-active");
      }
      if (match.winner) {
        matchEl.classList.add("match-winner");
      }
      const leftSpan = document.createElement("span");
      leftSpan.textContent = getMatchDisplayName(match.left);
      const rightSpan = document.createElement("span");
      rightSpan.textContent = getMatchDisplayName(match.right);
      matchEl.appendChild(leftSpan);
      matchEl.appendChild(rightSpan);
      roundEl.appendChild(matchEl);
    });

    tournamentBracketEl.appendChild(roundEl);
  });

  if (tournament.status === "complete") {
    tournamentStatusEl.textContent = `Tournament complete. Winner: ${getMatchDisplayName(tournament.winner)}. Claim code: ${tournament.claimCode || "pending"}.`;
  } else if (tournament.status === "in-progress") {
    const match = tournament.rounds[tournament.currentRound][tournament.currentMatch];
    tournamentStatusEl.textContent = `Current match: ${getMatchDisplayName(match.left)} vs ${getMatchDisplayName(match.right)}.`;
  } else {
    tournamentStatusEl.textContent = "Tournament ready. Start when you are.";
  }
}

function setControlsLocked(locked) {
  const controls = [leftIdInput, rightIdInput, randomizeBtn, selectLeftBtn, selectRightBtn, leftNftDropdown, rightNftDropdown];
  controls.forEach((el) => {
    if (!el) return;
    el.disabled = locked;
  });
}

function resolveCpuMatch(match) {
  if (!match) return null;
  const winner = Math.random() > 0.5 ? match.left : match.right;
  match.winner = winner;
  return winner;
}

function advanceTournament() {
  if (!tournament) return;
  const round = tournament.rounds[tournament.currentRound];
  let nextIndex = tournament.currentMatch;

  while (nextIndex < round.length) {
    const match = round[nextIndex];
    if (match.winner) {
      nextIndex += 1;
      continue;
    }

    if (match.left?.isHuman || match.right?.isHuman) {
      tournament.currentMatch = nextIndex;
      startMatch(match.left, match.right);
      saveTournament();
      renderTournament();
      return;
    }

    resolveCpuMatch(match);
    nextIndex += 1;
  }

  const winners = round.map((match) => match.winner);
  const nextRoundIndex = tournament.currentRound + 1;
  if (nextRoundIndex >= tournament.rounds.length) {
    tournament.status = "complete";
    tournament.winner = winners[0];
    tournament.claimCode = tournament.claimCode || `NP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    saveTournament();
    renderTournament();
    setControlsLocked(false);
    return;
  }

  const nextRound = tournament.rounds[nextRoundIndex];
  for (let i = 0; i < nextRound.length; i++) {
    nextRound[i].left = winners[i * 2];
    nextRound[i].right = winners[i * 2 + 1];
  }

  tournament.currentRound = nextRoundIndex;
  tournament.currentMatch = 0;
  saveTournament();
  advanceTournament();
}

function startTournament() {
  const size = parseInt(tournamentSizeSelect?.value || "8", 10);
  tournament = buildTournament(size);
  tournament.status = "in-progress";
  tournament.currentRound = 0;
  tournament.currentMatch = 0;
  saveTournament();
  setControlsLocked(true);
  advanceTournament();
}

function resetTournament() {
  tournament = null;
  saveTournament();
  renderTournament();
  setControlsLocked(false);
}

async function loadNoPunk(id, side) {
  const img = new Image();
  const onchainSrc = await fetchTokenImage(id);
  if (!onchainSrc) return;
  img.src = onchainSrc;
  img.onload = () => {
    if (side === "left") {
      leftSprite = img;
      drawPreview(lpCtx, img);
    } else {
      rightSprite = img;
      drawPreview(rpCtx, img);
    }
  };
}

function drawPreview(pctx, img) {
  pctx.clearRect(0, 0, pctx.canvas.width, pctx.canvas.height);
  const scale = 2.5; // upscale 24→~60
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (pctx.canvas.width - w) / 2;
  const y = (pctx.canvas.height - h) / 2;
  pctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h);
}

function startMatch(leftPlayer, rightPlayer) {
  if (rightPlayer?.isHuman && !leftPlayer?.isHuman) {
    [leftPlayer, rightPlayer] = [rightPlayer, leftPlayer];
  }

  activeMatch = {
    left: leftPlayer,
    right: rightPlayer,
  };

  aiRefreshTimer = 0;
  aiTargetY = rightY;

  const isFinal = tournament && tournament.currentRound === tournament.rounds.length - 1;
  matchTarget = isFinal ? FINAL_MATCH_POINTS : MATCH_POINTS;

  scoreLeft = 0;
  scoreRight = 0;
  scoreLeftEl.textContent = "0";
  scoreRightEl.textContent = "0";

  if (leftPlayer?.tokenId !== undefined) {
    leftIdInput.value = leftPlayer.tokenId;
    loadNoPunk(leftPlayer.tokenId, "left");
  }

  if (rightPlayer?.tokenId !== undefined) {
    rightIdInput.value = rightPlayer.tokenId;
    loadNoPunk(rightPlayer.tokenId, "right");
  }

  resetBall(false);
}

function resetBall(toLeft = false) {
  ballX = GAME_WIDTH / 2;
  ballY = GAME_HEIGHT / 2;
  const dir = toLeft ? -1 : 1;
  ballVX = BALL_SPEED * dir;
  // small random angle
  ballVY = (Math.random() * 2 - 1) * BALL_SPEED * 0.6;
}

function shortAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function handleWalletUpdate(address, chainId) {
  if (!address) {
    currentWallet = null;
    walletAddressEl.textContent = "NOT CONNECTED";
    walletNetworkEl.textContent = "";
    renderLeaderboard();
    renderOnlineList();
    return;
  }

  currentWallet = address;
  walletAddressEl.textContent = shortAddress(address);

  if (chainId !== null && chainId !== undefined) {
    const chainIdNum = Number(chainId);
    if (chainIdNum === BASE_CHAIN_ID) {
      walletNetworkEl.textContent = "BASE MAINNET";
      if (window.ethereum && typeof ethers !== "undefined") {
        provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = provider.getSigner();
        noPunksContract = new ethers.Contract(NOPUNKS_CONTRACT, ERC721_ABI, provider);
        const tokens = await fetchOwnedNoPunks(currentWallet);
        populateNFTDropdowns(tokens);
      }
    } else {
      walletNetworkEl.textContent = `CHAIN ${chainIdNum} - SWITCH TO BASE`;
      selectLeftBtn.textContent = "MANUAL ID ONLY";
      selectRightBtn.textContent = "MANUAL ID ONLY";
      selectLeftBtn.disabled = true;
      selectRightBtn.disabled = true;
    }
  }

  ensureStats(currentWallet);
  renderLeaderboard();
  setSelfOnline(currentWallet);
}

window.noPingPongSetWallet = handleWalletUpdate;

function ensureStats(addr) {
  if (!sessionStats[addr]) {
    sessionStats[addr] = { pointsFor: 0, pointsAgainst: 0 };
  }
  return sessionStats[addr];
}

function recordPoint(playerScored) {
  if (!currentWallet) return;
  const stats = ensureStats(currentWallet);
  if (playerScored) {
    stats.pointsFor += 1;
  } else {
    stats.pointsAgainst += 1;
  }
  renderLeaderboard();
}

function concludeMatch(leftWon) {
  if (tournament && tournament.status === "in-progress" && activeMatch) {
    const match = tournament.rounds[tournament.currentRound][tournament.currentMatch];
    match.winner = leftWon ? activeMatch.left : activeMatch.right;
    saveTournament();
    renderTournament();
    advanceTournament();
    return;
  }

  scoreLeft = 0;
  scoreRight = 0;
  scoreLeftEl.textContent = "0";
  scoreRightEl.textContent = "0";
  matchTarget = MATCH_POINTS;
  resetBall(Math.random() > 0.5);
}

function checkMatchEnd() {
  if (scoreLeft >= matchTarget || scoreRight >= matchTarget) {
    const leftWon = scoreLeft > scoreRight;
    concludeMatch(leftWon);
  }
}

// --- Online players (front-end only for now) --------------------

function setSelfOnline(addr) {
  if (!addr) return;

  // Check if already in list
  const existingIndex = onlinePlayers.findIndex(
    (p) => p.address.toLowerCase() === addr.toLowerCase()
  );
  if (existingIndex >= 0) {
    onlinePlayers[existingIndex].status = "Online";
  } else {
    onlinePlayers.push({ address: addr, status: "Online" });
  }

  renderOnlineList();
}

function invitePlayer(address) {
  if (!currentWallet) {
    alert("Connect your wallet before sending invites.");
    return;
  }
  if (address.toLowerCase() === currentWallet.toLowerCase()) {
    alert("You can’t invite yourself.");
    return;
  }

  // Stub: this is where you’d call a backend or Base mini-app API
  alert(
    `Invite sent to ${shortAddress(
      address
    )} (stub only – hook this into Base infra later).`
  );
}

function renderOnlineList() {
  onlineBody.innerHTML = "";

  if (!onlinePlayers.length) {
    const row = document.createElement("tr");
    row.className = "placeholder";
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "No other players online yet.";
    row.appendChild(cell);
    onlineBody.appendChild(row);
    return;
  }

  onlinePlayers.forEach((p) => {
    const row = document.createElement("tr");

    const tdPlayer = document.createElement("td");
    tdPlayer.textContent =
      currentWallet &&
      p.address.toLowerCase() === currentWallet.toLowerCase()
        ? `${shortAddress(p.address)} (you)`
        : shortAddress(p.address);

    const tdStatus = document.createElement("td");
    tdStatus.textContent = p.status || "Online";

    const tdInvite = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "Invite";

    // Disable invite button for self
    if (
      currentWallet &&
      p.address.toLowerCase() === currentWallet.toLowerCase()
    ) {
      btn.disabled = true;
      btn.style.opacity = "0.5";
    } else {
      btn.addEventListener("click", () => invitePlayer(p.address));
    }

    tdInvite.appendChild(btn);

    row.appendChild(tdPlayer);
    row.appendChild(tdStatus);
    row.appendChild(tdInvite);

    onlineBody.appendChild(row);
  });
}

// --- Leaderboard render ----------------------------------------

function renderLeaderboard() {
  const entries = Object.entries(sessionStats);
  leaderboardBody.innerHTML = "";

  if (entries.length === 0) {
    const row = document.createElement("tr");
    row.className = "placeholder";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "Connect your wallet and start scoring to appear here.";
    row.appendChild(cell);
    leaderboardBody.appendChild(row);
    return;
  }

  entries
    .sort(([, a], [, b]) => {
      const diffA = a.pointsFor - a.pointsAgainst;
      const diffB = b.pointsFor - b.pointsAgainst;
      return diffB - diffA;
    })
    .forEach(([address, stats]) => {
      const row = document.createElement("tr");
      if (currentWallet && address.toLowerCase() === currentWallet.toLowerCase()) {
        row.classList.add("highlight");
      }

      const diff = stats.pointsFor - stats.pointsAgainst;

      const tdPlayer = document.createElement("td");
      tdPlayer.textContent = shortAddress(address);

      const tdFor = document.createElement("td");
      tdFor.textContent = String(stats.pointsFor);

      const tdAgainst = document.createElement("td");
      tdAgainst.textContent = String(stats.pointsAgainst);

      const tdDiff = document.createElement("td");
      tdDiff.textContent = diff > 0 ? `+${diff}` : String(diff);

      row.appendChild(tdPlayer);
      row.appendChild(tdFor);
      row.appendChild(tdAgainst);
      row.appendChild(tdDiff);
      leaderboardBody.appendChild(row);
    });
}

// --- NFT Fetching -----------------------------------------------

async function fetchOwnedNoPunks(walletAddress) {
  if (!noPunksContract || !walletAddress) return [];

  try {
    enumerationSupported = true;
    const balance = await noPunksContract.balanceOf(walletAddress);
    const balanceNum = balance.toNumber();

    const tokens = [];
    for (let i = 0; i < balanceNum; i++) {
      try {
        const tokenId = await noPunksContract.tokenOfOwnerByIndex(walletAddress, i);
        const tokenIdNum = tokenId.toNumber();
        // Only include tokens 0-9999
        if (tokenIdNum >= 0 && tokenIdNum <= MAX_TOKEN_ID) {
          tokens.push(tokenIdNum);
        }
      } catch (e) {
        console.warn(`Failed to fetch token at index ${i}:`, e);
        enumerationSupported = false;
        return [];
      }
    }

    return tokens.sort((a, b) => a - b);
  } catch (err) {
    console.error("Failed to fetch owned NoPunks:", err);
    return [];
  }
}

function populateNFTDropdowns(tokenIds) {
  ownedNoPunks = tokenIds;

  // Clear and populate left dropdown
  leftNftDropdown.innerHTML = '<option value="">-- SELECT NOPUNK --</option>';
  tokenIds.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `NOPUNK #${id}`;
    leftNftDropdown.appendChild(option);
  });

  // Clear and populate right dropdown
  rightNftDropdown.innerHTML = '<option value="">-- SELECT NOPUNK --</option>';
  tokenIds.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `NOPUNK #${id}`;
    rightNftDropdown.appendChild(option);
  });

  // Show dropdowns and update button text
  if (!enumerationSupported) {
    leftNftDropdown.style.display = 'none';
    rightNftDropdown.style.display = 'none';
    selectLeftBtn.textContent = "MANUAL ID ONLY";
    selectRightBtn.textContent = "MANUAL ID ONLY";
    selectLeftBtn.disabled = true;
    selectRightBtn.disabled = true;
    return;
  }

  if (tokenIds.length > 0) {
    leftNftDropdown.style.display = 'block';
    rightNftDropdown.style.display = 'block';
    selectLeftBtn.textContent = `${tokenIds.length} NOPUNKS OWNED`;
    selectRightBtn.textContent = `${tokenIds.length} NOPUNKS OWNED`;
    selectLeftBtn.disabled = false;
    selectRightBtn.disabled = false;
    selectLeftBtn.style.opacity = '1';
    selectRightBtn.style.opacity = '1';
  } else {
    selectLeftBtn.textContent = "NO NOPUNKS FOUND";
    selectRightBtn.textContent = "NO NOPUNKS FOUND";
    selectLeftBtn.disabled = true;
    selectRightBtn.disabled = true;
  }
}

// --- Wallet connect (Base-aware with ethers.js) -----------------

async function connectWallet() {
  if (!window.ethereum) {
    alert("No wallet detected. Please install MetaMask, Coinbase Wallet, or another Web3 wallet.");
    return;
  }

  // Check if ethers is loaded
  if (typeof ethers === 'undefined') {
    alert("Ethers.js library not loaded. Please refresh the page.");
    return;
  }

  try {
    if (connectBtn) {
      connectBtn.textContent = "CONNECTING...";
      connectBtn.disabled = true;
    }

    // Request accounts using window.ethereum directly
    const accounts = await window.ethereum.request({
      method: 'eth_requestAccounts'
    });

    if (!accounts || accounts.length === 0) {
      throw new Error("No accounts found");
    }

    currentWallet = accounts[0];
    walletAddressEl.textContent = shortAddress(currentWallet);
    if (connectBtn) {
      connectBtn.textContent = "CONNECTED";
    }

    // Initialize ethers provider
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = provider.getSigner();

    // Check network
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    const chainIdNum = parseInt(chainId, 16);

    if (chainIdNum === BASE_CHAIN_ID) {
      walletNetworkEl.textContent = "BASE MAINNET";

      // Initialize contract
      noPunksContract = new ethers.Contract(NOPUNKS_CONTRACT, ERC721_ABI, provider);

      // Fetch owned NoPunks
      try {
        if (connectBtn) {
          connectBtn.textContent = "LOADING NFTs...";
        }
        const tokens = await fetchOwnedNoPunks(currentWallet);
        populateNFTDropdowns(tokens);
        if (connectBtn) {
          connectBtn.textContent = "CONNECTED";
        }
      } catch (nftErr) {
        console.error("Failed to fetch NFTs:", nftErr);
        walletNetworkEl.textContent = "BASE - NFT FETCH FAILED";
        // Still allow manual input even if NFT fetch fails
        selectLeftBtn.textContent = "NFT Fetch Failed";
        selectRightBtn.textContent = "NFT Fetch Failed";
      }

    } else {
      walletNetworkEl.textContent = `CHAIN ${chainIdNum} - SWITCH TO BASE`;
      selectLeftBtn.textContent = "MANUAL ID ONLY";
      selectRightBtn.textContent = "MANUAL ID ONLY";
      selectLeftBtn.disabled = true;
      selectRightBtn.disabled = true;
    }

    // Ensure we have stats + online presence
    ensureStats(currentWallet);
    renderLeaderboard();
    setSelfOnline(currentWallet);

    if (connectBtn) {
      connectBtn.disabled = false;
    }

  } catch (err) {
    console.error("Wallet connection failed:", err);
    if (connectBtn) {
      connectBtn.textContent = "CONNECTION FAILED";
      connectBtn.disabled = false;
    }

    if (connectBtn) {
      setTimeout(() => {
        connectBtn.textContent = "CONNECT WALLET";
      }, 3000);
    }

    if (err.code === 4001) {
      alert("Connection rejected. Please try again.");
    } else {
      alert("Failed to connect wallet: " + err.message);
    }
  }
}

// Handle network changes
if (window.ethereum) {
  window.ethereum.on('chainChanged', () => {
    window.location.reload();
  });

  window.ethereum.on('accountsChanged', (accounts) => {
    if (accounts.length === 0) {
      window.location.reload();
    } else {
      window.location.reload();
    }
  });
}

// --- Input ------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (e.key in keys) {
    keys[e.key] = true;
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key in keys) {
    keys[e.key] = false;
  }
});

// --- Multiplayer Mode -------------------------------------------

function startPracticeMode() {
  gameMode = 'practice';
  multiplayerMatchId = null;
  scoreLeft = 0;
  scoreRight = 0;
  scoreLeftEl.textContent = "0";
  scoreRightEl.textContent = "0";
  matchTarget = MATCH_POINTS;
  resetBall(false);
  setControlsLocked(false);

  // Show game canvas, hide wager UI
  if (gameCanvas) gameCanvas.style.display = 'block';
}

function startMultiplayerGame(data) {
  gameMode = 'multiplayer';
  isMultiplayerPlayer1 = data.isPlayer1;
  multiplayerMatchId = data.matchId;

  // Reset game state
  scoreLeft = 0;
  scoreRight = 0;
  scoreLeftEl.textContent = "0";
  scoreRightEl.textContent = "0";
  matchTarget = 5; // Wager matches are first to 5

  // Reset positions
  leftY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;
  rightY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;

  // Load opponent's NFT if provided
  if (data.opponentNftId !== undefined) {
    if (isMultiplayerPlayer1) {
      loadNoPunk(data.opponentNftId, "right");
    } else {
      loadNoPunk(data.opponentNftId, "left");
    }
  }

  // Lock controls during multiplayer
  setControlsLocked(true);

  // Show game canvas
  if (gameCanvas) gameCanvas.style.display = 'block';

  // Set up multiplayer event handlers
  setupMultiplayerHandlers();
}

function setupMultiplayerHandlers() {
  if (typeof Multiplayer === 'undefined') return;

  // Handle ball updates from server
  Multiplayer.on('ballUpdate', (state) => {
    ballX = state.x;
    ballY = state.y;
    ballVX = state.vx;
    ballVY = state.vy;
  });

  // Handle opponent paddle updates
  Multiplayer.on('opponentPaddle', (y) => {
    if (isMultiplayerPlayer1) {
      // We're player 1 (left), opponent is player 2 (right)
      rightY = y;
    } else {
      // We're player 2 (right), opponent is player 1 (left)
      leftY = y;
    }
  });

  // Handle score updates from server
  Multiplayer.on('scoreUpdate', (p1Score, p2Score) => {
    scoreLeft = p1Score;
    scoreRight = p2Score;
    scoreLeftEl.textContent = String(p1Score);
    scoreRightEl.textContent = String(p2Score);

    // Update wager UI if available
    if (typeof WagerUI !== 'undefined') {
      if (isMultiplayerPlayer1) {
        WagerUI.updateIngameDisplay(p1Score, p2Score);
      } else {
        WagerUI.updateIngameDisplay(p2Score, p1Score);
      }
    }
  });

  // Handle game end
  Multiplayer.on('gameEnd', (winner, matchId) => {
    gameMode = 'practice';
    multiplayerMatchId = null;
    setControlsLocked(false);
  });
}

function updateMultiplayer(deltaMs) {
  const delta = Math.min(MAX_DELTA, deltaMs || FRAME_MS);
  const step = delta / FRAME_MS;

  // Only control our own paddle
  if (isMultiplayerPlayer1) {
    // We control left paddle
    if (keys.w) leftY -= PADDLE_SPEED * step;
    if (keys.s) leftY += PADDLE_SPEED * step;
    leftY = clamp(leftY, TABLE_TOP, TABLE_BOTTOM - PADDLE_HEIGHT);

    // Send our paddle position to server
    if (typeof Multiplayer !== 'undefined') {
      Multiplayer.sendPaddle(leftY);
    }
  } else {
    // We control right paddle
    if (keys.w) rightY -= PADDLE_SPEED * step;
    if (keys.s) rightY += PADDLE_SPEED * step;
    rightY = clamp(rightY, TABLE_TOP, TABLE_BOTTOM - PADDLE_HEIGHT);

    // Send our paddle position to server
    if (typeof Multiplayer !== 'undefined') {
      Multiplayer.sendPaddle(rightY);
    }
  }

  // Ball physics are handled by server - we just render the received state
  // No local ball physics in multiplayer mode
}

// Expose functions for wager UI
window.startPracticeMode = startPracticeMode;
window.startMultiplayerGame = startMultiplayerGame;
window.leftNftId = leftNftId;

// --- Game loop --------------------------------------------------

function update(deltaMs) {
  const delta = Math.min(MAX_DELTA, deltaMs || FRAME_MS);
  const step = delta / FRAME_MS;
  // Human paddle (left) with W/S
  if (keys.w) leftY -= PADDLE_SPEED * step;
  if (keys.s) leftY += PADDLE_SPEED * step;

  // Clamp to table bounds
  leftY = clamp(leftY, TABLE_TOP, TABLE_BOTTOM - PADDLE_HEIGHT);

  // CPU paddle (right) AI - Fair 50/50 pacing
  aiRefreshTimer += delta;
  if (aiRefreshTimer >= AI_TARGET_REFRESH_MS) {
    const noise = (Math.random() * 2 - 1) * AI_NOISE;
    aiTargetY = ballY - PADDLE_HEIGHT / 2 + noise;
    aiRefreshTimer = 0;
  }

  const diff = aiTargetY - rightY;
  rightY += clamp(diff, -PADDLE_SPEED * step, PADDLE_SPEED * step);

  rightY = clamp(rightY, TABLE_TOP, TABLE_BOTTOM - PADDLE_HEIGHT);

  // Move ball
  ballX += ballVX * step;
  ballY += ballVY * step;

  // Top/bottom collisions (table edges)
  if (
    ballY - BALL_SIZE / 2 <= TABLE_TOP ||
    ballY + BALL_SIZE / 2 >= TABLE_BOTTOM
  ) {
    ballVY *= -1;
    ballY = clamp(
      ballY,
      TABLE_TOP + BALL_SIZE / 2,
      TABLE_BOTTOM - BALL_SIZE / 2
    );
  }

  // Left paddle collision
  const leftPaddleX = PADDLE_MARGIN;
  if (
    ballX - BALL_SIZE / 2 <= leftPaddleX + PADDLE_WIDTH &&
    ballX + BALL_SIZE / 2 >= leftPaddleX &&
    ballY >= leftY &&
    ballY <= leftY + PADDLE_HEIGHT
  ) {
    ballVX = Math.abs(ballVX); // go right
    const relative = (ballY - (leftY + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2);
    ballVY = relative * BALL_SPEED * 1.1;
    ballX = leftPaddleX + PADDLE_WIDTH + BALL_SIZE / 2;
  }

  // Right paddle collision
  const rightPaddleX = GAME_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH;
  if (
    ballX + BALL_SIZE / 2 >= rightPaddleX &&
    ballX - BALL_SIZE / 2 <= rightPaddleX + PADDLE_WIDTH &&
    ballY >= rightY &&
    ballY <= rightY + PADDLE_HEIGHT
  ) {
    ballVX = -Math.abs(ballVX); // go left
    const relative =
      (ballY - (rightY + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2);
    ballVY = relative * BALL_SPEED * 1.1;
    ballX = rightPaddleX - BALL_SIZE / 2;
  }

  // Score (off-screen left/right)
  if (ballX < -40) {
    // CPU scores
    scoreRight++;
    scoreRightEl.textContent = String(scoreRight);
    recordPoint(false);
    if (scoreRight >= matchTarget) {
      checkMatchEnd();
      return;
    }
    resetBall(false);
  } else if (ballX > GAME_WIDTH + 40) {
    // Player scores
    scoreLeft++;
    scoreLeftEl.textContent = String(scoreLeft);
    recordPoint(true);
    if (scoreLeft >= matchTarget) {
      checkMatchEnd();
      return;
    }
    resetBall(true);
  }
}

function draw() {
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  // Table surface - pure black
  const tableWidth = TABLE_RIGHT - TABLE_LEFT;
  const tableHeight = TABLE_BOTTOM - TABLE_TOP;

  ctx.fillStyle = "#000";
  ctx.fillRect(TABLE_LEFT, TABLE_TOP, tableWidth, tableHeight);

  // Outer table outline - classic white
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    TABLE_LEFT + 0.5,
    TABLE_TOP + 0.5,
    tableWidth - 1,
    tableHeight - 1
  );

  // Slight inner line
  ctx.strokeStyle = "#888888";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    TABLE_LEFT + 4.5,
    TABLE_TOP + 4.5,
    tableWidth - 9,
    tableHeight - 9
  );

  // Centre "net" line inside the table
  ctx.strokeStyle = "#888888";
  ctx.lineWidth = 2;
  const dashHeight = 14;
  const gap = 8;
  const centerX = Math.round(GAME_WIDTH / 2) + 0.5;
  for (
    let y = TABLE_TOP + 4;
    y <= TABLE_BOTTOM - 4 - dashHeight;
    y += dashHeight + gap
  ) {
    ctx.beginPath();
    ctx.moveTo(centerX, y);
    ctx.lineTo(centerX, y + dashHeight);
    ctx.stroke();
  }

  // Left paddle (human) - with collision box for NoPunk sprite
  const leftX = PADDLE_MARGIN;

  // Draw invisible collision box for debugging (optional)
  // ctx.strokeStyle = "rgba(255,255,255,0.1)";
  // ctx.strokeRect(leftX, leftY, PADDLE_WIDTH, PADDLE_HEIGHT);

  if (leftSprite) {
    // Fit sprite within paddle bounds (max 60px)
    const maxSize = 60;
    const spriteRatio = leftSprite.width / leftSprite.height;
    let w, h;
    if (spriteRatio > 1) {
      w = maxSize;
      h = maxSize / spriteRatio;
    } else {
      h = maxSize;
      w = maxSize * spriteRatio;
    }
    const cx = leftX + PADDLE_WIDTH / 2;
    const cy = leftY + PADDLE_HEIGHT / 2;
    ctx.drawImage(
      leftSprite,
      0,
      0,
      leftSprite.width,
      leftSprite.height,
      Math.round(cx - w / 2),
      Math.round(cy - h / 2),
      w,
      h
    );
  }

  // Right paddle (CPU) - with collision box for NoPunk sprite
  const rightX = GAME_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH;

  // Draw invisible collision box for debugging (optional)
  // ctx.strokeStyle = "rgba(255,255,255,0.1)";
  // ctx.strokeRect(rightX, rightY, PADDLE_WIDTH, PADDLE_HEIGHT);

  if (rightSprite) {
    // Fit sprite within paddle bounds (max 60px)
    const maxSize = 60;
    const spriteRatio = rightSprite.width / rightSprite.height;
    let w, h;
    if (spriteRatio > 1) {
      w = maxSize;
      h = maxSize / spriteRatio;
    } else {
      h = maxSize;
      w = maxSize * spriteRatio;
    }
    const cx = rightX + PADDLE_WIDTH / 2;
    const cy = rightY + PADDLE_HEIGHT / 2;
    ctx.drawImage(
      rightSprite,
      0,
      0,
      rightSprite.width,
      rightSprite.height,
      Math.round(cx - w / 2),
      Math.round(cy - h / 2),
      w,
      h
    );
  }

  // Ball - classic white
  ctx.fillStyle = BASE_BLUE;
  ctx.shadowBlur = 0;
  ctx.fillRect(
    Math.round(ballX - BALL_SIZE / 2),
    Math.round(ballY - BALL_SIZE / 2),
    BALL_SIZE,
    BALL_SIZE
  );
}

function loop(now) {
  const delta = now - lastFrameTime;
  lastFrameTime = now;

  // Use appropriate update function based on game mode
  if (gameMode === 'multiplayer') {
    updateMultiplayer(delta);
  } else {
    update(delta);
  }

  draw();
  requestAnimationFrame(loop);
}

// --- UI hooks ---------------------------------------------------

function clampId(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.min(9999, Math.max(0, Math.floor(n)));
}

leftIdInput.addEventListener("change", () => {
  const id = clampId(leftIdInput.value);
  leftIdInput.value = id;
  leftNftId = id;
  window.leftNftId = id;
  loadNoPunk(id, "left");
});

rightIdInput.addEventListener("change", () => {
  const id = clampId(rightIdInput.value);
  rightIdInput.value = id;
  loadNoPunk(id, "right");
});

randomizeBtn.addEventListener("click", () => {
  const leftId = Math.floor(Math.random() * 10000);
  let rightId = Math.floor(Math.random() * 10000);
  if (rightId === leftId) rightId = (rightId + 1) % 10000;
  leftIdInput.value = leftId;
  rightIdInput.value = rightId;
  loadNoPunk(leftId, "left");
  loadNoPunk(rightId, "right");
});

resetBtn.addEventListener("click", () => {
  if (tournament && tournament.status === "in-progress" && activeMatch) {
    startMatch(activeMatch.left, activeMatch.right);
    return;
  }

  scoreLeft = 0;
  scoreRight = 0;
  scoreLeftEl.textContent = "0";
  scoreRightEl.textContent = "0";
  leftY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;
  rightY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;
  resetBall(Math.random() > 0.5);
});

if (connectBtn) {
  connectBtn.addEventListener("click", () => {
    connectWallet();
  });
}

if (startTournamentBtn) {
  startTournamentBtn.addEventListener("click", () => {
    startTournament();
  });
}

if (resetTournamentBtn) {
  resetTournamentBtn.addEventListener("click", () => {
    resetTournament();
  });
}

if (setPrizeBtn) {
  setPrizeBtn.addEventListener("click", () => {
    promptPrize();
  });
}

// NFT selection handlers
selectLeftBtn.addEventListener("click", () => {
  if (leftNftDropdown.style.display === 'none') {
    leftNftDropdown.style.display = 'block';
  }
  leftNftDropdown.focus();
});

selectRightBtn.addEventListener("click", () => {
  if (rightNftDropdown.style.display === 'none') {
    rightNftDropdown.style.display = 'block';
  }
  rightNftDropdown.focus();
});

leftNftDropdown.addEventListener("change", (e) => {
  const tokenId = e.target.value;
  if (tokenId) {
    leftIdInput.value = tokenId;
    leftNftId = parseInt(tokenId);
    window.leftNftId = leftNftId;
    loadNoPunk(parseInt(tokenId), "left");
  }
});

rightNftDropdown.addEventListener("change", (e) => {
  const tokenId = e.target.value;
  if (tokenId) {
    rightIdInput.value = tokenId;
    loadNoPunk(parseInt(tokenId), "right");
  }
});

// --- Boot -------------------------------------------------------

async function initMiniAppSdk() {
  try {
    const { sdk } = await import("https://esm.sh/@farcaster/miniapp-sdk");
    window.miniappSdk = sdk;
    await sdk.actions.ready();
  } catch (err) {
    console.info("MiniApp SDK not available.");
  }
}

function init() {
  // initial sprites
  loadNoPunk(clampId(leftIdInput.value), "left");
  loadNoPunk(clampId(rightIdInput.value), "right");
  resetBall(false);
  renderLeaderboard();
  renderOnlineList();
  loadPrizeConfig();
  loadTournament();
  initMiniAppSdk();
  lastFrameTime = performance.now();
  requestAnimationFrame(loop);
}

init();
