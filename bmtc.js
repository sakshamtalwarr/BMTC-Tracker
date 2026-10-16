/**
 * BMTC 2.0 Live Bus Tracker & ETA Engine
 * Directly connects to Bengaluru's production transit feeds (Chalo / Zophop & CRTS WebSocket)
 */

const BASE_URL = 'https://production.zophop.com';
const SOCKET_URL = 'wss://crtslb.chalo.com/products/live/partitions/0/?EIO=3&transport=websocket';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// In-memory cache for route catalogue to avoid refetching on every single request
let cachedRoutes = null;
let lastRoutesFetch = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Haversine formula to compute distance in km between two GPS coordinates
 */
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Fetch all available BMTC routes for today
 */
async function getAllRoutes() {
  const now = Date.now();
  if (cachedRoutes && now - lastRoutesFetch < CACHE_TTL_MS) {
    return cachedRoutes;
  }

  const today = DAYS[new Date().getDay()];
  const res = await fetch(`${BASE_URL}/scheduler_v4/v4/bengaluru/autocomplete/route?day=${today}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch routes: HTTP ${res.status}`);
  }

  const routes = await res.json();
  cachedRoutes = Array.isArray(routes) ? routes : [];
  lastRoutesFetch = now;
  return cachedRoutes;
}

/**
 * Search routes by query (e.g. "KIA-7A", "500-D", "335-E")
 */
async function searchRoute(routetext) {
  const all = await getAllRoutes();
  const q = routetext.trim().toUpperCase();

  // Exact matches first, then prefix/partial matches
  const exact = all.filter((r) => r.route_name.toUpperCase() === q);
  if (exact.length > 0) return exact;

  return all.filter((r) => r.route_name.toUpperCase().includes(q));
}

/**
 * Search bus stops by name
 */
async function searchBusStop(query) {
  const all = await getAllRoutes();
  const q = query.trim().toLowerCase();
  const stopsMap = new Map();

  for (const r of all) {
    if (r.first_stop_name && r.first_stop_name.toLowerCase().includes(q)) {
      stopsMap.set(r.first_stop_name, { name: r.first_stop_name });
    }
    if (r.last_stop_name && r.last_stop_name.toLowerCase().includes(q)) {
      stopsMap.set(r.last_stop_name, { name: r.last_stop_name });
    }
  }

  return Array.from(stopsMap.values());
}

/**
 * Fetch detailed stops and polylines for route IDs
 */
