// --- Game/layout constants -------------------------------------

const GAME_WIDTH = 800;
const GAME_HEIGHT = 400;

// Inner "table" bounds (inside the canvas)
const TABLE_TOP = 40;
const TABLE_BOTTOM = GAME_HEIGHT - 40;
const TABLE_LEFT = 40;
const TABLE_RIGHT = GAME_WIDTH - 40;

const BALL_SIZE = 14;
const BALL_SPEED = 4.5;
const PADDLE_HEIGHT = 100;
const PADDLE_WIDTH = 14;
// paddles sit just inside the table edges
const PADDLE_MARGIN = TABLE_LEFT + 8;
const PADDLE_SPEED = 6;
const BASE_BLUE = "#0052ff"; // Base blue square

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

// Keyboard: human on left (W/S)
const keys = {
  w: false,
  s: false,
};

// Wallet + session leaderboard
let currentWallet = null;
const sessionStats = {}; // address -> { pointsFor, pointsAgainst }

// Players online (front-end only for now)
let onlinePlayers = []; // { address, status }

// --- Helpers ----------------------------------------------------

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function loadNoPunk(id, side) {
  const img = new Image();
  img.src = `./${id}.png`; // images sit next to index.html
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

// --- Wallet connect (Base-aware, local only for now) ------------

async function connectWallet() {
  if (!window.ethereum) {
    alert("No wallet detected. Install Coinbase Wallet, MetaMask, or a Base-compatible wallet.");
    return;
  }

  try {
    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    if (!accounts || !accounts.length) return;

    currentWallet = accounts[0];
    walletAddressEl.textContent = shortAddress(currentWallet);
    connectBtn.textContent = "Connected";

    // Check network
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    const isBaseMainnet = chainId === "0x2105"; // Base mainnet
    const isBaseSepolia = chainId === "0x14a33"; // Base Sepolia (testnet)

    if (isBaseMainnet) {
      walletNetworkEl.textContent = "Connected · Base Mainnet";
    } else if (isBaseSepolia) {
      walletNetworkEl.textContent = "Connected · Base Sepolia";
    } else {
      walletNetworkEl.textContent = `Connected · Chain ${chainId} (switch to Base for prizes later)`;
    }

    // Ensure we have stats + online presence
    ensureStats(currentWallet);
    renderLeaderboard();
    setSelfOnline(currentWallet);
  } catch (err) {
    console.error("Wallet connection failed", err);
  }
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

// --- Game loop --------------------------------------------------

function update() {
  // Human paddle (left) with W/S
  if (keys.w) leftY -= PADDLE_SPEED;
  if (keys.s) leftY += PADDLE_SPEED;

  // Clamp to table bounds
  leftY = clamp(leftY, TABLE_TOP, TABLE_BOTTOM - PADDLE_HEIGHT);

  // CPU paddle (right) AI
  const aiMaxSpeed = PADDLE_SPEED * 0.85;

  if (ballVX > 0) {
    // Ball travelling towards CPU -> track y
    const targetY = ballY - PADDLE_HEIGHT / 2;
    const diff = targetY - rightY;
    if (Math.abs(diff) > 1) {
      rightY += clamp(diff, -aiMaxSpeed, aiMaxSpeed);
    }
  } else {
    // Ball travelling away -> drift back to centre
    const centreY = (TABLE_TOP + TABLE_BOTTOM - PADDLE_HEIGHT) / 2;
    const centreDiff = centreY - rightY;
    rightY += clamp(centreDiff, -PADDLE_SPEED * 0.4, PADDLE_SPEED * 0.4);
  }

  rightY = clamp(rightY, TABLE_TOP, TABLE_BOTTOM - PADDLE_HEIGHT);

  // Move ball
  ballX += ballVX;
  ballY += ballVY;

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
    resetBall(false);
  } else if (ballX > GAME_WIDTH + 40) {
    // Player scores
    scoreLeft++;
    scoreLeftEl.textContent = String(scoreLeft);
    recordPoint(true);
    resetBall(true);
  }
}

function draw() {
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  // Table surface
  const tableWidth = TABLE_RIGHT - TABLE_LEFT;
  const tableHeight = TABLE_BOTTOM - TABLE_TOP;

  ctx.fillStyle = "#020202";
  ctx.fillRect(TABLE_LEFT, TABLE_TOP, tableWidth, tableHeight);

  // Outer table outline
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 3;
  ctx.strokeRect(
    TABLE_LEFT + 0.5,
    TABLE_TOP + 0.5,
    tableWidth - 1,
    tableHeight - 1
  );

  // Slight inner glow line
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    TABLE_LEFT + 6.5,
    TABLE_TOP + 6.5,
    tableWidth - 13,
    tableHeight - 13
  );

  // Centre "net" line inside the table
  ctx.strokeStyle = "#303030";
  ctx.lineWidth = 2;
  const dashHeight = 14;
  const gap = 8;
  for (let y = TABLE_TOP + 4; y < TABLE_BOTTOM - 4; y += dashHeight + gap) {
    ctx.beginPath();
    ctx.moveTo(GAME_WIDTH / 2, y);
    ctx.lineTo(GAME_WIDTH / 2, y + dashHeight);
    ctx.stroke();
  }

  // Left paddle (human)
  ctx.fillStyle = "#040404";
  const leftX = PADDLE_MARGIN;
  ctx.fillRect(leftX, leftY, PADDLE_WIDTH, PADDLE_HEIGHT);

  if (leftSprite) {
    const scale = 3.5;
    const w = leftSprite.width * scale;
    const h = leftSprite.height * scale;
    const cx = leftX + PADDLE_WIDTH / 2;
    const cy = leftY + PADDLE_HEIGHT / 2;
    ctx.drawImage(
      leftSprite,
      0,
      0,
      leftSprite.width,
      leftSprite.height,
      cx - w / 2,
      cy - h / 2,
      w,
      h
    );
  }

  // Right paddle (CPU)
  const rightX = GAME_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH;
  ctx.fillRect(rightX, rightY, PADDLE_WIDTH, PADDLE_HEIGHT);

  if (rightSprite) {
    const scale = 3.5;
    const w = rightSprite.width * scale;
    const h = rightSprite.height * scale;
    const cx = rightX + PADDLE_WIDTH / 2;
    const cy = rightY + PADDLE_HEIGHT / 2;
    ctx.drawImage(
      rightSprite,
      0,
      0,
      rightSprite.width,
      rightSprite.height,
      cx - w / 2,
      cy - h / 2,
      w,
      h
    );
  }

  // Ball
  ctx.fillStyle = BASE_BLUE;
  ctx.fillRect(
    ballX - BALL_SIZE / 2,
    ballY - BALL_SIZE / 2,
    BALL_SIZE,
    BALL_SIZE
  );
}

function loop() {
  update();
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
  scoreLeft = 0;
  scoreRight = 0;
  scoreLeftEl.textContent = "0";
  scoreRightEl.textContent = "0";
  leftY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;
  rightY = (TABLE_BOTTOM + TABLE_TOP - PADDLE_HEIGHT) / 2;
  resetBall(Math.random() > 0.5);
});

connectBtn.addEventListener("click", () => {
  connectWallet();
});

// --- Boot -------------------------------------------------------

function init() {
  // initial sprites
  loadNoPunk(clampId(leftIdInput.value), "left");
  loadNoPunk(clampId(rightIdInput.value), "right");
  resetBall(false);
  renderLeaderboard();
  renderOnlineList();
  loop();
}

init();