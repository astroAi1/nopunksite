const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const EXPORT_WIDTH = 1024;
const EXPORT_HEIGHT = 1024;
const ROTATION_SPEED_DEG_PER_SECOND = 42;
const ROTATION_DURATION_SECONDS = 360 / ROTATION_SPEED_DEG_PER_SECOND;
const MASTER_FPS = 18;
const MASTER_FRAME_COUNT = Math.round(ROTATION_DURATION_SECONDS * MASTER_FPS);
const GIF_LADDER = [
  { size: 1024, fps: 18 },
  { size: 1024, fps: 16 },
  { size: 900, fps: 14 },
  { size: 768, fps: 12 },
];

const DEFAULT_CHROME_CANDIDATES = [
  process.env.NOPUNKS_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  'google-chrome',
  'google-chrome-stable',
  'chromium-browser',
  'chromium',
].filter(Boolean);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function rimraf(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function resolveChromeExecutable() {
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (!candidate) continue;
    if (candidate.startsWith('/')) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }

  throw new Error('Chrome executable was not found. Set NOPUNKS_CHROME_PATH.');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(
        `${command} exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`
      );
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function waitForDevTools(debugPort, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`DevTools version endpoint returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(150);
  }

  throw lastError || new Error('Timed out waiting for Chrome DevTools');
}

class CDPConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;

      socket.once('open', resolve);
      socket.once('error', reject);
      socket.on('message', (message) => {
        this.handleMessage(message.toString());
      });
      socket.on('close', () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('Chrome DevTools connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  handleMessage(rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (_) {
      return;
    }

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const methodLabel = pending.method ? ` during ${pending.method}` : '';
        pending.reject(
          new Error(`${message.error.message || 'Chrome DevTools error'}${methodLabel}`)
        );
        return;
      }
      pending.resolve(message.result || {});
      return;
    }

    const listeners = this.eventListeners.get(message.method);
    if (!listeners || !listeners.length) return;
    listeners.slice().forEach((listener) => {
      listener(message);
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const payload = { id, method, params };
      if (sessionId) {
        payload.sessionId = sessionId;
      }

      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const listeners = this.eventListeners.get(method) || [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Chrome event ${method}`));
      }, timeoutMs);

      const handler = (message) => {
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const current = this.eventListeners.get(method) || [];
        this.eventListeners.set(
          method,
          current.filter((listener) => listener !== handler)
        );
      };

      listeners.push(handler);
      this.eventListeners.set(method, listeners);
    });
  }

  async close() {
    if (!this.socket) return;
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}

function getChromeArgs(debugPort, userDataDir) {
  const args = [
    '--headless=new',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--enable-webgl',
    '--hide-scrollbars',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-first-run',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--use-angle=swiftshader',
    `--window-size=${EXPORT_WIDTH},${EXPORT_HEIGHT}`,
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];

  if (/^(1|true|yes)$/i.test(String(process.env.NOPUNKS_CHROME_NO_SANDBOX || '').trim())) {
    args.unshift('--no-sandbox');
  }

  return args;
}

