# Reflection

### 1. What assumptions did you make?
I assumed that the 403-meter dataset and 40 Distribution Transformers change relatively infrequently (typical of utility asset registries), making an in-memory cache with a 5-minute TTL (and an explicit `POST /api/v1/sync` endpoint) the right balance between freshness and low latency. I also assumed that `/portal/dts` is the canonical source of truth for Distribution Transformer names when resolving the naming conflict on `DT-007` (`"Sanganer DT 7"` vs `"Old Malviya Nagar Xfmr"`).

### 2. Which part was the most difficult, and how did you get unstuck?
The trickiest part was figuring out how the bulk export endpoint (`/portal/export?page=1`) validated requests. Inspecting the Network tab showed two custom headers—`X-Timestamp` and `X-Signature`—alongside a prior call to `/portal/keys` that returned a `signingSecret`. To get unstuck without guessing the hash input order, I searched the loaded SvelteKit client chunks in DevTools for `X-Signature`, located the minified signing function in `_app/immutable/nodes/4.2Bgc2kUI.js`, and confirmed it computed an HMAC-SHA256 over `[method, path, query, timestamp].join('\n')`.

### 3. If you had another day, what would you improve?
I would add a persistent SQLite cache layer with background polling for meter energy telemetry so cross-meter analytical queries (e.g., "total kWh load per Distribution Transformer over the last 24 hours") could be served instantaneously without fan-out requests to `/portal/meters/{id}/energy`. I would also add automated integration tests with mocked upstream portal responses and rate-limiting middleware.

### 4. What mistake did you make while solving this?
Initially, I approached the portal assuming I would need to scrape HTML tables across all 21 pages using Cheerio. Once I inspected the Network tab during page transitions and the "Export all meters" action, I realized the app was a SvelteKit frontend talking to internal JSON endpoints (`/portal/*`). Pivoting from HTML scraping to reverse-engineering the signed `/portal/export` endpoint made the service faster, cleaner, and richer in metadata.

### 5. If you were reviewing your own submission, what would you criticise?
In-memory caching works well for a single-instance service with 403 meters, but it is stateful and per-process. Furthermore, while meter metadata is fetched in bulk via `/portal/export`, energy readings still require per-meter upstream requests on cache miss. A production reviewer would also point out the lack of unit tests for the hierarchy normalizer and HMAC signing logic.
