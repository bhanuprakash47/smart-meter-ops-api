const express = require('express');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const portalClient = require('./client');
const openApiSpec = require('../openapi.json');

const app = express();
app.use(express.json());

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/openapi.json', (req, res) => res.json(openApiSpec));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    upstream: config.portal.baseUrl,
    cache: {
      syncedMeters: portalClient.cache.meters.length,
      syncedTransformers: portalClient.cache.transformers.length,
      lastSyncedAt: portalClient.cache.lastSyncedAt
        ? new Date(portalClient.cache.lastSyncedAt).toISOString()
        : null,
    },
  });
});

app.post('/api/v1/sync', async (req, res, next) => {
  try {
    const cache = await portalClient.ensureSynced(true);
    res.json({
      message: 'Synced dataset from Urja Meter Ops Portal',
      totalMeters: cache.meters.length,
      totalTransformers: cache.transformers.length,
      syncedAt: new Date(cache.lastSyncedAt).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/meters', async (req, res, next) => {
  try {
    const {
      q = '',
      make,
      phaseType,
      installStatus,
      installType,
      build,
      dtCode,
      feederCode,
      substationCode,
      zoneCode,
      page = 1,
      pageSize = 20,
      refresh = 'false',
    } = req.query;

    const cache = await portalClient.ensureSynced(refresh === 'true');
    let results = cache.meters;

    if (q) {
      const needle = q.trim().toLowerCase();
      results = results.filter(
        (m) =>
          m.meterId.toLowerCase().includes(needle) ||
          m.serialNo.toLowerCase().includes(needle)
      );
    }
    if (make) {
      results = results.filter((m) => m.make.toLowerCase() === make.toLowerCase());
    }
    if (phaseType) {
      results = results.filter((m) => m.phaseType.toLowerCase() === phaseType.toLowerCase());
    }
    if (installStatus) {
      results = results.filter(
        (m) => m.installStatus.toLowerCase() === installStatus.toLowerCase()
      );
    }
    if (installType) {
      results = results.filter(
        (m) => (m.installType || '').toLowerCase() === installType.toLowerCase()
      );
    }
    if (build) {
      results = results.filter((m) => (m.build || '').toLowerCase() === build.toLowerCase());
    }
    if (dtCode) {
      results = results.filter((m) => (m.dtCode || '').toUpperCase() === dtCode.toUpperCase());
    }
    if (feederCode) {
      results = results.filter(
        (m) => (m.hierarchy?.feeder?.code || '').toUpperCase() === feederCode.toUpperCase()
      );
    }
    if (substationCode) {
      results = results.filter(
        (m) =>
          (m.hierarchy?.substation?.code || '').toUpperCase() === substationCode.toUpperCase()
      );
    }
    if (zoneCode) {
      results = results.filter(
        (m) => (m.hierarchy?.zone?.code || '').toUpperCase() === zoneCode.toUpperCase()
      );
    }

    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limit = Math.min(500, Math.max(1, Number.parseInt(pageSize, 10) || 20));
    const start = (pageNum - 1) * limit;
    const paginated = results.slice(start, start + limit);

    res.json({
      total: results.length,
      page: pageNum,
      pageSize: limit,
      totalPages: Math.ceil(results.length / limit),
      data: paginated,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/meters/:meterId', async (req, res, next) => {
  try {
    const cache = await portalClient.ensureSynced();
    const meter = cache.metersById.get(req.params.meterId.toUpperCase());

    if (!meter) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Meter '${req.params.meterId}' does not exist`,
      });
    }

    const response = { ...meter };
    if (req.query.includeEnergy === 'true') {
      const energy = await portalClient.getMeterEnergy(meter.meterId);
      response.energy = energy;
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/meters/:meterId/energy', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const result = await portalClient.getMeterEnergy(req.params.meterId, { from, to });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/transformers', async (req, res, next) => {
  try {
    const { feederCode, capacityKva, page = 1, pageSize = 40 } = req.query;
    const cache = await portalClient.ensureSynced();
    let results = cache.transformers;

    if (feederCode) {
      results = results.filter(
        (dt) => dt.feederCode.toUpperCase() === feederCode.toUpperCase()
      );
    }
    if (capacityKva) {
      results = results.filter((dt) => dt.capacityKva === Number(capacityKva));
    }

    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 40));
    const start = (pageNum - 1) * limit;

    res.json({
      total: results.length,
      page: pageNum,
      pageSize: limit,
      totalPages: Math.ceil(results.length / limit),
      data: results.slice(start, start + limit),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/transformers/:dtCode', async (req, res, next) => {
  try {
    const cache = await portalClient.ensureSynced();
    const dt = cache.transformersByCode.get(req.params.dtCode.toUpperCase());

    if (!dt) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Distribution Transformer '${req.params.dtCode}' does not exist`,
      });
    }

    const meters = cache.meters.filter((m) => m.dtCode === dt.code);
    res.json({
      ...dt,
      meters,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/v1/network/summary', async (req, res, next) => {
  try {
    const cache = await portalClient.ensureSynced();
    const repairedMeters = cache.meters.filter((m) => m.dataQualityNotes?.length > 0);

    const byStatus = {};
    const byMake = {};
    const byPhase = {};

    for (const m of cache.meters) {
      byStatus[m.installStatus] = (byStatus[m.installStatus] || 0) + 1;
      byMake[m.make] = (byMake[m.make] || 0) + 1;
      byPhase[m.phaseType] = (byPhase[m.phaseType] || 0) + 1;
    }

    res.json({
      totalMeters: cache.meters.length,
      totalTransformers: cache.transformers.length,
      breakdown: {
        byStatus,
        byMake,
        byPhase,
      },
      dataQualityRepairs: {
        repairedRecordCount: repairedMeters.length,
        records: repairedMeters.map((m) => ({
          meterId: m.meterId,
          notes: m.dataQualityNotes,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  const status = err.status || 502;
  res.status(status).json({
    error: status === 404 ? 'NotFound' : 'UpstreamPortalError',
    message: err.message || 'Unexpected error communicating with Urja Meter Ops Portal',
  });
});

if (require.main === module) {
  app.listen(config.port, function() {
    console.log('Urja Meter Ops API running on http://localhost:' + config.port);
    console.log('Interactive OpenAPI docs available at http://localhost:' + config.port + '/docs');
  });
}

module.exports = app;
