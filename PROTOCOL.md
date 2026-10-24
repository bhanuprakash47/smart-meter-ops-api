# Urja Meter Ops Portal - Reverse-Engineered Protocol Documentation

This document provides a comprehensive technical breakdown of the reverse-engineered internal protocol, authentication mechanics, hidden endpoints, and data anomalies discovered on the legacy **Urja Meter Ops Portal** (`https://urja-ops.flockenergy.tech`).

---

## 1. System Overview & Technology Stack

The Urja Meter Ops Portal is a utility smart meter management interface built on **SvelteKit** with client-side hydration (`_app/immutable/*` chunks) communicating with internal server-rendered form actions and JSON endpoints under `/portal/*`.

* **Base URL**: `https://urja-ops.flockenergy.tech`
* **Default Operator Credentials**:
  * Username / Email: `operator@urja.local`
  * Password: `urja-ops-2026`
* **Dataset Scope**:
  * **403 Smart Meters** across multiple manufacturers (HPL, L&T, Genus, Allied, Secure)
  * **40 Distribution Transformers (DTs)** spanning Jaipur distribution zones

---

## 2. Authentication & Session Management

Authentication is managed via a SvelteKit form action that establishes an HTTP cookie session (`__Secure-better-auth.session_token`).

### 2.1 Login Request Flow

* **Method**: `POST`
* **URL**: `/login`
* **Content-Type**: `application/x-www-form-urlencoded`
* **Headers Required**:
  ```http
  Origin: https://urja-ops.flockenergy.tech
  Referer: https://urja-ops.flockenergy.tech/login
  x-sveltekit-action: true
  Accept: application/json
  ```
* **Payload**:
  ```text
  email=operator%40urja.local&username=operator%40urja.local&password=urja-ops-2026
  ```

### 2.2 Session Persistence & Token Handling

* Upon valid authentication, the server responds with a `302/303 Redirect` or `200 OK` carrying:
  ```http
  Set-Cookie: __Secure-better-auth.session_token=<SESSION_UUID>; Path=/; HttpOnly; Secure; SameSite=Lax
  ```
* All subsequent requests must include the `Cookie: __Secure-better-auth.session_token=<SESSION_UUID>` header.
* **Auto-Reauthentication**: If a session expires (resulting in HTTP `401 Unauthorized` or redirect to `/login`), the client transparently re-authenticates and retries the upstream request.

---

## 3. Discovered Internal Endpoints

While the user interface presents paginated HTML tables across 21 pages, deep inspection of the SvelteKit network traffic and client bundles revealed high-performance internal JSON APIs.

### 3.1 Distribution Transformers (`/portal/dts`)

* **Method**: `GET`
* **URL**: `/portal/dts?page={page}`
* **Pagination**: 20 items per page; total 40 records across 2 pages (`page=1`, `page=2`).
* **Response Payload Schema**:
  ```json
  {
    "page": 1,
    "pageSize": 20,
    "total": 40,
    "data": [
      {
        "code": "DT-001",
        "name": "Malviya Nagar DT 1",
        "feederCode": "F-001",
        "capacityKva": "250"
      }
    ]
  }
  ```
* **Role**: Canonical asset registry for transformer definitions and canonical names.

---

### 3.2 Secret Key Retrieval (`/portal/keys`)

* **Method**: `GET`
* **URL**: `/portal/keys`
* **Response Payload Schema**:
  ```json
  {
    "status": "success",
    "data": {
      "signingSecret": "secret-signing-key-hex-or-string"
    }
  }
  ```
* **Role**: Returns a cryptographic secret key required to sign bulk meter export requests.

---

### 3.3 Signed Bulk Meter Export (`/portal/export`)

Instead of scraping 21 paginated HTML tables, the portal provides a high-throughput bulk export endpoint used by the "Export all meters" UI button. This endpoint is protected by an HMAC-SHA256 signature verification mechanism.

