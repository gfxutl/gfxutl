import { expect, test } from "@playwright/test";

test("Cloudflare Pages hosts redirect permanently to gfxutl.com", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const routing = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only module URL during the test.
    const { canonicalLocation, onRequest } = await import("/functions/_middleware.ts");
    const production = canonicalLocation("https://gfxutl.pages.dev/project/open?frame=42");
    const preview = canonicalLocation("https://feature-123.gfxutl.pages.dev/editor?mode=preview");
    const canonical = canonicalLocation("https://gfxutl.com/project/open?frame=42");
    const local = canonicalLocation("http://127.0.0.1:4173/project/open");
    let continued = false;
    const redirect = await onRequest({
      request: new Request("https://gfxutl.pages.dev/project/open?frame=42"),
      next: async () => { continued = true; return new Response("next"); },
    });
    return {
      production,
      preview,
      canonical,
      local,
      status: redirect.status,
      location: redirect.headers.get("location"),
      continued,
    };
  });

  expect(routing).toEqual({
    production: "https://gfxutl.com/project/open?frame=42",
    preview: "https://gfxutl.com/editor?mode=preview",
    canonical: null,
    local: null,
    status: 308,
    location: "https://gfxutl.com/project/open?frame=42",
    continued: false,
  });
});
