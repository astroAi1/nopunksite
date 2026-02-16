#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ERC721_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--chain') parsed.chain = next;
    if (arg === '--source') parsed.source = next;
    if (arg === '--contract') parsed.contract = next;
    if (arg === '--api-key') parsed.apiKey = next;
    if (arg === '--api-base') parsed.apiBase = next;
    if (arg === '--chain-id') parsed.chainId = next;
    if (arg === '--rpc-url') parsed.rpcUrl = next;
    if (arg === '--token-map') parsed.tokenMapPath = next;
    if (arg === '--use-token-map') parsed.useTokenMap = true;
    if (arg === '--total-supply') parsed.totalSupply = Number.parseInt(next, 10);
    if (arg === '--owner-batch-size') parsed.ownerBatchSize = Number.parseInt(next, 10);
    if (arg === '--start-block') parsed.startBlock = Number.parseInt(next, 10);
    if (arg === '--chunk-size') parsed.chunkSize = Number.parseInt(next, 10);
    if (arg === '--block-sleep-ms') parsed.blockSleepMs = Number.parseInt(next, 10);
    if (arg === '--out-dir') parsed.outDir = next;
    if (arg === '--offset') parsed.offset = Number.parseInt(next, 10);
    if (arg === '--max-pages') parsed.maxPages = Number.parseInt(next, 10);
    if (arg === '--history-limit') parsed.historyLimit = Number.parseInt(next, 10);
    if (arg === '--from-file') parsed.fromFile = next;
    if (arg === '--allow-empty') parsed.allowEmpty = true;
  }

  return {
    chain: parsed.chain || process.env.CHAIN || process.env.OPENSEA_CHAIN || 'base',
    source:
      parsed.source ||
      process.env.HOLDER_SOURCE ||
      'auto',
    contract:
      parsed.contract ||
      process.env.CONTRACT ||
      process.env.OPENSEA_CONTRACT ||
      '0xa62f65d503068684e7228df98090f94322b8ed54',
    apiKey: parsed.apiKey || process.env.ETHERSCAN_API_KEY || '',
    apiBase:
      parsed.apiBase ||
      process.env.EXPLORER_API_BASE ||
      process.env.ETHERSCAN_API_BASE ||
      '',
    chainId:
      parsed.chainId ||
      process.env.CHAIN_ID ||
      process.env.EXPLORER_CHAIN_ID ||
      getChainId(parsed.chain || process.env.CHAIN || process.env.OPENSEA_CHAIN || 'base'),
    rpcUrl:
      parsed.rpcUrl ||
      process.env.BASE_RPC_URL ||
      process.env.RPC_URL ||
      getDefaultRpcUrl(parsed.chain || process.env.CHAIN || process.env.OPENSEA_CHAIN || 'base'),
    tokenMapPath:
      parsed.tokenMapPath ||
      process.env.TOKEN_MAP_PATH ||
      './public/token_map.json',
    useTokenMap:
      Boolean(parsed.useTokenMap) ||
      /^(1|true|yes)$/i.test(String(process.env.HOLDER_USE_TOKEN_MAP || '').trim()),
    totalSupply: Number.isFinite(parsed.totalSupply)
      ? Math.max(1, parsed.totalSupply)
      : Number.isFinite(Number.parseInt(process.env.HOLDER_TOTAL_SUPPLY || '', 10))
      ? Math.max(1, Number.parseInt(process.env.HOLDER_TOTAL_SUPPLY, 10))
      : 10000,
    ownerBatchSize: Number.isFinite(parsed.ownerBatchSize)
      ? Math.max(10, parsed.ownerBatchSize)
      : Number.isFinite(Number.parseInt(process.env.HOLDER_OWNER_BATCH_SIZE || '', 10))
      ? Math.max(10, Number.parseInt(process.env.HOLDER_OWNER_BATCH_SIZE, 10))
      : 150,
    startBlock: Number.isFinite(parsed.startBlock)
      ? Math.max(0, parsed.startBlock)
      : Number.isFinite(Number.parseInt(process.env.HOLDER_START_BLOCK || '', 10))
      ? Math.max(0, Number.parseInt(process.env.HOLDER_START_BLOCK, 10))
      : 0,
    chunkSize: Number.isFinite(parsed.chunkSize)
      ? Math.max(200, parsed.chunkSize)
      : Number.isFinite(Number.parseInt(process.env.HOLDER_RPC_CHUNK_SIZE || '', 10))
      ? Math.max(200, Number.parseInt(process.env.HOLDER_RPC_CHUNK_SIZE, 10))
      : 25000,
    blockSleepMs: Number.isFinite(parsed.blockSleepMs)
      ? Math.max(0, parsed.blockSleepMs)
      : Number.isFinite(Number.parseInt(process.env.HOLDER_RPC_SLEEP_MS || '', 10))
      ? Math.max(0, Number.parseInt(process.env.HOLDER_RPC_SLEEP_MS, 10))
      : 45,
    outDir: parsed.outDir || './public/data/holders',
    offset: Number.isFinite(parsed.offset) ? parsed.offset : 100,
    maxPages: Number.isFinite(parsed.maxPages) ? parsed.maxPages : 500,
    historyLimit: Number.isFinite(parsed.historyLimit) ? parsed.historyLimit : 20,
    fromFile: parsed.fromFile || '',
    allowEmpty: Boolean(parsed.allowEmpty),
  };
}

