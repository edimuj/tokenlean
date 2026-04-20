/**
 * LRU result cache for tl-mcp HTTP daemon.
 *
 * Keys: hash of (toolName + sorted args + mtimes of any file args).
 * Only active when TL_MCP_CACHE !== '0' and used from the HTTP daemon.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

const MAX_SIZE = 256;
const DEFAULT_TTL_MS = 60_000; // 1 minute

export class McpCache {
  #map = new Map();
  #ttl;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.#ttl = ttlMs;
  }

  #evictExpired() {
    const now = Date.now();
    for (const [k, v] of this.#map) {
      if (now - v.ts > this.#ttl) this.#map.delete(k);
    }
  }

  #evictLru() {
    // Map iteration is insertion-order; first entry is oldest
    const first = this.#map.keys().next().value;
    if (first != null) this.#map.delete(first);
  }

  #filesMtime(args) {
    // Collect mtimes from any arg that looks like an existing file path
    return args
      .filter(a => typeof a === 'string' && a.length > 1 && !a.startsWith('-'))
      .map(a => {
        try { return statSync(a).mtimeMs; } catch { return 0; }
      })
      .join(':');
  }

  key(toolName, args) {
    const payload = toolName + '\0' + JSON.stringify([...args].sort()) + '\0' + this.#filesMtime(args);
    return createHash('sha1').update(payload).digest('hex');
  }

  get(k) {
    const entry = this.#map.get(k);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.#ttl) { this.#map.delete(k); return null; }
    // Promote to recently used
    this.#map.delete(k);
    this.#map.set(k, entry);
    return entry.value;
  }

  set(k, value) {
    this.#evictExpired();
    if (this.#map.size >= MAX_SIZE) this.#evictLru();
    this.#map.set(k, { value, ts: Date.now() });
  }

  get size() { return this.#map.size; }
}
