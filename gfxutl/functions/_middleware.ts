const CANONICAL_ORIGIN = "https://gfxutl.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface PagesMiddlewareContext {
  request: Request;
  next(): Promise<Response>;
}

/** Returns the canonical destination, or null when the request may continue. */
export function canonicalLocation(requestUrl: string) {
  const source = new URL(requestUrl);
  if (source.hostname === "gfxutl.com" || LOCAL_HOSTS.has(source.hostname)) return null;
  return `${CANONICAL_ORIGIN}${source.pathname}${source.search}`;
}

/** Cloudflare Pages middleware: runs before every static asset and SPA route. */
export async function onRequest(context: PagesMiddlewareContext) {
  const location = canonicalLocation(context.request.url);
  return location ? Response.redirect(location, 308) : context.next();
}
