import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export class SafeHttpError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SafeHttpError';
    this.code = code;
    Object.assign(this, details);
  }
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function ipv4InRange(value, base, prefix) {
  const shift = 32 - prefix;
  return (value >>> shift) === (base >>> shift);
}

function isPublicIpv4(address) {
  const value = ipv4Number(address);
  if (value === null) return false;

  // Only globally-routable unicast addresses are allowed. This includes
  // private, loopback, link-local, shared, documentation, benchmarking,
  // multicast, and reserved ranges.
  const blocked = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ];

  return !blocked.some(([base, prefix]) => ipv4InRange(value, ipv4Number(base), prefix));
}

function expandIpv6(address) {
  let source = address.toLowerCase();
  const zoneIndex = source.indexOf('%');
  if (zoneIndex !== -1) return null;

  let embeddedIpv4 = null;
  const lastColon = source.lastIndexOf(':');
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4 = ipv4Number(tail);
    if (ipv4 === null) return null;
    embeddedIpv4 = tail;
    source = `${source.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;

  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(parseInt(group, 16));
  return { value, groups: groups.map(group => parseInt(group, 16)), embeddedIpv4 };
}

function ipv6InRange(value, base, prefix) {
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (base >> shift);
}

function ipv6Value(address) {
  return expandIpv6(address)?.value ?? null;
}

function isPublicIpv6(address) {
  const parsed = expandIpv6(address);
  if (!parsed) return false;
  const { value, groups } = parsed;

  // IPv4-mapped addresses inherit the underlying IPv4 policy.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`;
    return isPublicIpv4(mapped);
  }

  // Globally-routable IPv6 unicast currently occupies 2000::/3. Exclude
  // transition and documentation ranges that can encode non-public targets.
  const globalBase = ipv6Value('2000::');
  if (!ipv6InRange(value, globalBase, 3)) return false;

  const blocked = [
    ['2001::', 32],       // Teredo
    ['2001:2::', 48],    // benchmarking
    ['2001:db8::', 32],  // documentation
    ['2002::', 16],      // 6to4
    ['3fff::', 20]       // documentation
  ];
  return !blocked.some(([base, prefix]) => ipv6InRange(value, ipv6Value(base), prefix));
}

export function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function normalizeHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isInternalHostname(hostname) {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  return lower === 'localhost'
    || lower.endsWith('.localhost')
    || lower.endsWith('.local')
    || lower.endsWith('.internal')
    || lower.endsWith('.home.arpa')
    || lower === 'metadata.google.internal';
}

export async function resolvePublicTarget(rawUrl, { lookup = dns.promises.lookup } = {}) {
  let url;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
  } catch {
    throw new SafeHttpError('INVALID_URL', `Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeHttpError('UNSUPPORTED_PROTOCOL', `Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SafeHttpError('URL_CREDENTIALS', 'URLs containing credentials are not allowed');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isInternalHostname(hostname)) {
    throw new SafeHttpError('PRIVATE_ADDRESS', 'Blocked: cannot fetch private/internal network addresses');
  }

  let addresses;
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new SafeHttpError('DNS_FAILED', `DNS resolution failed for ${hostname}`, { cause: error });
    }
  }

  if (!addresses.length) {
    throw new SafeHttpError('DNS_FAILED', `DNS resolution returned no addresses for ${hostname}`);
  }
  const unsafe = addresses.find(({ address }) => !isPublicIp(address));
  if (unsafe) {
    throw new SafeHttpError(
      'PRIVATE_ADDRESS',
      `Blocked: ${hostname} resolves to a private or non-public address`,
      { address: unsafe.address }
    );
  }

  return { url, hostname, addresses, pinned: addresses[0] };
}

function responseHeaders(response) {
  const headers = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

function decodedStream(response, encoding) {
  if (!encoding || encoding === 'identity') return response;
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  throw new SafeHttpError('UNSUPPORTED_ENCODING', `Unsupported content encoding: ${encoding}`);
}

async function readBody(response, maxBodyBytes) {
  const contentLength = Number(response.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new SafeHttpError('BODY_TOO_LARGE', `Response exceeds the ${maxBodyBytes}-byte limit`);
  }

  const stream = decodedStream(response, String(response.headers['content-encoding'] || '').toLowerCase());
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) {
      response.destroy();
      throw new SafeHttpError('BODY_TOO_LARGE', `Response exceeds the ${maxBodyBytes}-byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function requestPinned(target, { headers = {}, deadline, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const client = target.url.protocol === 'https:' ? https : http;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const request = client.get(target.url, {
      headers,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [target.pinned]);
        else callback(null, target.pinned.address, target.pinned.family);
      }
    }, async response => {
      const normalizedHeaders = responseHeaders(response);
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        response.destroy();
        finish(null, {
          status: response.statusCode,
          statusText: response.statusMessage || '',
          headers: normalizedHeaders,
          body: ''
        });
        return;
      }

      try {
        const body = await readBody(response, maxBodyBytes);
        finish(null, {
          status: response.statusCode,
          statusText: response.statusMessage || '',
          headers: normalizedHeaders,
          body
        });
      } catch (error) {
        request.destroy();
        finish(error);
      }
    });

    const timer = setTimeout(() => {
      request.destroy(new SafeHttpError('TIMEOUT', `Request timed out after ${remaining}ms`));
    }, remaining);
    request.on('error', error => finish(error));
  });
}

export async function fetchPublicText(rawUrl, {
  headers = {},
  timeout = 15000,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  resolveTarget = resolvePublicTarget,
  request = requestPinned
} = {}) {
  const deadline = Date.now() + timeout;
  let current = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);

  for (let redirects = 0; ; redirects++) {
    if (Date.now() >= deadline) {
      throw new SafeHttpError('TIMEOUT', `Request timed out after ${timeout}ms`);
    }

    // Resolution and validation happen for every hop. The exact validated
    // address is then pinned into the socket lookup performed by request().
    const target = await resolveTarget(current);
    const response = await request(target, { headers, deadline, maxBodyBytes });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { ...response, url: current.toString(), redirects };
    }

    const location = response.headers.location;
    if (!location) {
      throw new SafeHttpError('INVALID_REDIRECT', `HTTP ${response.status} response is missing a Location header`);
    }
    if (redirects >= maxRedirects) {
      throw new SafeHttpError('TOO_MANY_REDIRECTS', `Too many redirects (maximum ${maxRedirects})`);
    }

    try {
      current = new URL(location, current);
    } catch {
      throw new SafeHttpError('INVALID_REDIRECT', `Invalid redirect URL: ${location}`);
    }
  }
}