function normalizeAddress(value) {
  if (!value) return '';
  const text = String(value).trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(text) ? text : '';
}

function normalizeTimestamp(value) {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 10_000_000_000) return Math.floor(n / 1000);
  return Math.floor(n);
}

function getApiBase(chainName) {
  // Etherscan V2 is the canonical multichain API host.
  // Chain selection is done through the `chainid` query parameter.
  return 'https://api.etherscan.io/v2/api';
}

function getChainId(chainName) {
  const c = String(chainName || '').toLowerCase();
  if (c === 'base') return '8453';
  if (c === 'base-sepolia') return '84532';
  if (c === 'ethereum' || c === 'mainnet') return '1';
  if (c === 'sepolia') return '11155111';
  return '8453';
}

function getDefaultRpcUrl(chainName) {
  return getDefaultRpcUrls(chainName)[0];
}

function getDefaultRpcUrls(chainName) {
  const c = String(chainName || '').toLowerCase();
  if (c === 'base') {
    return [
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://base-rpc.publicnode.com',
      'https://1rpc.io/base',
    ];
  }
  if (c === 'base-sepolia') {
    return [
      'https://sepolia.base.org',
      'https://base-sepolia-rpc.publicnode.com',
    ];
  }
  if (c === 'ethereum' || c === 'mainnet') {
    return [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
    ];
  }
  if (c === 'sepolia') {
    return [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://rpc.sepolia.org',
    ];
  }
  return ['https://mainnet.base.org'];
}

function getRpcCandidates(cfg) {
  const out = [];
  const seen = new Set();

  const add = (url) => {
    if (!url) return;
    const clean = String(url).trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  String(cfg.rpcUrl || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach(add);

  getDefaultRpcUrls(cfg.chain).forEach(add);
  return out;
}

function normalizeTransfer(rawTx) {
  const tokenIdRaw = rawTx?.tokenID ?? rawTx?.tokenId ?? rawTx?.token_id ?? null;
  if (tokenIdRaw == null) return null;
  const tokenId = Number.parseInt(String(tokenIdRaw), 10);
  if (!Number.isFinite(tokenId)) return null;

  const from = normalizeAddress(rawTx?.from ?? rawTx?.from_address ?? rawTx?.fromAddress);
  const to = normalizeAddress(rawTx?.to ?? rawTx?.to_address ?? rawTx?.toAddress);

  const blockNumber = Number.parseInt(
    String(rawTx?.blockNumber ?? rawTx?.block_number ?? '0'),
    10
  );
  const transactionIndex = Number.parseInt(
    String(rawTx?.transactionIndex ?? rawTx?.transaction_index ?? '0'),
    10
  );
  const logIndex = Number.parseInt(String(rawTx?.logIndex ?? rawTx?.log_index ?? '0'), 10);
  const timestamp = normalizeTimestamp(rawTx?.timeStamp ?? rawTx?.timestamp ?? rawTx?.time);

  return {
    tokenId,
    from,
    to,
    blockNumber: Number.isFinite(blockNumber) ? blockNumber : 0,
    transactionIndex: Number.isFinite(transactionIndex) ? transactionIndex : 0,
    logIndex: Number.isFinite(logIndex) ? logIndex : 0,
    timestamp,
    hash: String(rawTx?.hash ?? rawTx?.transactionHash ?? rawTx?.txHash ?? ''),
  };
}

function transferSort(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.tokenId !== b.tokenId) return a.tokenId - b.tokenId;
  return String(a.hash).localeCompare(String(b.hash));
}

function makeUniqueSortedTransfers(transfers) {
  const deduped = [];
  const seen = new Set();

  transfers.forEach((tx) => {
    if (!tx) return;
    const dedupeKey = `${tx.hash}|${tx.tokenId}|${tx.logIndex}|${tx.from}|${tx.to}|${tx.timestamp}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    deduped.push(tx);
  });

  deduped.sort(transferSort);
  return deduped;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toHexQuantity(value) {
  const n = Math.max(0, Number(value) || 0);
  return `0x${n.toString(16)}`;
}

function hexToInt(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim();
  if (!text) return 0;
  const n = text.startsWith('0x')
    ? Number.parseInt(text.slice(2), 16)
    : Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

function topicToAddress(topic) {
  if (!topic || typeof topic !== 'string') return '';
  const hex = topic.startsWith('0x') ? topic.slice(2) : topic;
  if (hex.length < 40) return '';
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

let rpcIdCounter = 1;
async function rpcCall(rpcUrl, method, params) {
  const body = {
    jsonrpc: '2.0',
    id: rpcIdCounter++,
    method,
    params,
  };

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${method} failed (${res.status}): ${text.slice(0, 220)}`);
  }

  const json = await res.json();
  if (json?.error) {
    const message = json.error?.message || JSON.stringify(json.error);
    throw new Error(`RPC ${method} error: ${message}`);
  }

  return json?.result;
}

function parseTransferLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 4) {
    return null;
  }

  const tokenId = hexToInt(log.topics[3]);
  if (!Number.isFinite(tokenId)) return null;

  return {
    tokenId,
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    blockNumber: hexToInt(log.blockNumber),
    transactionIndex: hexToInt(log.transactionIndex),
    logIndex: hexToInt(log.logIndex),
    timestamp: 0,
    hash: String(log.transactionHash || ''),
  };
}

