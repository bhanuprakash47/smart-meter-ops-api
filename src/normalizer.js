function pad2(num) {
  return String(num).padStart(2, '0');
}

function pad3(num) {
  return String(num).padStart(3, '0');
}

function repairHierarchyNode(node, codePrefix, padFn, namePrefix) {
  if (!node) return null;
  let name = (node.name || '').trim();
  let code = (node.code || '').trim();
  let repaired = false;

  if (!code && name) {
    const match = name.match(/(\d+)$/);
    if (match) {
      code = `${codePrefix}-${padFn(match[1])}`;
      repaired = true;
    }
  }

  if (!name && code) {
    const match = code.match(/(\d+)$/);
    if (match) {
      name = `${namePrefix} ${parseInt(match[1], 10)}`;
      repaired = true;
    }
  }

  return {
    code: code || null,
    name: name || null,
    ...(repaired ? { _repaired: true } : {}),
  };
}

function normalizeMeter(raw, canonicalDtMap = new Map()) {
  const h = raw.hierarchy || null;
  const canonicalDt = canonicalDtMap.get(raw.dtCode);

  let normalizedHierarchy = null;
  const anomalies = [];

  if (h) {
    const zone = repairHierarchyNode(h.zone, 'Z', pad2, 'Jaipur Zone');
    const circle = repairHierarchyNode(h.circle, 'C', pad2, 'Circle');
    const division = repairHierarchyNode(h.division, 'D', pad2, 'Division');
    const subdivision = repairHierarchyNode(h.subdivision, 'SD', pad2, 'Subdivision');
    const substation = repairHierarchyNode(h.substation, 'SS', pad2, 'Substation');
    const feeder = repairHierarchyNode(h.feeder, 'F', pad3, 'Feeder');

    for (const [level, obj] of Object.entries({ zone, circle, division, subdivision, substation, feeder })) {
      if (obj?._repaired) {
        anomalies.push(`Repaired missing field in hierarchy.${level}`);
        delete obj._repaired;
      }
    }

    const rawDtName = h.dt?.name?.trim() || null;
    const canonicalDtName = canonicalDt?.name || rawDtName;
    const hasDtNameConflict = Boolean(rawDtName && canonicalDtName && rawDtName !== canonicalDtName);

    if (hasDtNameConflict) {
      anomalies.push(`Conflicting DT name '${rawDtName}' resolved to canonical '${canonicalDtName}'`);
    }

    normalizedHierarchy = {
      zone,
      circle,
      division,
      subdivision,
      substation,
      feeder,
      dt: {
        code: h.dt?.code || raw.dtCode || null,
        name: canonicalDtName,
        ...(hasDtNameConflict ? { legacyName: rawDtName } : {}),
      },
    };
  }

  return {
    meterId: raw.meterId,
    serialNo: raw.serialNo,
    make: raw.make,
    phaseType: raw.phaseType,
    installStatus: raw.installStatus,
    installType: raw.installType || null,
    build: raw.build || null,
    dtCode: raw.dtCode || null,
    hierarchy: normalizedHierarchy,
    geo: raw.geo
      ? {
          lat: Number(raw.geo.lat),
          lng: Number(raw.geo.lng),
        }
      : null,
    ...(anomalies.length > 0 ? { dataQualityNotes: anomalies } : {}),
  };
}

function parsePortalTimestamp(tsStr) {
  if (!tsStr) return null;
  const match = tsStr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) return tsStr;
  const [, day, month, year, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:00Z`;
}

function normalizeEnergyReading(reading) {
  return {
    timestamp: parsePortalTimestamp(reading.timestamp),
    rawTimestamp: reading.timestamp,
    kwh: Number.parseFloat(reading.kwh),
    kvah: Number.parseFloat(reading.kvah),
    voltR: Number.parseInt(reading.voltR, 10),
  };
}

module.exports = {
  normalizeMeter,
  normalizeEnergyReading,
};