// URL / curl request policy helpers.
//
// Shared between audit analysis (src/audit-analyze.mjs) and the live hook
// policy (src/hook-policy.mjs) to classify curl commands and the URLs they
// hit — deciding when to suggest `tl browse` over a raw fetch.
//
// NOTE: src/opencode-plugin.js intentionally keeps its own copies of these
// helpers. It is copied verbatim into the user's Open Code plugin directory
// and must stay self-contained (no imports from this repo).

export function extractHttpUrl(command) {
  return String(command || '').match(/https?:\/\/[^\s"'<>|)]+/)?.[0] || null;
}

export function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

export function isApiLikeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return isLocalOrPrivateHost(host)
      || host.startsWith('api.')
      || path === '/api'
      || path.startsWith('/api/')
      || path === '/graphql'
      || path.startsWith('/graphql/');
  } catch {
    return true;
  }
}

export function hasApiCurlOptions(command) {
  return /(?:^|\s)(?:-[XHI]|--request|--header|--data(?:-[\w-]+)?|-d|--include|--head)\b/i.test(command);
}