* **Method**: `GET`
* **URL**: `/portal/export?page=1`
* **Custom Headers**:
  * `x-timestamp`: Unix epoch timestamp in seconds (e.g. `1792844641`).
  * `x-signature`: Lowercase hexadecimal HMAC-SHA256 digest.

#### Cryptographic Signature Reverse Engineering:
By analyzing the minified client bundle at `_app/immutable/nodes/4.2Bgc2kUI.js`, the exact canonical string format was extracted:
```javascript
const canonicalString = [method, path, query, timestamp].join('\n');
// Example: "GET\n/portal/export\npage=1\n1792844641"
const signature = crypto
  .createHmac('sha256', signingSecret)
  .update(canonicalString)
  .digest('hex');
```

* **Response Payload**:
  Returns all 403 smart meter records in a single payload, complete with full hierarchy chains, installation status, make, phase type, and geographic coordinates.

---

### 3.4 30-Minute Interval Energy Telemetry (`/portal/meters/{meterId}/energy`)

* **Method**: `GET`
* **URL**: `/portal/meters/{meterId}/energy`
* **Response Payload Schema**:
  ```json
  {
    "meterId": "MTR-001",
    "data": [
      {
        "timestamp": "24/10/2026 00:00",
        "kwh": "120.45",
        "kvah": "123.10",
        "voltR": "234"
      },
      {
        "timestamp": "24/10/2026 00:30",
        "kwh": "120.82",
        "kvah": "123.50",
        "voltR": "232"
      }
    ]
  }
  ```

---

## 4. Upstream Data Quality Issues & Normalization Rules

The raw data returned by the legacy portal contains several structural inconsistencies and legacy formatting defects. The adapter's normalizer (`src/normalizer.js`) executes automated data repairs:

### 4.1 Missing Hierarchy Fields Repair
In the raw meter `hierarchy` object, upstream records frequently omit either the `code` or `name` field for specific administrative nodes:
* **Problem**: A node contains `name: "Feeder 001"` but `code: null`, or `code: "SS-01"` with `name: null`.
* **Repair Logic**:
  * Extract numerical suffix from available property.
  * Reconstruct missing code or name using standard utility formatting rules:
    * Zone: `Z-01` / `Jaipur Zone <N>`
    * Circle: `C-01` / `Circle <N>`
    * Division: `D-01` / `Division <N>`
    * Subdivision: `SD-01` / `Subdivision <N>`
    * Substation: `SS-01` / `Substation <N>`
    * Feeder: `F-001` (3-digit zero-padded) / `Feeder <N>`
  * Record repairs in `dataQualityNotes` array for audibility.

### 4.2 Distribution Transformer Name Conflict on `DT-007`
* **Conflict**:
  * Meter hierarchy export labels `DT-007` as `"Old Malviya Nagar Xfmr"`.
  * Dedicated transformer catalog (`/portal/dts`) labels `DT-007` as `"Sanganer DT 7"`.
* **Resolution**:
  * The dedicated asset registry (`/portal/dts`) is treated as the authoritative ground truth.
  * Canonical name `"Sanganer DT 7"` is assigned to `hierarchy.dt.name`.
  * Conflicting legacy name is preserved under `hierarchy.dt.legacyName`.
  * Anomaly note recorded: `Conflicting DT name 'Old Malviya Nagar Xfmr' resolved to canonical 'Sanganer DT 7'`.

### 4.3 Timestamp Normalization
* **Problem**: Upstream telemetry uses localized DD/MM/YYYY HH:mm strings (e.g. `24/10/2026 14:30`).
* **Repair**: Converted into standard ISO-8601 UTC strings (`2026-10-24T14:30:00Z`) alongside original `rawTimestamp`.

### 4.4 Numeric Type Coercion
* **Problem**: Telemetry figures (`kwh`, `kvah`, `voltR`), capacities (`capacityKva`), and GPS coordinates (`lat`, `lng`) are returned as strings.
* **Repair**: Coerced into native IEEE-754 floats and integers for mathematical safety.
