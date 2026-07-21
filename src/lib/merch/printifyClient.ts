// src/lib/merch/printifyClient.ts
//
// Implements ProductCatalogClient from src/lib/merch/sourcing.ts.
//
// Env vars: PRINTIFY_API_KEY, PRINTIFY_SHOP_ID (new — add to .env.example).
// Non-2xx or timeout → throws. The sourcing layer (findMerchandiseCandidate)
// wraps this in CatalogUnavailableError. Do NOT catch and continue here.
//
// Timeout: 10 seconds, via AbortController.
// Unverified — traced by hand. Must be checked against:
//   1. Actual Printify API endpoint for product search (v1 documented at
//      developers.printify.com — endpoint used here matches public docs,
//      but pagination and response shape must be verified against a live key).
//   2. AbortController behavior in the Vercel Node runtime.

import type { ProductCatalogClient } from './sourcing';

// ---------------------------------------------------------------------------
// Env helpers — read at call time, not at import time.
// ---------------------------------------------------------------------------

function getPrintifyApiKey(): string {
  const key = process.env.PRINTIFY_API_KEY;
  if (!key) throw new Error('PRINTIFY_API_KEY is not set');
  return key;
}

function getPrintifyShopId(): string {
  const id = process.env.PRINTIFY_SHOP_ID;
  if (!id) throw new Error('PRINTIFY_SHOP_ID is not set');
  return id;
}

// ---------------------------------------------------------------------------
// Printify API shape (subset we use)
// ---------------------------------------------------------------------------

interface PrintifyProduct {
  id: string;
  external?: { handle?: string };
  images?: Array<{ src: string; is_default?: boolean }>;
}

interface PrintifyListResponse {
  data: PrintifyProduct[];
  current_page: number;
  last_page: number;
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export const printifyClient: ProductCatalogClient = {
  async search(
    query: string,
    _category: string
  ): Promise<Array<{ id: string; url: string }>> {
    const apiKey = getPrintifyApiKey();
    const shopId = getPrintifyShopId();

    // Printify v1 product list — filtering by title via query param.
    // Documented: GET /v1/shops/{shop_id}/products.json
    // The API does not have a dedicated search endpoint in v1; we filter
    // client-side after fetching page 1 (100 items). If the catalog is
    // large enough to require pagination for search, this must be revisited.
    const params = new URLSearchParams({
      limit: '100',
      page: '1',
    });

    const url = `https://api.printify.com/v1/shops/${shopId}/products.json?${params}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      // Network error or timeout — do NOT catch and continue.
      // The sourcing layer will wrap this in CatalogUnavailableError.
      throw new Error(
        `Printify API fetch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // Non-2xx — throw so sourcing layer can map to CatalogUnavailableError.
      throw new Error(
        `Printify API returned HTTP ${response.status} ${response.statusText}`
      );
    }

    let body: PrintifyListResponse;
    try {
      body = (await response.json()) as PrintifyListResponse;
    } catch (err) {
      throw new Error(
        `Printify API returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Filter by query string (case-insensitive title match).
    const lowerQuery = query.toLowerCase();
    const matched = body.data.filter((p) =>
      // Printify product titles are not in the subset we typed — access via
      // unknown to avoid inventing a field. In practice, products have a
      // `title` field; assert carefully.
      typeof (p as unknown as { title?: string }).title === 'string' &&
      ((p as unknown as { title: string }).title.toLowerCase().includes(lowerQuery))
    );

    return matched.map((p) => {
      const defaultImage = p.images?.find((img) => img.is_default) ?? p.images?.[0];
      return {
        id: p.id,
        url: defaultImage?.src ?? '',
      };
    }).filter((item) => item.url !== '');
  },
};