async function launchChrome() {
  const debugPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nopunks-share-chrome-'));
  const chromePath = resolveChromeExecutable();
  const chrome = spawn(chromePath, getChromeArgs(debugPort, userDataDir), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const versionInfo = await waitForDevTools(debugPort);
  return {
    chrome,
    userDataDir,
    browserWsUrl: versionInfo.webSocketDebuggerUrl,
    chromeStderr: () => stderr,
  };
}

async function waitForExportViewerReady(connection, sessionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    const result = await connection.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const exportApi = window.__nopunkExport;
          const exportState =
            exportApi && typeof exportApi.getState === 'function'
              ? exportApi.getState()
              : null;
          return {
            href: window.location.href,
            readyState: document.readyState,
            hasExportApi: Boolean(exportApi),
            modelViewerDefined: Boolean(window.customElements && customElements.get('model-viewer')),
            exportState,
          };
        })()`,
        returnByValue: true,
      },
      sessionId
    );

    lastSnapshot = result?.result?.value || null;
    if (lastSnapshot?.exportState?.error) {
      throw new Error(lastSnapshot.exportState.error);
    }

    if (lastSnapshot?.exportState?.ready) {
      return lastSnapshot.exportState;
    }

    await delay(150);
  }

  throw new Error(
    `Timed out waiting for export viewer` +
      `${lastSnapshot ? ` (${JSON.stringify(lastSnapshot)})` : ''}`
  );
}

async function connectExportPage(baseUrl, tokenId) {
  const chromeHandle = await launchChrome();
  const connection = new CDPConnection(chromeHandle.browserWsUrl);
  await connection.connect();

  let targetId = null;
  let sessionId = null;

  try {
    const createdTarget = await connection.send('Target.createTarget', {
      url: 'about:blank',
    });
    targetId = createdTarget.targetId;

    const attached = await connection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    sessionId = attached.sessionId;

    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: EXPORT_WIDTH,
        height: EXPORT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: EXPORT_WIDTH,
        screenHeight: EXPORT_HEIGHT,
      },
      sessionId
    );
    await connection.send(
      'Emulation.setDefaultBackgroundColorOverride',
      {
        color: { r: 0, g: 0, b: 0, a: 1 },
      },
      sessionId
    );

    const exportUrl =
      `${String(baseUrl || '').replace(/\/$/, '')}` +
      `/public/world3d-export.html?tokenId=${tokenId}`;
    const loadEvent = connection.waitForEvent(
      'Page.loadEventFired',
      (message) => message.sessionId === sessionId,
      20000
    );
    await connection.send('Page.navigate', { url: exportUrl }, sessionId);
    await loadEvent;
    await waitForExportViewerReady(connection, sessionId);

    return {
      connection,
      sessionId,
      targetId,
      chromeHandle,
    };
  } catch (err) {
    await closeExportPage({
      connection,
      sessionId,
      targetId,
      chromeHandle,
    }).catch(() => {});
    throw err;
  }
}

async function setExportFrame(connection, sessionId, frameIndex, frameCount) {
  await connection.send(
    'Runtime.evaluate',
    {
      expression: `window.__nopunkExport.setFrame(${frameIndex}, ${frameCount})`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  );
}

async function captureScreenshot(connection, sessionId, outputPath) {
  const result = await connection.send(
    'Page.captureScreenshot',
    {
      format: 'png',
      optimizeForSpeed: true,
      fromSurface: true,
      captureBeyondViewport: false,
    },
    sessionId
  );

  fs.writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
}

async function closeExportPage(exportPage) {
  const { connection, targetId, chromeHandle } = exportPage || {};

  if (connection && targetId) {
    try {
      await connection.send('Target.closeTarget', { targetId });
    } catch (_) {
      // Ignore close errors.
    }
  }

  if (connection) {
    await connection.close().catch(() => {});
  }

  if (chromeHandle?.chrome && !chromeHandle.chrome.killed) {
    chromeHandle.chrome.kill('SIGTERM');
    await delay(250);
    if (!chromeHandle.chrome.killed) {
      chromeHandle.chrome.kill('SIGKILL');
    }
  }

  if (chromeHandle?.userDataDir) {
    rimraf(chromeHandle.userDataDir);
  }
}

function formatProgress(percent) {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

async function captureWorld3dShareFrames({
  tokenId,
  baseUrl,
  onProgress = () => {},
}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `nopunks-share-${tokenId}-`));
  const framesDir = path.join(workDir, 'frames');
  ensureDir(framesDir);

  let exportPage = null;
  let completed = false;

  try {
    onProgress({ status: 'rendering', stage: 'Preparing scene', progressPct: 5 });
    exportPage = await connectExportPage(baseUrl, tokenId);

    for (let frameIndex = 0; frameIndex < MASTER_FRAME_COUNT; frameIndex += 1) {
      await setExportFrame(
        exportPage.connection,
        exportPage.sessionId,
        frameIndex,
        MASTER_FRAME_COUNT
      );
      await captureScreenshot(
        exportPage.connection,
        exportPage.sessionId,
        path.join(framesDir, `frame-${String(frameIndex).padStart(4, '0')}.png`)
      );

      onProgress({
        status: 'rendering',
        stage: 'Rendering rotation',
        progressPct: formatProgress(8 + ((frameIndex + 1) / MASTER_FRAME_COUNT) * 74),
      });
    }

    completed = true;
    return { workDir, framesDir };
  } catch (err) {
    const chromeStderr = exportPage?.chromeHandle?.chromeStderr?.();
    if (chromeStderr) {
      err.message = `${err.message}\n${chromeStderr.trim()}`;
    }
    throw err;
  } finally {
    await closeExportPage(exportPage).catch(() => {});
    if (!completed) {
      rimraf(workDir);
    }
  }
}

async function renderWorld3dShareMp4({
  tokenId,
  outputPath,
  baseUrl,
  onProgress = () => {},
}) {
  ensureDir(path.dirname(outputPath));
  if (isExistingFile(outputPath)) {
    onProgress({ status: 'ready', stage: 'Ready', progressPct: 100 });
    return outputPath;
  }

  const { workDir, framesDir } = await captureWorld3dShareFrames({
    tokenId,
    baseUrl,
    onProgress,
  });

  try {
    onProgress({ status: 'encoding', stage: 'Encoding video', progressPct: 86 });

    await runCommand(process.env.NOPUNKS_FFMPEG_PATH || 'ffmpeg', [
      '-y',
      '-framerate',
      String(MASTER_FPS),
      '-i',
      path.join(framesDir, 'frame-%04d.png'),
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath,
    ]);

    onProgress({ status: 'ready', stage: 'Ready', progressPct: 100 });
    return outputPath;
  } finally {
    rimraf(workDir);
  }
}

async function encodeGifVariant(framesDir, outputPath, size, fps) {
  const ffmpegBinary = process.env.NOPUNKS_FFMPEG_PATH || 'ffmpeg';
  const filterGraph =
    `fps=${fps},scale=${size}:${size}:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=max_colors=256:stats_mode=full[p];` +
    `[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;

  await runCommand(ffmpegBinary, [
    '-y',
    '-framerate',
    String(MASTER_FPS),
    '-i',
    path.join(framesDir, 'frame-%04d.png'),
    '-filter_complex',
    filterGraph,
    '-loop',
    '0',
    outputPath,
  ]);
}