async function rpcCallWithFallback(rpcUrls, method, params) {
  let lastErr = null;

  for (const url of rpcUrls) {
    try {
      const result = await rpcCall(url, method, params);
      return { result, rpcUrl: url };
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `All RPC endpoints failed for ${method}. Last error: ${String(lastErr?.message || lastErr)}`
  );
}

async function rpcBatchCall(rpcUrl, calls) {
  const payload = calls.map((call) => ({
    jsonrpc: '2.0',
    id: call.id,
    method: call.method,
    params: call.params,
  }));

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC batch failed (${res.status}): ${text.slice(0, 220)}`);
  }

  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error('RPC batch returned non-array response');
  }
  return json;
}

async function rpcBatchCallWithFallback(rpcUrls, calls) {
  let lastErr = null;

  for (const url of rpcUrls) {
    try {
      const result = await rpcBatchCall(url, calls);
      return { result, rpcUrl: url };
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `All RPC endpoints failed for batch call. Last error: ${String(lastErr?.message || lastErr)}`
  );
}

async function fetchTransfersFromRpc(cfg) {
  const rpcCandidates = getRpcCandidates(cfg);
  if (!rpcCandidates.length) {
    throw new Error(
      'No RPC URL configured. Set BASE_RPC_URL or pass --rpc-url to build holder snapshots.'
    );
  }

  const contract = normalizeAddress(cfg.contract);
  if (!contract) {
    throw new Error(`Invalid contract address: ${cfg.contract}`);
  }

  const latestBlockHexResult = await rpcCallWithFallback(
    rpcCandidates,
    'eth_blockNumber',
    []
  );
  const latestBlockHex = latestBlockHexResult.result;
  const latestBlock = hexToInt(latestBlockHex);
  if (!Number.isFinite(latestBlock) || latestBlock <= 0) {
    throw new Error(`Unable to determine latest block from RPC: ${latestBlockHex}`);
  }

  const out = [];
  const minChunkSize = 200;
  let chunkSize = Math.max(minChunkSize, Number(cfg.chunkSize) || 25000);
  let fromBlock = Math.max(0, Number(cfg.startBlock) || 0);
  let rangesFetched = 0;

  while (fromBlock <= latestBlock) {
    const toBlock = Math.min(latestBlock, fromBlock + chunkSize - 1);
    const filter = {
      fromBlock: toHexQuantity(fromBlock),
      toBlock: toHexQuantity(toBlock),
      address: contract,
      topics: [ERC721_TRANSFER_TOPIC],
    };

    let logs;
    try {
      const rpcResponse = await rpcCallWithFallback(
        rpcCandidates,
        'eth_getLogs',
        [filter]
      );
      const result = rpcResponse.result;
      logs = Array.isArray(result) ? result : [];
    } catch (err) {
      const msg = String(err?.message || err);
      const retriable =
        /more than|result set|query returned more|limit exceeded|too large|timed out|timeout|429|rate/i.test(
          msg.toLowerCase()
        );

      if (retriable && chunkSize > minChunkSize) {
        chunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2));
        console.warn(
          `RPC range ${fromBlock}-${toBlock} failed (${msg}). Retrying with chunkSize=${chunkSize}.`
        );
        await sleep(250);
        continue;
      }

      throw new Error(`RPC log fetch failed for blocks ${fromBlock}-${toBlock}: ${msg}`);
    }

    rangesFetched += 1;
    logs.forEach((log) => {
      const tx = parseTransferLog(log);
      if (tx) out.push(tx);
    });

    const progressPct = ((toBlock / latestBlock) * 100).toFixed(1);
    console.log(
      `RPC blocks ${fromBlock}-${toBlock}: ${logs.length} events (${progressPct}% complete)`
    );

    fromBlock = toBlock + 1;
    if (cfg.blockSleepMs > 0) {
      await sleep(cfg.blockSleepMs);
    }
  }

  return {
    transfers: out,
    source: {
      type: 'rpc-eth_getLogs',
      rpcUrls: rpcCandidates,
      chainId: String(cfg.chainId),
      startBlock: Number(cfg.startBlock) || 0,
      latestBlock,
      rangesFetched,
      chunkSizeUsed: chunkSize,
    },
  };
}

function encodeOwnerOfCall(tokenId) {
  const selector = '6352211e';
  const n = Number(tokenId);
  if (!Number.isFinite(n) || n < 0) return null;
  const padded = n.toString(16).padStart(64, '0');
  return `0x${selector}${padded}`;
}

function parseOwnerOfResult(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (hex.length < 40) return '';
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

async function loadTokenIdsFromMap(cfg) {
  const totalSupply = Number.isFinite(Number(cfg.totalSupply))
    ? Math.max(1, Number(cfg.totalSupply))
    : 10000;
  const defaultIds = Array.from({ length: totalSupply }, (_, i) => i);

  if (!cfg.useTokenMap || !cfg.tokenMapPath) {
    return defaultIds;
  }

  const mapPath = path.resolve(process.cwd(), cfg.tokenMapPath);
  const data = await readJsonSafe(mapPath);
  if (!data) {
    return defaultIds;
  }

  const ids = [];
  if (Array.isArray(data)) {
    data.forEach((value, index) => {
      if (value == null) {
        ids.push(index);
        return;
      }
      const n = Number.parseInt(String(value), 10);
      ids.push(Number.isFinite(n) ? n : index);
    });
  } else if (typeof data === 'object') {
    Object.keys(data)
      .sort((a, b) => Number(a) - Number(b))
      .forEach((indexKey) => {
        const index = Number.parseInt(indexKey, 10);
        const value = data[indexKey];
        const n = Number.parseInt(String(value), 10);
        ids.push(Number.isFinite(n) ? n : index);
      });
  }

  return Array.from(new Set(ids));
}

async function fetchOwnersFromRpc(cfg) {
  const rpcCandidates = getRpcCandidates(cfg);
  if (!rpcCandidates.length) {
    throw new Error(
      'No RPC URL configured. Set BASE_RPC_URL or pass --rpc-url to build holder snapshots.'
    );
  }

  const contract = normalizeAddress(cfg.contract);
  if (!contract) {
    throw new Error(`Invalid contract address: ${cfg.contract}`);
  }

  const tokenIds = await loadTokenIdsFromMap(cfg);
  const ownerEntries = [];
  const batchSize = Math.max(10, Number(cfg.ownerBatchSize) || 150);
  const unresolvedTokenIds = [];

  async function resolveOwnerWithRetry(tokenId, retries = 3) {
    const data = encodeOwnerOfCall(tokenId);
    if (!data) return { ok: false, owner: '', error: 'invalid token id' };

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const rpcResponse = await rpcCallWithFallback(rpcCandidates, 'eth_call', [
          { to: contract, data },
          'latest',
        ]);
        const owner = parseOwnerOfResult(rpcResponse.result);
        if (!owner || owner === ZERO_ADDRESS) {
          return { ok: true, owner: '' };
        }
        return { ok: true, owner };
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await sleep(100 + attempt * 200);
        }
      }
    }

    return {
      ok: false,
      owner: '',
      error: String(lastError?.message || lastError || 'ownerOf failed'),
    };
  }

  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const slice = tokenIds.slice(i, i + batchSize);
    const calls = [];

    for (const tokenId of slice) {
      const data = encodeOwnerOfCall(tokenId);
      if (!data) continue;
      calls.push({
        id: `${i}:${tokenId}`,
        method: 'eth_call',
        params: [{ to: contract, data }, 'latest'],
        tokenId,
      });
    }

    const rpcResponse = await rpcBatchCallWithFallback(rpcCandidates, calls);
    const responseById = new Map();
    rpcResponse.result.forEach((row) => {
      responseById.set(String(row.id), row);
    });

    for (const call of calls) {
      const row = responseById.get(String(call.id));
      if (!row || row.error) {
        unresolvedTokenIds.push(call.tokenId);
        continue;
      }

      const owner = parseOwnerOfResult(row.result);
      if (!owner || owner === ZERO_ADDRESS) continue;
      ownerEntries.push({ tokenId: call.tokenId, owner });
    }

    const pct = (((i + slice.length) / tokenIds.length) * 100).toFixed(1);
    console.log(
      `ownerOf scan ${i + slice.length}/${tokenIds.length} (${pct}%)`
    );
    if (cfg.blockSleepMs > 0) {
      await sleep(Math.min(250, cfg.blockSleepMs));
    }
  }

  if (unresolvedTokenIds.length) {
    console.warn(
      `Batch ownerOf had ${unresolvedTokenIds.length} unresolved token reads. Retrying individually...`
    );

    const stillFailed = [];
    for (let i = 0; i < unresolvedTokenIds.length; i += 1) {
      const tokenId = unresolvedTokenIds[i];
      const resolved = await resolveOwnerWithRetry(tokenId, 3);
      if (!resolved.ok) {
        stillFailed.push(tokenId);
      } else if (resolved.owner) {
        ownerEntries.push({ tokenId, owner: resolved.owner });
      }

      if ((i + 1) % 200 === 0 || i + 1 === unresolvedTokenIds.length) {
        const pct = (((i + 1) / unresolvedTokenIds.length) * 100).toFixed(1);
        console.log(`ownerOf retry ${i + 1}/${unresolvedTokenIds.length} (${pct}%)`);
      }
    }

    if (stillFailed.length) {
      throw new Error(
        `ownerOf verification failed for ${stillFailed.length} token IDs. First few: ${stillFailed
          .slice(0, 12)
          .join(', ')}`
      );
    }
  }

  const byTokenId = new Map();
  ownerEntries.forEach((entry) => {
    byTokenId.set(String(entry.tokenId), entry.owner);
  });
  const missingCoverage = tokenIds.filter((tokenId) => !byTokenId.has(String(tokenId)));
  if (missingCoverage.length && !cfg.allowEmpty) {
    throw new Error(
      `ownerOf coverage mismatch: missing ${missingCoverage.length} token IDs. First few: ${missingCoverage
        .slice(0, 12)
        .join(', ')}`
    );
  }

  return {
    ownerEntries,
    tokenIds,
    source: {
      type: 'rpc-ownerOf',
      rpcUrls: rpcCandidates,
      chainId: String(cfg.chainId),
      tokenCount: tokenIds.length,
      totalSupply: Number(cfg.totalSupply) || 10000,
      tokenIdSource: cfg.useTokenMap ? 'token-map' : 'onchain-range',
      tokenMapPath: cfg.useTokenMap ? path.resolve(process.cwd(), cfg.tokenMapPath) : null,
      ownerReads: ownerEntries.length,
      unresolvedReadsRetried: unresolvedTokenIds.length,
      missingCoverage: missingCoverage.length,
    },
  };
}

async function fetchTransfersFromExplorerApi(cfg) {
  if (!cfg.apiKey) {
    throw new Error(
      'ETHERSCAN_API_KEY is required. Set it in .env or pass --api-key when running build:holders.'
    );
  }

  const apiBase = cfg.apiBase || getApiBase(cfg.chain);
  const fallbackBases = [apiBase];
  if (apiBase !== 'https://api.etherscan.io/v2/api') {
    fallbackBases.push('https://api.etherscan.io/v2/api');
  }

  const out = [];
  let pagesFetched = 0;
  let reachedPageCap = false;

  for (let page = 1; page <= cfg.maxPages; page += 1) {
    const params = new URLSearchParams({
      chainid: String(cfg.chainId),
      module: 'account',
      action: 'tokennfttx',
      contractaddress: cfg.contract,
      page: String(page),
      offset: String(cfg.offset),
      sort: 'asc',
      apikey: cfg.apiKey,
    });
    let lastHttpError = null;
    let json = null;
    let activeBase = apiBase;

    for (const baseCandidate of fallbackBases) {
      const url = `${baseCandidate}?${params.toString()}`;
      const response = await fetch(url, { headers: { accept: 'application/json' } });

      if (!response.ok) {
        const body = await response.text();
        lastHttpError = `Holder transfer fetch failed (${response.status}) at ${baseCandidate}: ${body.slice(0, 200)}`;
        continue;
      }

      json = await response.json();
      activeBase = baseCandidate;
      lastHttpError = null;
      break;
    }

    if (!json) {
      throw new Error(lastHttpError || 'Holder transfer fetch failed with no JSON response');
    }

    const status = String(json?.status ?? '');
    const message = String(json?.message ?? '');
    const rawResult = json?.result;
    pagesFetched += 1;

    if (status === '0') {
      const resultText =
        typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult || '');
      const combined = `${message} ${resultText}`.trim();
      const noTransactions = /no transactions|no records found/i.test(combined);
      const deprecatedV1 = /deprecated.*v1|switch to etherscan api v2/i.test(combined);

      if (noTransactions) {
        console.log(`No transactions reported at page ${page}; stopping.`);
        break;
      }

      if (deprecatedV1) {
        throw new Error(
          `Explorer rejected V1 endpoint. Use Etherscan V2 at https://api.etherscan.io/v2/api with chainid=${cfg.chainId}.`
        );
      }

      throw new Error(
        `Explorer API returned status=0 at page ${page}: ${combined || 'Unknown error'}`
      );
    }

    if (!Array.isArray(rawResult)) {
      throw new Error(
        `Unexpected explorer payload at page ${page}: result is not an array`
      );
    }

    const result = rawResult;
    console.log(`Fetched page ${page} (${result.length} transfers) via ${activeBase}`);
    result.forEach((raw) => {
      const tx = normalizeTransfer(raw);
      if (tx) out.push(tx);
    });

    if (page === cfg.maxPages && result.length === cfg.offset) {
      reachedPageCap = true;
    }

    if (result.length < cfg.offset) {
      break;
    }

    await sleep(170);
  }

  if (reachedPageCap) {
    throw new Error(
      `Transfer history hit --max-pages (${cfg.maxPages}) with full pages. Increase --max-pages for a complete holder snapshot.`
    );
  }

  return {
    transfers: out,
    source: {
      type: 'explorer-v2-tokennfttx',
      apiBase,
      chainId: String(cfg.chainId),
      pagesFetched,
    },
  };
}

