import { GIFEncoder, quantize, applyPalette, prequantize } from './vendor/gifenc.module.js';

let session = null;

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function clampChannel(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function applyOrderedDither(rgba, width, height, strength = 6) {
  if (!rgba || !width || !height || strength <= 0) return;
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride;
    const matrixRow = BAYER_4X4[y & 3];
    for (let x = 0; x < width; x += 1) {
      const offset = (matrixRow[x & 3] / 16 - 0.5) * strength;
      const idx = rowOffset + x * 4;
      rgba[idx] = clampChannel(rgba[idx] + offset);
      rgba[idx + 1] = clampChannel(rgba[idx + 1] + offset);
      rgba[idx + 2] = clampChannel(rgba[idx + 2] + offset);
    }
  }
}

function postError(err) {
  const message = err && err.message ? err.message : String(err || 'GIF worker error');
  self.postMessage({ type: 'error', error: message });
}

function startSession(payload) {
  if (session) {
    throw new Error('GIF worker already started');
  }

  const width = Number(payload?.width);
  const height = Number(payload?.height);
  const fps = Number(payload?.fps);
  const delayCs = Number(payload?.delayCs);
  const repeat = Number.isFinite(Number(payload?.repeat)) ? Number(payload.repeat) : 0;
  const paletteSize = Number(payload?.paletteSize) || 256;
  const quantizeFormat = payload?.quantizeFormat || 'rgb565';
  const prequantizeOptions =
    typeof payload?.prequantizeOptions === 'undefined' ? { roundRGB: 1, roundAlpha: 1 } : payload.prequantizeOptions;
  const useGlobalPalette = typeof payload?.useGlobalPalette === 'boolean'
    ? payload.useGlobalPalette
    : payload?.paletteStrategy === 'global';
  const orderedDither = Boolean(payload?.orderedDither);
  const ditherStrength = Number.isFinite(Number(payload?.ditherStrength))
    ? Number(payload.ditherStrength)
    : 6;

  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('Invalid GIF dimensions');
  }

  const safeDelayCs = Number.isFinite(delayCs) && delayCs > 0 ? Math.round(delayCs) : 0;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : safeDelayCs ? 100 / safeDelayCs : 12;
  const delayMs = safeDelayCs ? Math.max(20, safeDelayCs * 10) : Math.max(20, Math.round(1000 / safeFps));

  session = {
    width,
    height,
    fps: safeFps,
    delayMs,
    delayCs: safeDelayCs || Math.round(100 / safeFps),
    repeat,
    paletteSize,
    quantizeFormat,
    prequantizeOptions,
    useGlobalPalette,
    orderedDither,
    ditherStrength,
    globalPalette: null,
    frameIndex: 0,
    encoder: GIFEncoder({ auto: true }),
  };

  session.encoder.reset();
  self.postMessage({ type: 'ready' });
}

function handlePaletteInit(payload) {
  if (!session) {
    throw new Error('GIF worker not initialized');
  }

  const rgbaBuffer = payload?.rgbaBuffer;
  if (!rgbaBuffer || !(rgbaBuffer instanceof ArrayBuffer)) {
    throw new Error('Missing palette sample buffer');
  }

  const rgba = new Uint8ClampedArray(rgbaBuffer);
  if (!rgba.length) {
    throw new Error('Palette sample buffer empty');
  }

  if (session.prequantizeOptions !== false) {
    prequantize(rgba, session.prequantizeOptions || { roundRGB: 1, roundAlpha: 1 });
  }

  session.globalPalette = quantize(rgba, session.paletteSize, {
    format: session.quantizeFormat || 'rgb565',
    clearAlpha: true,
    clearAlphaColor: 0,
    clearAlphaThreshold: 0,
  });

  self.postMessage({
    type: 'palette-ready',
    colors: session.globalPalette ? session.globalPalette.length : 0,
  });
}

function handleFrame(payload) {
  if (!session) {
    throw new Error('GIF worker not initialized');
  }

  const rgbaBuffer = payload?.rgbaBuffer;
  if (!rgbaBuffer || !(rgbaBuffer instanceof ArrayBuffer)) {
    throw new Error('Missing frame buffer');
  }

  const rgba = new Uint8ClampedArray(rgbaBuffer);
  const expectedLength = session.width * session.height * 4;
  if (rgba.length !== expectedLength) {
    throw new Error('Unexpected frame buffer size');
  }

  if (session.prequantizeOptions !== false) {
    prequantize(rgba, session.prequantizeOptions || { roundRGB: 1, roundAlpha: 1 });
  }
  if (session.orderedDither) {
    applyOrderedDither(rgba, session.width, session.height, session.ditherStrength);
  }

  let palette = null;
  if (session.useGlobalPalette) {
    if (!session.globalPalette) {
      session.globalPalette = quantize(rgba, session.paletteSize, {
        format: session.quantizeFormat || 'rgb565',
        clearAlpha: true,
        clearAlphaColor: 0,
        clearAlphaThreshold: 0,
      });
    }
    palette = session.globalPalette;
  } else {
    palette = quantize(rgba, session.paletteSize, {
      format: session.quantizeFormat || 'rgb565',
      clearAlpha: true,
      clearAlphaColor: 0,
      clearAlphaThreshold: 0,
    });
  }

  const indexed = applyPalette(rgba, palette, session.quantizeFormat || 'rgb565');

  session.encoder.writeFrame(indexed, session.width, session.height, {
    palette: session.useGlobalPalette && session.frameIndex > 0 ? null : palette,
    delay: session.delayMs,
    repeat: session.repeat,
    dispose: 1,
  });

  session.frameIndex += 1;
  self.postMessage({ type: 'frame-ack', frameIndex: session.frameIndex });
}

function finishSession() {
  if (!session) {
    throw new Error('GIF worker not initialized');
  }

  if (session.frameIndex === 0) {
    throw new Error('No frames received');
  }

  session.encoder.finish();
  const bytes = session.encoder.bytesView();
  const output = bytes.slice();
  const buffer = output.buffer;

  self.postMessage(
    {
      type: 'result',
      size: output.byteLength,
      buffer,
    },
    [buffer]
  );

  session = null;
}

self.addEventListener('message', (event) => {
  const payload = event.data || {};
  try {
    switch (payload.type) {
      case 'start':
        startSession(payload);
        break;
      case 'initPalette':
        handlePaletteInit(payload);
        break;
      case 'frame':
        handleFrame(payload);
        break;
      case 'finish':
        finishSession();
        break;
      default:
        break;
    }
  } catch (err) {
    postError(err);
  }
});