async function getRouteDetails(routeIds) {
  const vMap = {};
  routeIds.forEach((id) => (vMap[id] = 0));

  const res = await fetch(
    `${BASE_URL}/scheduler_v4/v5/bengaluru/routedetails?isBackgroundSync=false`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeIdsToVersionMap: vMap }),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch route details: HTTP ${res.status}`);
  }

  const json = await res.json();
  return json.routes || [];
}

/**
 * Query live active buses for given route IDs via CRTS WebSocket
 */
async function fetchLiveBuses(routeIds) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(SOCKET_URL);
    } catch (e) {
      console.error('WebSocket init error:', e);
      return resolve([]);
    }

    const buses = [];
    let pending = routeIds.length;

    // Timeout safety: resolve whatever received in 3.5 seconds
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch (_) {}
      resolve(buses);
    }, 3500);

    ws.onmessage = (event) => {
      const msg = typeof event.data === 'string' ? event.data : '';
      if (msg.startsWith('0')) {
        // Engine.IO handshake completed, send "once" snapshot for all variants
        routeIds.forEach((rid) => {
          const payload = JSON.stringify({ requestId: `req_${rid}`, ref: `routes:${rid}` });
          ws.send(`42["once",${JSON.stringify(payload)}]`);
        });
      } else if (msg.startsWith('42["message"')) {
        try {
          const parsed = JSON.parse(msg.slice(2));
          const body = JSON.parse(parsed[1]);
          if (body.res && typeof body.res === 'object') {
            const currentRouteId = body.ref ? body.ref.replace('routes:', '') : '';
            Object.values(body.res).forEach((rawBus) => {
              const b = typeof rawBus === 'string' ? JSON.parse(rawBus) : rawBus;
              if (b.vNo && b._latitude && b._longitude) {
                buses.push({
                  routeId: currentRouteId,
                  vehicleNumber: b.vNo,
                  lat: b._latitude,
                  lon: b._longitude,
                  bearing: b.bearing || 0,
                  isHalted: !!b._isHalted,
                  eta: b.eta || 0,
                  lastStopId: b.lSId || '',
                  timestamp: b.tS || Date.now(),
                  lastUpdated: b.tS ? new Date(b.tS).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Live',
                });
              }
            });
          }
        } catch (e) {
          console.error('Socket message parse error:', e.message);
        }

        pending--;
        if (pending <= 0) {
          clearTimeout(timer);
          try {
            ws.close();
          } catch (_) {}
          resolve(buses);
        }
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket connection error:', err?.message || err);
      clearTimeout(timer);
      resolve(buses);
    };
  });
}

/**
 * Given a live bus coordinate, find the closest stop along the route
 */
function findClosestStop(busLat, busLon, stops) {
  let minDistance = Infinity;
  let closestStop = null;
  let closestIndex = -1;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const dist = haversineDistanceKm(busLat, busLon, stop.stop_lat, stop.stop_lon);
    if (dist < minDistance) {
      minDistance = dist;
      closestStop = stop;
      closestIndex = i;
    }
  }

  return { stop: closestStop, distanceKm: minDistance, stopIndex: closestIndex };
}

/**
 * Main tracking function: Get live tracking summary for a route (e.g. "KIA-7A")
 */
async function trackBus(routeQuery, targetStopName = null) {
  const matched = await searchRoute(routeQuery);
  if (!matched || matched.length === 0) {
    return {
      success: false,
      message: `No routes found matching "${routeQuery}". Try route numbers like "KIA-7A", "500-D", or "335-E".`,
    };
  }

  const primaryName = matched[0].route_name;
  // Get all variants of this route (e.g. UP and DOWN)
  const variants = matched.filter((r) => r.route_name.toUpperCase() === primaryName.toUpperCase());
  const routeIds = variants.map((r) => r.route_id);

  // Fetch route stops details and live buses in parallel
  const [routeDetails, rawLiveBuses] = await Promise.all([
    getRouteDetails(routeIds),
    fetchLiveBuses(routeIds),
  ]);

/**
 * Decode Google/OSM encoded polyline string into [[lat, lng], ...]
 */
function decodePolyline(str, precision = 5) {
  if (!str || typeof str !== 'string') return [];
  let index = 0, lat = 0, lng = 0, coordinates = [];
  const factor = Math.pow(10, precision);

  while (index < str.length) {
    let byte, shift = 0, result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += deltaLat;

    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += deltaLng;

    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
}

  const routeDetailsMap = new Map();
  const allStops = [];
  const roadPolylines = [];

  routeDetails.forEach((r) => {
    routeDetailsMap.set(r.routeId, r);

    // Decode turn-by-turn road polyline from BMTC staticData
    if (r.staticData?.polyline) {
      const decoded = decodePolyline(r.staticData.polyline);
      if (decoded.length > 0) {
        roadPolylines.push(decoded);
      }
    }

    const stops = r.staticData?.stopSequenceWithDetails || [];
    stops.forEach((s) => {
      if (!allStops.some((existing) => existing.id === s.stop_id)) {
        allStops.push({
          id: s.stop_id,
          name: s.stop_name,
          lat: s.stop_lat,
          lon: s.stop_lon,
        });
      }
    });
  });

  const allBuses = [];

  for (const bus of rawLiveBuses) {
    const routeVariant = routeDetailsMap.get(bus.routeId);
    const staticData = routeVariant?.staticData;
    const stops = staticData?.stopSequenceWithDetails || [];
    const origin = stops.length > 0 ? stops[0].stop_name : (variants[0]?.first_stop_name || 'Origin');
    const destination = stops.length > 0 ? stops[stops.length - 1].stop_name : (variants[0]?.last_stop_name || 'Destination');
    const serviceType = staticData?.specialFeatures?.[0] || variants[0]?.spf?.[0] || 'BMTC Bus';

    const { stop: nearestStop, distanceKm: distToStop, stopIndex } = findClosestStop(
      bus.lat,
      bus.lon,
      stops
    );

    let targetInfo = null;
    if (targetStopName && stops.length > 0) {
      const targetIdx = stops.findIndex((s) =>
        s.stop_name.toLowerCase().includes(targetStopName.toLowerCase())
      );

      if (targetIdx !== -1) {
        const targetStop = stops[targetIdx];
        const distToTarget = haversineDistanceKm(
          bus.lat,
          bus.lon,
          targetStop.stop_lat,
          targetStop.stop_lon
        );

        const hasPassed = stopIndex > targetIdx;
        const stopsAway = targetIdx - stopIndex;

        // Estimate arrival time based on 18 km/h city average
        const avgSpeedKmH = 18;
        const etaMinutes = Math.max(1, Math.round((distToTarget / avgSpeedKmH) * 60));

        targetInfo = {
          targetStop: targetStop.stop_name,
          targetStopId: targetStop.stop_id,
          distanceKm: Number(distToTarget.toFixed(2)),
          stopsAway: hasPassed ? 0 : stopsAway,
          hasPassed,
          estimatedMinutes: hasPassed ? null : etaMinutes,
        };
      }
    }

    allBuses.push({
      vehicleNumber: bus.vehicleNumber,
      serviceType,
      direction: `${origin} ➜ ${destination}`,
      origin,
      destination,
      coordinates: { lat: bus.lat, lon: bus.lon },
      headingDegrees: bus.bearing,
      isHalted: bus.isHalted,
      lastUpdated: bus.lastUpdated,
      currentLocation: {
        nearestStop: nearestStop ? nearestStop.stop_name : 'En route',
        distanceFromNearestStopKm: Number(distToStop.toFixed(2)),
      },
      targetStopAnalysis: targetInfo,
      googleMapsLink: `https://www.google.com/maps?q=${bus.lat},${bus.lon}`,
    });
  }

  return {
    success: true,
    route: primaryName,
    variants: variants.map((v) => ({
      id: v.route_id,
      from: v.first_stop_name,
      to: v.last_stop_name,
    })),
    totalActiveBuses: allBuses.length,
    buses: allBuses,
    routeStops: allStops,
    roadPolylines,
  };
}