function shouldFallbackToRpc(error) {
  const msg = String(error?.message || error).toLowerCase();
  return (
    msg.includes('free api access is not supported for this chain') ||
    msg.includes('deprecated v1 endpoint') ||
    msg.includes('status=0') ||
    msg.includes('holder transfer fetch failed (404)') ||
    msg.includes('fetch failed')
  );
}

function shouldFallbackToOwnerScan(error) {
  const msg = String(error?.message || error).toLowerCase();
  return (
    msg.includes('rpc log fetch failed') ||
    msg.includes('all rpc endpoints failed') ||
    msg.includes('no backend is currently healthy') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('503')
  );
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchTransfersFromFile(filePath) {
  const fullPath = path.resolve(process.cwd(), filePath);
  const json = await readJsonSafe(fullPath);
  if (!json) {
    throw new Error(`Unable to read transfer file: ${fullPath}`);
  }

  const sourceArray = Array.isArray(json)
    ? json
    : Array.isArray(json?.transfers)
    ? json.transfers
    : Array.isArray(json?.result)
    ? json.result
    : [];

  const transfers = [];
  sourceArray.forEach((raw) => {
    const tx = normalizeTransfer(raw);
    if (tx) transfers.push(tx);
  });

  return {
    transfers,
    source: {
      type: 'file',
      file: fullPath,
      pagesFetched: 0,
    },
  };
}

function percentileFromRank(rank, total) {
  if (!Number.isFinite(rank) || !Number.isFinite(total) || total <= 0) return 0;
  return Number((((total - rank + 1) / total) * 100).toFixed(2));
}

function buildCohorts(holders, supplyAccounted) {
  const tiers = [
    { id: 'single', label: '1 Token', min: 1, max: 1 },
    { id: 'small', label: '2-4 Tokens', min: 2, max: 4 },
    { id: 'medium', label: '5-19 Tokens', min: 5, max: 19 },
    { id: 'large', label: '20-49 Tokens', min: 20, max: 49 },
    { id: 'whale', label: '50+ Tokens', min: 50, max: Number.POSITIVE_INFINITY },
  ];

  return tiers.map((tier) => {
    const inTier = holders.filter((h) => {
      if (h.balance < tier.min) return false;
      if (tier.max === Number.POSITIVE_INFINITY) return true;
      return h.balance <= tier.max;
    });

    const tokenCount = inTier.reduce((sum, h) => sum + h.balance, 0);
    return {
      id: tier.id,
      label: tier.label,
      min: tier.min,
      max: Number.isFinite(tier.max) ? tier.max : null,
      holders: inTier.length,
      tokenCount,
      holderSharePct:
        holders.length > 0 ? Number(((inTier.length / holders.length) * 100).toFixed(2)) : 0,
      tokenSharePct:
        supplyAccounted > 0 ? Number(((tokenCount / supplyAccounted) * 100).toFixed(2)) : 0,
    };
  });
}

function buildSnapshot(transferResult, cfg) {
  const transfers = makeUniqueSortedTransfers(transferResult.transfers);
  const tokenOwners = new Map();
  const lastActivity = Object.create(null);

  transfers.forEach((tx) => {
    const from = tx.from;
    const to = tx.to;
    const tokenId = tx.tokenId;

    if (from && from !== ZERO_ADDRESS) {
      const prev = lastActivity[from] || 0;
      lastActivity[from] = Math.max(prev, tx.timestamp);
    }
    if (to && to !== ZERO_ADDRESS) {
      const prev = lastActivity[to] || 0;
      lastActivity[to] = Math.max(prev, tx.timestamp);
    }

    if (!to || to === ZERO_ADDRESS) {
      tokenOwners.delete(tokenId);
      return;
    }

    tokenOwners.set(tokenId, to);
  });

  const holderTokens = new Map();
  tokenOwners.forEach((owner, tokenId) => {
    if (!owner || owner === ZERO_ADDRESS) return;
    if (!holderTokens.has(owner)) holderTokens.set(owner, []);
    holderTokens.get(owner).push(tokenId);
  });

  const holders = Array.from(holderTokens.entries())
    .map(([address, tokenIds]) => {
      tokenIds.sort((a, b) => a - b);
      return {
        address,
        balance: tokenIds.length,
        tokenIds,
        lastActivity:
          lastActivity[address] && lastActivity[address] > 0
            ? new Date(lastActivity[address] * 1000).toISOString()
            : null,
      };
    })
    .sort((a, b) => {
      if (b.balance !== a.balance) return b.balance - a.balance;
      return a.address.localeCompare(b.address);
    });

  const holderCount = holders.length;
  const supplyAccounted = tokenOwners.size;
  const balances = holders.map((h) => h.balance).sort((a, b) => a - b);
  const median =
    balances.length === 0
      ? 0
      : balances.length % 2 === 0
      ? (balances[balances.length / 2 - 1] + balances[balances.length / 2]) / 2
      : balances[Math.floor(balances.length / 2)];

  const top10TokenCount = holders.slice(0, 10).reduce((sum, h) => sum + h.balance, 0);
  const top25TokenCount = holders.slice(0, 25).reduce((sum, h) => sum + h.balance, 0);

  const cohorts = buildCohorts(holders, supplyAccounted);
  const topHolders = holders.slice(0, 250).map((holder, idx) => ({
    rank: idx + 1,
    address: holder.address,
    balance: holder.balance,
    shareOfSupplyPct:
      supplyAccounted > 0 ? Number(((holder.balance / supplyAccounted) * 100).toFixed(3)) : 0,
    percentile: percentileFromRank(idx + 1, holderCount),
    tokenPreview: holder.tokenIds.slice(0, 12),
    lastActivity: holder.lastActivity,
  }));

  const generatedAt = new Date().toISOString();

  const summary = {
    holderCount,
    supplyAccounted,
    avgTokensPerHolder:
      holderCount > 0 ? Number((supplyAccounted / holderCount).toFixed(4)) : 0,
    medianTokensPerHolder: Number(median.toFixed(4)),
    top10SharePct:
      supplyAccounted > 0 ? Number(((top10TokenCount / supplyAccounted) * 100).toFixed(3)) : 0,
    top25SharePct:
      supplyAccounted > 0 ? Number(((top25TokenCount / supplyAccounted) * 100).toFixed(3)) : 0,
    uniqueOwnersFromSnapshot: holderCount,
  };

  return {
    generatedAt,
    chain: cfg.chain,
    contract: normalizeAddress(cfg.contract) || cfg.contract,
    source: {
      ...transferResult.source,
      transferCount: transfers.length,
      tokenIdDomain: 'onchain',
    },
    summary,
    cohorts,
    topHolders,
    holders,
  };
}

function buildSnapshotFromOwners(ownerResult, cfg) {
  const holderTokens = new Map();

  ownerResult.ownerEntries.forEach((entry) => {
    const owner = normalizeAddress(entry.owner);
    if (!owner || owner === ZERO_ADDRESS) return;
    if (!holderTokens.has(owner)) holderTokens.set(owner, []);
    holderTokens.get(owner).push(entry.tokenId);
  });

  const holders = Array.from(holderTokens.entries())
    .map(([address, tokenIds]) => {
      tokenIds.sort((a, b) => a - b);
      return {
        address,
        balance: tokenIds.length,
        tokenIds,
        lastActivity: null,
      };
    })
    .sort((a, b) => {
      if (b.balance !== a.balance) return b.balance - a.balance;
      return a.address.localeCompare(b.address);
    });

  const holderCount = holders.length;
  const supplyAccounted = holders.reduce((sum, holder) => sum + holder.balance, 0);
  const balances = holders.map((h) => h.balance).sort((a, b) => a - b);
  const median =
    balances.length === 0
      ? 0
      : balances.length % 2 === 0
      ? (balances[balances.length / 2 - 1] + balances[balances.length / 2]) / 2
      : balances[Math.floor(balances.length / 2)];

  const top10TokenCount = holders.slice(0, 10).reduce((sum, h) => sum + h.balance, 0);
  const top25TokenCount = holders.slice(0, 25).reduce((sum, h) => sum + h.balance, 0);

  const cohorts = buildCohorts(holders, supplyAccounted);
  const topHolders = holders.slice(0, 250).map((holder, idx) => ({
    rank: idx + 1,
    address: holder.address,
    balance: holder.balance,
    shareOfSupplyPct:
      supplyAccounted > 0 ? Number(((holder.balance / supplyAccounted) * 100).toFixed(3)) : 0,
    percentile: percentileFromRank(idx + 1, holderCount),
    tokenPreview: holder.tokenIds.slice(0, 12),
    lastActivity: null,
  }));

  const generatedAt = new Date().toISOString();
  const summary = {
    holderCount,
    supplyAccounted,
    avgTokensPerHolder:
      holderCount > 0 ? Number((supplyAccounted / holderCount).toFixed(4)) : 0,
    medianTokensPerHolder: Number(median.toFixed(4)),
    top10SharePct:
      supplyAccounted > 0 ? Number(((top10TokenCount / supplyAccounted) * 100).toFixed(3)) : 0,
    top25SharePct:
      supplyAccounted > 0 ? Number(((top25TokenCount / supplyAccounted) * 100).toFixed(3)) : 0,
    uniqueOwnersFromSnapshot: holderCount,
  };

  return {
    generatedAt,
    chain: cfg.chain,
    contract: normalizeAddress(cfg.contract) || cfg.contract,
    source: {
      ...ownerResult.source,
      transferCount: 0,
      tokenIdDomain: 'onchain',
    },
    summary,
    cohorts,
    topHolders,
    holders,
  };
}

function toHistoryEntry(snapshot) {
  const balances = Object.create(null);
  snapshot.holders.forEach((holder) => {
    balances[holder.address] = holder.balance;
  });

  return {
    generatedAt: snapshot.generatedAt,
    summary: snapshot.summary,
    cohorts: snapshot.cohorts,
    topHolders: snapshot.topHolders.slice(0, 100),
    balances,
  };
}

function sortSnapshotsByDateAsc(a, b) {
  const at = new Date(a.generatedAt || 0).getTime();
  const bt = new Date(b.generatedAt || 0).getTime();
  return at - bt;
}

async function main() {
  const cfg = parseArgs();
  const sourceMode = String(cfg.source || 'auto').trim().toLowerCase();
  let snapshot;

  if (cfg.fromFile) {
    const transferResult = await fetchTransfersFromFile(cfg.fromFile);
    if (!cfg.allowEmpty && transferResult.transfers.length === 0) {
      throw new Error(
        'No transfers were fetched. Snapshot not written. Verify ETHERSCAN_API_KEY and rerun.'
      );
    }
    snapshot = buildSnapshot(transferResult, cfg);
  } else if (sourceMode === 'owners') {
    const ownerResult = await fetchOwnersFromRpc(cfg);
    snapshot = buildSnapshotFromOwners(ownerResult, cfg);
  } else if (sourceMode === 'rpc') {
    const transferResult = await fetchTransfersFromRpc(cfg);
    if (!cfg.allowEmpty && transferResult.transfers.length === 0) {
      throw new Error(
        'No transfers were fetched. Snapshot not written. Verify ETHERSCAN_API_KEY and rerun.'
      );
    }
    snapshot = buildSnapshot(transferResult, cfg);
  } else if (sourceMode === 'explorer') {
    const transferResult = await fetchTransfersFromExplorerApi(cfg);
    if (!cfg.allowEmpty && transferResult.transfers.length === 0) {
      throw new Error(
        'No transfers were fetched. Snapshot not written. Verify ETHERSCAN_API_KEY and rerun.'
      );
    }
    snapshot = buildSnapshot(transferResult, cfg);
  } else {
    // auto: explorer -> rpc logs -> owner scan
    try {
      const transferResult = await fetchTransfersFromExplorerApi(cfg);
      if (!cfg.allowEmpty && transferResult.transfers.length === 0) {
        throw new Error(
          'No transfers were fetched. Snapshot not written. Verify ETHERSCAN_API_KEY and rerun.'
        );
      }
      snapshot = buildSnapshot(transferResult, cfg);
    } catch (err) {
      if (!shouldFallbackToRpc(err)) {
        throw err;
      }
      console.warn(
        `Explorer holder fetch failed (${err.message || err}). Falling back to RPC log scan...`
      );
      try {
        const transferResult = await fetchTransfersFromRpc(cfg);
        if (!cfg.allowEmpty && transferResult.transfers.length === 0) {
          throw new Error(
            'No transfers were fetched from RPC logs. Falling back to owner scan.'
          );
        }
        snapshot = buildSnapshot(transferResult, cfg);
      } catch (rpcErr) {
        if (!shouldFallbackToOwnerScan(rpcErr)) {
          throw rpcErr;
        }
        console.warn(
          `RPC log scan failed (${rpcErr.message || rpcErr}). Falling back to ownerOf scan...`
        );
        const ownerResult = await fetchOwnersFromRpc(cfg);
        snapshot = buildSnapshotFromOwners(ownerResult, cfg);
      }
    }
  }

  if (!snapshot) {
    throw new Error('Failed to build holder snapshot from any source.');
  }

  const outDir = path.resolve(process.cwd(), cfg.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const latestPath = path.join(outDir, 'latest.json');
  const historyPath = path.join(outDir, 'history.json');

  const currentHistoryRaw = (await readJsonSafe(historyPath)) || {};
  const currentSnapshots = Array.isArray(currentHistoryRaw.snapshots)
    ? currentHistoryRaw.snapshots
    : [];

  const newEntry = toHistoryEntry(snapshot);
  const withoutExactDuplicate = currentSnapshots.filter(
    (entry) => String(entry.generatedAt || '') !== String(newEntry.generatedAt || '')
  );
  const mergedSnapshots = [...withoutExactDuplicate, newEntry]
    .sort(sortSnapshotsByDateAsc)
    .slice(-cfg.historyLimit);

  const historyPayload = {
    updatedAt: snapshot.generatedAt,
    snapshots: mergedSnapshots,
  };

  await fs.writeFile(latestPath, JSON.stringify(snapshot));
  await fs.writeFile(historyPath, JSON.stringify(historyPayload));

  const [latestStat, historyStat] = await Promise.all([
    fs.stat(latestPath),
    fs.stat(historyPath),
  ]);

  console.log(`Holder snapshot written: ${latestPath} (${(latestStat.size / 1024).toFixed(1)} KB)`);
  console.log(`Holder history written: ${historyPath} (${(historyStat.size / 1024).toFixed(1)} KB)`);
  console.log(
    `Holders: ${snapshot.summary.holderCount} | Supply accounted: ${snapshot.summary.supplyAccounted}`
  );
}

main().catch((err) => {
  console.error('Holder snapshot build failed:', err);
  process.exit(1);
});