async function renderWorld3dShareGif({
  tokenId,
  outputPath,
  baseUrl,
  onProgress = () => {},
  maxBytes = 15 * 1024 * 1024,
}) {
  ensureDir(path.dirname(outputPath));
  if (isExistingFile(outputPath) && fs.statSync(outputPath).size <= maxBytes) {
    onProgress({ status: 'ready', stage: 'Ready', progressPct: 100 });
    return outputPath;
  }

  const { workDir, framesDir } = await captureWorld3dShareFrames({
    tokenId,
    baseUrl,
    onProgress,
  });

  try {
    for (let index = 0; index < GIF_LADDER.length; index += 1) {
      const variant = GIF_LADDER[index];
      const variantPath = path.join(workDir, `variant-${variant.size}-${variant.fps}.gif`);
      onProgress({
        status: 'encoding',
        stage: 'Encoding GIF',
        progressPct: formatProgress(82 + ((index + 1) / GIF_LADDER.length) * 16),
      });

      await encodeGifVariant(framesDir, variantPath, variant.size, variant.fps);

      if (fs.statSync(variantPath).size <= maxBytes) {
        fs.copyFileSync(variantPath, outputPath);
        onProgress({ status: 'ready', stage: 'Ready', progressPct: 100 });
        return outputPath;
      }
    }

    throw new Error('Could not fit the 3D GIF under 15 MB');
  } finally {
    rimraf(workDir);
  }
}

module.exports = {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  isExistingFile,
  renderWorld3dShareGif,
  renderWorld3dShareMp4,
};