// In-memory cache for all bus stops and stop details
let cachedStops = null;
let lastStopsFetch = 0;
const stopDetailsCache = new Map();

/**
 * Fetch all bus stops in Bengaluru
 */
async function getAllBusStops() {
  const now = Date.now();
  if (cachedStops && now - lastStopsFetch < CACHE_TTL_MS) {
    return cachedStops;
  }

  const today = DAYS[new Date().getDay()];
  const res = await fetch(`${BASE_URL}/scheduler_v4/v4/bengaluru/stops?day=${today}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch stops: HTTP ${res.status}`);
  }

  const stops = await res.json();
  cachedStops = Array.isArray(stops) ? stops : [];
  lastStopsFetch = now;
  return cachedStops;
}

/**
 * Fetch trips/routes passing through a stop with in-memory caching
 */
async function getStopDetailsCached(stopId) {
  if (stopDetailsCache.has(stopId)) {
    return stopDetailsCache.get(stopId);
  }

  const today = DAYS[new Date().getDay()];
  try {
    const res = await fetch(`${BASE_URL}/scheduler_v4/v4/bengaluru/stopdetails?day=${today}&stop_id=${stopId}`);
    if (!res.ok) return [];
    const json = await res.json();
    const trips = Array.isArray(json) ? json : [];
    stopDetailsCache.set(stopId, trips);
    return trips;
  } catch (e) {
    console.error(`Stop details error for ${stopId}:`, e.message);
    return [];
  }
}

/**
 * Major BMTC transit interchange hubs for multi-bus connections
 */
const TRANSIT_HUBS = [
  { name: 'Majestic (KBS)', query: 'Kempegowda Bus Station' },
  { name: 'Shivajinagara Bus Station', query: 'Shivajinagara Bus Station' },
  { name: 'Central Silk Board', query: 'Central Silk Board' },
  { name: 'Domlur Bus Stand', query: 'Domlur' },
  { name: 'Hebbala', query: 'Hebbala' },
  { name: 'Banashankari Bus Station', query: 'Banashankari Bus Station' },
  { name: 'Tin Factory / KR Puram', query: 'Tin Factory' },
  { name: 'Shantinagara TTMC', query: 'Shantinagara Bus Station' },
  { name: 'Yeshwanthapura', query: 'Yeshwanthapura Bus Station' },
  { name: 'Electronic City', query: 'Electronic City' },
  { name: 'Kempegowda Int. Airport', query: 'Kempegowda International Airport' },
  { name: 'Koramangala', query: 'Koramangala Bus Station' },
  { name: 'Jayanagar 4th Block', query: 'Jayanagara 4th Block' },
  { name: 'Marathahalli Bridge', query: 'Marathahalli' },
];

/**
 * Point A to Point B Bus Finder with direct buses and multi-bus transfer planner
 */
