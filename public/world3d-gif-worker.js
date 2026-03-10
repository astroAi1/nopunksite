import { GIFEncoder, quantize, applyPalette, prequantize } from './vendor/gifenc.module.js';

let session = null;

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
  const repeat = Number.isFinite(Number(payload?.repeat)) ? Number(payload.repeat) : 0;
  const paletteSize = Number(payload?.paletteSize) || 256;
  const quantizeFormat = payload?.quantizeFormat || 'rgb565';
  const prequantizeOptions =
    typeof payload?.prequantizeOptions === 'undefined' ? { roundRGB: 1, roundAlpha: 1 } : payload.prequantizeOptions;
  const minBytes = Number(payload?.minBytes) || 0;
  const maxBytes = Number(payload?.maxBytes) || 0;

  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('Invalid GIF dimensions');
  }

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 12;
  const delayMs = Math.max(20, Math.round(1000 / safeFps));

  session = {
    width,
    height,
    fps: safeFps,
    delayMs,
    repeat,
    paletteSize,
    quantizeFormat,
    prequantizeOptions,
    minBytes,
    maxBytes,
    frameIndex: 0,
    encoder: GIFEncoder({ auto: true }),
  };

  session.encoder.reset();
  self.postMessage({ type: 'ready' });
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
  const palette = quantize(rgba, session.paletteSize, {
    format: session.quantizeFormat || 'rgb565',
    clearAlpha: true,
    clearAlphaColor: 0,
    clearAlphaThreshold: 0,
  });
  const indexed = applyPalette(rgba, palette, session.quantizeFormat || 'rgb565');

  session.encoder.writeFrame(indexed, session.width, session.height, {
    palette,
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
  let output = bytes.slice();

  if (session.minBytes && output.byteLength < session.minBytes) {
    const targetSize = session.maxBytes && session.minBytes > session.maxBytes
      ? session.maxBytes
      : session.minBytes;
    if (targetSize > output.byteLength) {
      const padded = new Uint8Array(targetSize);
      padded.set(output, 0);
      output = padded;
    }
  }

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
