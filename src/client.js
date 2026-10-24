const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');
const { normalizeMeter, normalizeEnergyReading } = require('./normalizer');

class UrjaPortalClient {
  constructor() {
    this.baseUrl = config.portal.baseUrl;
    this.cookies = new Map();
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': 'UrjaMeterOps-API-Adapter/1.0',
      },
    });

    this.cache = {
      lastSyncedAt: 0,
      meters: [],
      metersById: new Map(),
      transformers: [],
      transformersByCode: new Map(),
      energyByMeterId: new Map(),
    };
  }

  _storeCookies(setCookieHeader) {
    if (!setCookieHeader) return;
    const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of list) {
      const [nameValue] = raw.split(';');
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx > 0) {
        const name = nameValue.slice(0, eqIdx).trim();
        const val = nameValue.slice(eqIdx + 1).trim();
        if (val) {
          this.cookies.set(name, val);
        } else {
          this.cookies.delete(name);
        }
      }
    }
  }

  _getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async login() {
    const params = new URLSearchParams();
    params.append('email', config.portal.username);
    params.append('username', config.portal.username);
    params.append('password', config.portal.password);

    const response = await this.http.post('/login', params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/login`,
        Accept: 'application/json',
        'x-sveltekit-action': 'true',
      },
    });

    this._storeCookies(response.headers['set-cookie']);

    if (this.cookies.size === 0) {
      throw new Error('Authentication failed: No session cookie returned by portal');
    }
    return true;
  }

  _signRequest(method, path, query, signingSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonical = [method, path, query, timestamp].join('\n');
    const signature = crypto
      .createHmac('sha256', signingSecret)
      .update(canonical)
      .digest('hex');

    return { timestamp, signature };
  }

  async requestJson(path, options = {}, retried = false) {
    if (this.cookies.size === 0) {
      await this.login();
    }

    try {
      const response = await this.http.get(path, {
        ...options,
        headers: {
          Accept: 'application/json',
          Cookie: this._getCookieHeader(),
          ...(options.headers || {}),
        },
      });

      this._storeCookies(response.headers['set-cookie']);

      if (response.status === 302 || response.status === 303) {
        if (retried) throw new Error(`Redirected on ${path} after re-authentication`);
        this.cookies.clear();
        await this.login();
        return this.requestJson(path, options, true);
      }

      return response.data;
    } catch (err) {
      const status = err.response?.status;
      if ((status === 401 || status === 403) && !retried) {
        this.cookies.clear();
        await this.login();
        return this.requestJson(path, options, true);
      }
      const upstreamError = new Error(
        `Upstream portal error on ${path}: ${status || err.message}`
      );
      upstreamError.status = status === 404 ? 404 : 502;
      throw upstreamError;
    }
  }

  async fetchAllTransformers() {
    const firstPage = await this.requestJson('/portal/dts?page=1');
    const allDts = [...(firstPage.data || [])];
    const total = firstPage.total || allDts.length;
    const pageSize = firstPage.pageSize || 20;
    const totalPages = Math.ceil(total / pageSize);

    for (let page = 2; page <= totalPages; page++) {
      const next = await this.requestJson(`/portal/dts?page=${page}`);
      if (next.data) allDts.push(...next.data);
    }

    return allDts;
  }

  async fetchBulkMeters() {
    const keysRes = await this.requestJson('/portal/keys');
    const signingSecret = keysRes?.data?.signingSecret;
    if (!signingSecret) {
      throw new Error('Failed to retrieve signingSecret from /portal/keys');
    }

    const query = 'page=1';
    const { timestamp, signature } = this._signRequest(
      'GET',
      '/portal/export',
      query,
      signingSecret
    );

    const exportRes = await this.requestJson(`/portal/export?${query}`, {
      headers: {
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
    });

    return exportRes.data || [];
  }

  async ensureSynced(force = false) {
    const isFresh =
      !force &&
      this.cache.meters.length > 0 &&
      Date.now() - this.cache.lastSyncedAt < config.cacheTtlMs;

    if (isFresh) return this.cache;

    const rawDts = await this.fetchAllTransformers();
    const dtMap = new Map();
    for (const dt of rawDts) {
      dtMap.set(dt.code, dt);
    }

    const rawMeters = await this.fetchBulkMeters();
    const normalizedMeters = rawMeters.map((m) => normalizeMeter(m, dtMap));

    const metersById = new Map();
    for (const m of normalizedMeters) {
      metersById.set(m.meterId.toUpperCase(), m);
    }

    const enrichedTransformers = rawDts.map((dt) => {
      const connected = normalizedMeters.filter((m) => m.dtCode === dt.code);
      return {
        code: dt.code,
        name: dt.name,
        feederCode: dt.feederCode,
        capacityKva: Number(dt.capacityKva),
        meterCounts: {
          total: connected.length,
          installed: connected.filter((m) => m.installStatus === 'Installed').length,
          faulty: connected.filter((m) => m.installStatus === 'Faulty').length,
          decommissioned: connected.filter((m) => m.installStatus === 'Decommissioned').length,
        },
      };
    });

    const transformersByCode = new Map();
    for (const dt of enrichedTransformers) {
      transformersByCode.set(dt.code.toUpperCase(), dt);
    }

    this.cache.lastSyncedAt = Date.now();
    this.cache.meters = normalizedMeters;
    this.cache.metersById = metersById;
    this.cache.transformers = enrichedTransformers;
    this.cache.transformersByCode = transformersByCode;

    return this.cache;
  }

  async getMeterEnergy(meterId, { from, to } = {}) {
    await this.ensureSynced();
    const key = meterId.toUpperCase();
    if (!this.cache.metersById.has(key)) {
      const err = new Error(`Meter '${meterId}' not found`);
      err.status = 404;
      throw err;
    }

    const canonicalId = this.cache.metersById.get(key).meterId;
    let readings;

    const cachedEnergy = this.cache.energyByMeterId.get(canonicalId);
    if (cachedEnergy && Date.now() - cachedEnergy.fetchedAt < config.cacheTtlMs) {
      readings = cachedEnergy.readings;
    } else {
      const res = await this.requestJson(`/portal/meters/${canonicalId}/energy`);
      readings = (res.data || []).map(normalizeEnergyReading);
      this.cache.energyByMeterId.set(canonicalId, {
        fetchedAt: Date.now(),
        readings,
      });
    }

    let filtered = readings;
    if (from) {
      const fromTime = new Date(from).getTime();
      if (!Number.isNaN(fromTime)) {
        filtered = filtered.filter((r) => new Date(r.timestamp).getTime() >= fromTime);
      }
    }
    if (to) {
      const toTime = new Date(to).getTime();
      if (!Number.isNaN(toTime)) {
        filtered = filtered.filter((r) => new Date(r.timestamp).getTime() <= toTime);
      }
    }

    let summary = null;
    if (filtered.length > 0) {
      const first = filtered[0];
      const last = filtered[filtered.length - 1];
      const volts = filtered.map((r) => r.voltR).filter((v) => !Number.isNaN(v));
      summary = {
        readingCount: filtered.length,
        startTimestamp: first.timestamp,
        endTimestamp: last.timestamp,
        startKwh: first.kwh,
        endKwh: last.kwh,
        consumedKwh: Number((last.kwh - first.kwh).toFixed(2)),
        voltageStats: {
          minVoltR: Math.min(...volts),
          maxVoltR: Math.max(...volts),
          avgVoltR: Number((volts.reduce((a, b) => a + b, 0) / volts.length).toFixed(1)),
        },
      };
    }

    return {
      meterId: canonicalId,
      summary,
      data: filtered,
    };
  }
}

module.exports = new UrjaPortalClient();