async function planTrip(fromQuery, toQuery) {
  if (!fromQuery || !toQuery) {
    throw new Error('Both origin (from) and destination (to) are required');
  }

  const fQ = fromQuery.trim().toLowerCase();
  const tQ = toQuery.trim().toLowerCase();

  const [allStops, allRoutes] = await Promise.all([
    getAllBusStops(),
    getAllRoutes(),
  ]);

  // Find matching stops for origin and destination
  const oStops = allStops.filter((s) => s.stop_name && s.stop_name.toLowerCase().includes(fQ)).slice(0, 6);
  const dStops = allStops.filter((s) => s.stop_name && s.stop_name.toLowerCase().includes(tQ)).slice(0, 6);

  const bestOriginName = oStops.length > 0 ? oStops[0].stop_name : fromQuery.trim();
  const bestDestName = dStops.length > 0 ? dStops[0].stop_name : toQuery.trim();

  // 1. Direct Terminal Routes from allRoutes catalogue
  const directMap = new Map();
  for (const r of allRoutes) {
    const fStop = (r.first_stop_name || '').toLowerCase();
    const lStop = (r.last_stop_name || '').toLowerCase();
    const isDirectForward = fStop.includes(fQ) && lStop.includes(tQ);
    const isDirectReverse = fStop.includes(tQ) && lStop.includes(fQ);

    if (isDirectForward || isDirectReverse) {
      const base = r.route_name.split(/\s+/)[0];
      if (!directMap.has(base)) {
        directMap.set(base, {
          route: base,
          fullName: r.route_name,
          from: r.first_stop_name,
          to: r.last_stop_name,
          serviceType: r.spf?.[0] || 'BMTC Bus',
          isDirect: true,
          type: 'direct_terminal',
        });
      }
    }
  }

  // 2. Direct Routes via stop details intersection
  const oDetails = await Promise.all(oStops.map((s) => getStopDetailsCached(s.stop_id)));
  const dDetails = await Promise.all(dStops.map((s) => getStopDetailsCached(s.stop_id)));

  const oMap = new Map();
  oDetails.flat().forEach((item) => {
    if (item.trip?.route_name) {
      const base = item.trip.route_name.split(/\s+/)[0];
      if (!oMap.has(base)) oMap.set(base, item.trip);
    }
  });

  const dMap = new Map();
  dDetails.flat().forEach((item) => {
    if (item.trip?.route_name) {
      const base = item.trip.route_name.split(/\s+/)[0];
      if (!dMap.has(base)) dMap.set(base, item.trip);
    }
  });

  oMap.forEach((trip, base) => {
    if (dMap.has(base) && !directMap.has(base)) {
      directMap.set(base, {
        route: base,
        fullName: trip.route_name,
        from: trip.first_stop?.stop_name || bestOriginName,
        to: trip.last_stop?.stop_name || bestDestName,
        serviceType: trip.spf?.[0] || 'BMTC Bus',
        isDirect: true,
        type: 'direct_stop',
      });
    }
  });

  const directRoutes = Array.from(directMap.values());

  // 3. Multi-Bus Transfer Routes via Transit Interchange Hubs
  const transferRoutes = [];
  for (const hub of TRANSIT_HUBS) {
    const hubLower = hub.name.toLowerCase();
    // Skip hub if it's the same as origin or destination
    if (hubLower.includes(fQ) || hubLower.includes(tQ) || fQ.includes(hubLower) || tQ.includes(hubLower)) {
      continue;
    }

    const hStops = allStops
      .filter((s) => s.stop_name && s.stop_name.toLowerCase().includes(hub.query.toLowerCase()))
      .slice(0, 3);

    if (hStops.length === 0) continue;

    const hDetails = await Promise.all(hStops.map((s) => getStopDetailsCached(s.stop_id)));
    const hMap = new Map();
    hDetails.flat().forEach((item) => {
      if (item.trip?.route_name) {
        const base = item.trip.route_name.split(/\s+/)[0];
        if (!hMap.has(base)) hMap.set(base, item.trip);
      }
    });

    const leg1 = [];
    oMap.forEach((trip, base) => {
      if (hMap.has(base) && !directMap.has(base)) leg1.push(base);
    });

    const leg2 = [];
    dMap.forEach((trip, base) => {
      if (hMap.has(base) && !directMap.has(base)) leg2.push(base);
    });

    if (leg1.length > 0 && leg2.length > 0) {
      transferRoutes.push({
        hub: hub.name,
        hubStopName: hStops[0]?.stop_name || hub.name,
        leg1: {
          from: bestOriginName,
          to: hub.name,
          routes: [...new Set(leg1)].slice(0, 6),
          estimatedMinutes: 30,
        },
        transferNotice: `Transfer at ${hub.name} (interchange hub)`,
        leg2: {
          from: hub.name,
          to: bestDestName,
          routes: [...new Set(leg2)].slice(0, 6),
          estimatedMinutes: 30,
        },
        totalTransfers: 1,
      });
    }
  }

  return {
    success: true,
    origin: {
      query: fromQuery,
      matchedStop: bestOriginName,
    },
    destination: {
      query: toQuery,
      matchedStop: bestDestName,
    },
    totalDirect: directRoutes.length,
    directRoutes: directRoutes.slice(0, 15),
    totalTransfers: transferRoutes.length,
    transferRoutes: transferRoutes.slice(0, 6),
  };
}

module.exports = {
  getAllRoutes,
  getAllBusStops,
  searchRoute,
  searchBusStop,
  getRouteDetails,
  getStopDetailsCached,
  trackBus,
  planTrip,
};

