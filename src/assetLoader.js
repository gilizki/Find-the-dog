// Loads a set of audio files: explicit URL list or a manifest.json listing the folder's files.
// Fetching needs no AudioContext, so it can start at page load; decoding happens later.

import { resolveManifest } from './samples.js';

/** Resolves to { files: [{url, bytes}], failed: [url] }. Never rejects. */
export async function fetchAssetSet({ urls = [], manifestUrl = null, label = 'audio' } = {}) {
  const base = globalThis.location?.href ?? 'http://localhost/';
  let list = urls.map((u) => new URL(u, base).href);
  if (!list.length && manifestUrl) {
    try {
      const res = await fetch(manifestUrl, { cache: 'no-cache' });
      if (res.ok) list = resolveManifest(await res.json(), manifestUrl, base);
    } catch (err) {
      console.info(`No ${label} manifest (${manifestUrl}); using procedural sound.`, err);
    }
  }
  const results = await Promise.allSettled(
    list.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { url, bytes: await res.arrayBuffer() };
    }),
  );
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push(list[i]);
      console.warn(`Could not fetch ${label} "${list[i]}":`, r.reason);
    }
  });
  return { files: results.filter((r) => r.status === 'fulfilled').map((r) => r.value), failed };
}

/**
 * Decodes fetched files and runs `process(channels, sampleRate)` on each (returning Float32Array[]
 * of channels, or null to reject). Resolves to { items: [{url, channels, sampleRate}], failed }.
 */
export async function decodeAssetSet(ctx, fetched, process, label = 'audio') {
  const items = [];
  const failed = [...fetched.failed];
  for (const { url, bytes } of fetched.files) {
    try {
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
      const out = process(channels, decoded.sampleRate);
      if (!out || !out[0] || out[0].length < decoded.sampleRate * 0.02) throw new Error('silent or too short after processing');
      items.push({ url, channels: out, sampleRate: decoded.sampleRate });
    } catch (err) {
      failed.push(url);
      console.warn(`Could not decode ${label} "${url}":`, err);
    }
  }
  return { items, failed };
}
