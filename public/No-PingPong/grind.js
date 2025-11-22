// public/No-PingPong/grind.js
//
// NO-PINGPONG game logic
// - Paddles are pure NoPunks (no blue rectangle behind)
// - Bigger paddles on desktop, slightly smaller on mobile
// - CPU is beatable (slight lag & speed cap)
// - Uses images from /No-PingPong/{id}.png

(function () {
  'use strict';

  // =========================
  // CONSTANTS
  // =========================
  const GAME_WIDTH = 800;
  const GAME_HEIGHT = 400;

  const TABLE_MARGIN = 40;
  const TABLE_TOP = TABLE_MARGIN;
  const TABLE_BOTTOM = GAME_HEIGHT - TABLE_MARGIN;
  const TABLE_LEFT = TABLE_MARGIN;
  const TABLE_RIGHT = GAME_WIDTH - TABLE_MARGIN;
  const TABLE_HEIGHT = TABLE_BOTTOM - TABLE_TOP;

  const BALL_SIZE = 8;
  const BASE_BALL_SPEED = 4;

  // paddle image size (square) – desktop vs mobile
  const PUNK_DESKTOP = 80;
  const PUNK_MOBILE = 56;

  function getPunkSize() {
    return window.innerWidth <= 768 ? PUNK_MOBILE : PUNK_DESKTOP;
  }

  let PUNK_SIZE = getPunkSize();

  const CPU_LAG_FRAMES = 1;     // reacts every frame, like classic Pong
  const PLAYER_SPEED = 7;       // human + CPU paddle speed (equal)

  const BASE_BLUE = '#0052ff';

  // =========================
  // DOM HOOKS
  // =========================
  const canvas = document.getElementById('game');
  if (!canvas) {
    console.warn('No canvas with id="game" found – No-PingPong not initialised.');
    return;
  }
  const ctx = canvas.getContext('2d');

  // Ensure fixed game resolution
  canvas.width = GAME_WIDTH;
  canvas.height = GAME_HEIGHT;

  const leftPreview = document.getElementById('left-preview');
  const rightPreview = document.getElementById('right-preview');

  const leftIdInput = document.getElementById('left-id');
  const rightIdInput = document.getElementById('right-id');

  const randomizeBtn = document.getElementById('randomize');
  const resetBtn = document.getElementById('reset');

  const scoreLeftEl = document.getElementById('score-left');
  const scoreRightEl = document.getElementById('score-right');

  const leaderboardBody = document.getElementById('leaderboard-body');
  const onlineBody = document.getElementById('online-body');

  const walletBtn = document.getElementById('connect-wallet');
  const walletAddressEl = document.getElementById('wallet-address');
  const walletNetworkEl = document.getElementById('wallet-network');

  // =========================
  // IMAGE HELPER
  // =========================
  function loadNoPunkImage(id, callback) {
    const numeric = Number(id);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 9999) {
      callback(null);
      return;
    }

    const img = new Image();
    img.onload = () => callback(img);
    img.onerror = () => callback(null);

    // On Vercel this resolves to /No-PingPong/0.png etc
    img.src = `/No-PingPong/${numeric}.png`;
  }

  function updatePreview(previewCanvas, id) {
    if (!previewCanvas) return;
    const pctx = previewCanvas.getContext('2d');
    pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

    loadNoPunkImage(id, (img) => {
      if (!img) return;

      const size = Math.min(previewCanvas.width, previewCanvas.height);
      const x = (previewCanvas.width - size) / 2;
      const y = (previewCanvas.height - size) / 2;

      pctx.imageSmoothingEnabled = false;
      pctx.drawImage(img, x, y, size, size);
    });
  }

  // =========================
  // PADDLE CLASS (NoPunk)
  // =========================
  class Paddle {
    constructor(side, id) {
      this.side = side; // 'left' | 'right'
      this.id = id;
      this.size = PUNK_SIZE;
      this.width = this.size;
      this.height = this.size;
      this.vy = 0;
      this.image = null;

      this.resetPosition();
      this.loadImage();
    }

    resetPosition() {
      this.size = PUNK_SIZE;
      this.width = this.size;
      this.height = this.size;

      const centerY = TABLE_TOP + (TABLE_HEIGHT - this.size) / 2;

      if (this.side === 'left') {
        this.x = TABLE_LEFT + 24;
      } else {
        this.x = TABLE_RIGHT - 24 - this.size;
      }
      this.y = centerY;
    }

    setId(newId) {
      this.id = newId;
      this.loadImage();
    }

    loadImage() {
      loadNoPunkImage(this.id, (img) => {
        this.image = img;
      });
    }

    update() {
      this.y += this.vy;

      if (this.y < TABLE_TOP) this.y = TABLE_TOP;
      if (this.y + this.height > TABLE_BOTTOM) {
        this.y = TABLE_BOTTOM - this.height;
      }
    }

    draw(ctx) {
      const size = this.size;
      const x = this.x;
      const y = this.y;

      ctx.imageSmoothingEnabled = false;

      if (this.image) {
        // ONLY draw the NoPunk image – no blue box behind
        ctx.drawImage(this.image, x, y, size, size);
      } else {
        // fallback if image missing
        ctx.fillStyle = BASE_BLUE;
        ctx.fillRect(x, y, size, size);
      }
    }

    get rect() {
      return {
        x: this.x,
        y: this.y,
        w: this.width,
        h: this.height,
      };
    }
  }

  // =========================
  // BALL CLASS
  // =========================
  class Ball {
    constructor() {
      this.reset();
    }

    reset(direction = 1) {
      this.x = (TABLE_LEFT + TABLE_RIGHT) / 2;
      this.y = (TABLE_TOP + TABLE_BOTTOM) / 2;

      const angle = Math.random() * 0.6 - 0.3; // -0.3..0.3
      const speed = BASE_BALL_SPEED;

      this.vx = direction * speed;
      this.vy = speed * angle * 2;
    }

    get rect() {
      return {
        x: this.x - BALL_SIZE / 2,
        y: this.y - BALL_SIZE / 2,
        w: BALL_SIZE,
        h: BALL_SIZE,
      };
    }

    update() {
      this.x += this.vx;
      this.y += this.vy;

      // top / bottom bounce within table
      if (this.y - BALL_SIZE / 2 <= TABLE_TOP) {
        this.y = TABLE_TOP + BALL_SIZE / 2;
        this.vy *= -1;
      }
      if (this.y + BALL_SIZE / 2 >= TABLE_BOTTOM) {
        this.y = TABLE_BOTTOM - BALL_SIZE / 2;
        this.vy *= -1;
      }
    }

    draw(ctx) {
      ctx.fillStyle = BASE_BLUE;
      ctx.fillRect(
        this.x - BALL_SIZE / 2,
        this.y - BALL_SIZE / 2,
        BALL_SIZE,
        BALL_SIZE
      );
    }
  }

  // =========================
  // COLLISION
  // =========================
  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  }

  // =========================
  // GAME STATE
  // =========================
  const leftStartId = leftIdInput ? leftIdInput.value || 0 : 0;
  const rightStartId = rightIdInput ? rightIdInput.value || 1 : 1;

  const leftPaddle = new Paddle('left', leftStartId);
  const rightPaddle = new Paddle('right', rightStartId);
  const ball = new Ball();

  let leftScore = 0;
  let rightScore = 0;

  let cpuLagCounter = 0;

  const keys = {
    w: false,
    s: false,
    ArrowUp: false,
    ArrowDown: false,
  };

  // simple session leaderboard + online list (local only)
  const leaderboard = [];
  const onlinePlayers = [];

  let connectedAddress = null;

  // =========================
  // INPUT
  // =========================
  window.addEventListener('keydown', (e) => {
    if (e.key in keys) {
      keys[e.key] = true;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key in keys) {
      keys[e.key] = false;
    }
  });

  if (leftIdInput) {
    leftIdInput.addEventListener('input', () => {
      const id = leftIdInput.value;
      leftPaddle.setId(id);
      updatePreview(leftPreview, id);
    });
  }

  if (rightIdInput) {
    rightIdInput.addEventListener('input', () => {
      const id = rightIdInput.value;
      rightPaddle.setId(id);
      updatePreview(rightPreview, id);
    });
  }

  if (randomizeBtn) {
    randomizeBtn.addEventListener('click', () => {
      const left = Math.floor(Math.random() * 10000);
      let right = Math.floor(Math.random() * 10000);
      if (right === left) {
        right = (right + 1) % 10000;
      }

      if (leftIdInput) leftIdInput.value = left;
      if (rightIdInput) rightIdInput.value = right;

      leftPaddle.setId(left);
      rightPaddle.setId(right);

      updatePreview(leftPreview, left);
      updatePreview(rightPreview, right);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      ball.reset();
      leftPaddle.resetPosition();
      rightPaddle.resetPosition();
    });
  }

  // =========================
  // WALLET (STUB)
  // =========================
  if (walletBtn) {
    walletBtn.addEventListener('click', async () => {
      if (!window.ethereum) {
        alert('No wallet found. Install MetaMask or a Base-compatible wallet.');
        return;
      }

      try {
        const accounts = await window.ethereum.request({
          method: 'eth_requestAccounts',
        });

        if (!accounts || !accounts.length) return;

        connectedAddress = accounts[0];
        if (walletAddressEl) {
          walletAddressEl.textContent =
            connectedAddress.slice(0, 6) + '…' + connectedAddress.slice(-4);
        }
        if (walletNetworkEl) {
          walletNetworkEl.textContent = 'Target: Base';
        }

        upsertOnlinePlayer(connectedAddress, 'Playing');
        renderOnline();
      } catch (err) {
        console.error(err);
        alert('Failed to connect wallet.');
      }
    });
  }

  function upsertOnlinePlayer(address, status) {
    if (!address) return;
    const label = address.slice(0, 6) + '…' + address.slice(-4);
    const existing = onlinePlayers.find((p) => p.address === address);
    if (existing) {
      existing.status = status;
    } else {
      onlinePlayers.push({
        address,
        label,
        status,
      });
    }
  }

  function recordLeaderboardEntry(winnerAddress, diff) {
    if (!winnerAddress) return;

    const label =
      winnerAddress.slice(0, 6) + '…' + winnerAddress.slice(-4);

    const existing = leaderboard.find((row) => row.address === winnerAddress);
    if (existing) {
      existing.pointsFor += diff;
      existing.diff = existing.pointsFor - existing.pointsAgainst;
    } else {
      leaderboard.push({
        address: winnerAddress,
        label,
        pointsFor: diff,
        pointsAgainst: 0,
        diff,
      });
    }

    leaderboard.sort((a, b) => b.diff - a.diff);
  }

  function renderLeaderboard() {
    if (!leaderboardBody) return;
    leaderboardBody.innerHTML = '';

    leaderboard.forEach((row) => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = row.label;

      const pfTd = document.createElement('td');
      pfTd.textContent = row.pointsFor;

      const paTd = document.createElement('td');
      paTd.textContent = row.pointsAgainst || 0;

      const diffTd = document.createElement('td');
      diffTd.textContent = row.diff;

      tr.appendChild(nameTd);
      tr.appendChild(pfTd);
      tr.appendChild(paTd);
      tr.appendChild(diffTd);

      leaderboardBody.appendChild(tr);
    });
  }

  function renderOnline() {
    if (!onlineBody) return;
    onlineBody.innerHTML = '';

    if (!onlinePlayers.length) {
      const tr = document.createElement('tr');
      tr.className = 'online-placeholder';
      const td = document.createElement('td');
      td.colSpan = 3;
      td.textContent = 'No other players online yet.';
      tr.appendChild(td);
      onlineBody.appendChild(tr);
      return;
    }

    onlinePlayers.forEach((p) => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = p.label;

      const statusTd = document.createElement('td');
      statusTd.textContent = p.status;

      const inviteTd = document.createElement('td');
      inviteTd.textContent = 'SOON';
      inviteTd.className = 'invite-pill';

      tr.appendChild(nameTd);
      tr.appendChild(statusTd);
      tr.appendChild(inviteTd);
      onlineBody.appendChild(tr);
    });
  }

  // =========================
  // GAME LOOP
  // =========================
  function updateGame() {
    // Player movement (W/S OR ArrowUp/ArrowDown)
    let playerVy = 0;
    if (keys.w || keys.ArrowUp) playerVy -= PLAYER_SPEED;
    if (keys.s || keys.ArrowDown) playerVy += PLAYER_SPEED;
    leftPaddle.vy = playerVy;
    leftPaddle.update();

    // CPU movement – classic Pong-style: same max speed as player, just chases the ball's Y
    cpuLagCounter++;
    if (cpuLagCounter >= CPU_LAG_FRAMES) {
      cpuLagCounter = 0;

      const paddleCenter = rightPaddle.y + rightPaddle.height / 2;
      const error = ball.y - paddleCenter;

      let dy = 0;
      if (error > 0) {
        dy = Math.min(PLAYER_SPEED, error);
      } else if (error < 0) {
        dy = Math.max(-PLAYER_SPEED, error);
      }

      rightPaddle.y += dy;

      // keep inside bounds
      if (rightPaddle.y < TABLE_TOP) rightPaddle.y = TABLE_TOP;
      if (rightPaddle.y + rightPaddle.height > TABLE_BOTTOM) {
        rightPaddle.y = TABLE_BOTTOM - rightPaddle.height;
      }
    }

    // Ball
    ball.update();

    // Paddle collisions
    if (rectsOverlap(ball.rect, leftPaddle.rect)) {
      ball.x = leftPaddle.rect.x + leftPaddle.rect.w + BALL_SIZE / 2;
      ball.vx = Math.abs(ball.vx) * 1.05;

      const offset =
        (ball.y - (leftPaddle.y + leftPaddle.height / 2)) /
        (leftPaddle.height / 2);
      ball.vy += offset * 2;
    }

    if (rectsOverlap(ball.rect, rightPaddle.rect)) {
      ball.x = rightPaddle.rect.x - BALL_SIZE / 2;
      ball.vx = -Math.abs(ball.vx) * 1.05;

      const offset =
        (ball.y - (rightPaddle.y + rightPaddle.height / 2)) /
        (rightPaddle.height / 2);
      ball.vy += offset * 2;
    }

    // Scoring
    if (ball.x + BALL_SIZE / 2 < TABLE_LEFT) {
      // CPU scores
      rightScore++;
      if (scoreRightEl) scoreRightEl.textContent = rightScore;
      ball.reset(1);
    } else if (ball.x - BALL_SIZE / 2 > TABLE_RIGHT) {
      // Player scores
      leftScore++;
      if (scoreLeftEl) scoreLeftEl.textContent = leftScore;

      if (connectedAddress) {
        recordLeaderboardEntry(connectedAddress, 1);
        renderLeaderboard();
      }

      ball.reset(-1);
    }
  }

  function drawTable() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Outer table
    ctx.strokeStyle = BASE_BLUE;
    ctx.lineWidth = 3;
    ctx.strokeRect(
      TABLE_LEFT,
      TABLE_TOP,
      TABLE_RIGHT - TABLE_LEFT,
      TABLE_BOTTOM - TABLE_TOP
    );

    // Center dashed line
    ctx.setLineDash([8, 12]);
    ctx.beginPath();
    ctx.moveTo((GAME_WIDTH / 2) | 0, TABLE_TOP);
    ctx.lineTo((GAME_WIDTH / 2) | 0, TABLE_BOTTOM);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function render() {
    drawTable();
    ball.draw(ctx);
    leftPaddle.draw(ctx);
    rightPaddle.draw(ctx);
  }

  function loop() {
    updateGame();
    render();
    requestAnimationFrame(loop);
  }

  // =========================
  // RESIZE HANDLING
  // =========================
  function handleResize() {
    const newSize = getPunkSize();
    if (newSize !== PUNK_SIZE) {
      PUNK_SIZE = newSize;
      leftPaddle.resetPosition();
      rightPaddle.resetPosition();
    }
  }

  window.addEventListener('resize', handleResize);

  // =========================
  // INITIALISE
  // =========================
  updatePreview(leftPreview, leftStartId);
  updatePreview(rightPreview, rightStartId);

  renderOnline();
  renderLeaderboard();

  requestAnimationFrame(loop);
})();