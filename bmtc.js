/**
 * BMTC Live Bus Tracker & ETA Engine
 * Uses reverse-engineered Namma BMTC endpoints
 */

const BASE_URL = 'https://bmtcmobileapistaging.amnex.com/WebAPI';

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
 * Search routes by text (e.g. "KIA-7A", "500-D", "335-E")
 */
async function searchRoute(routetext) {
  const res = await fetch(`${BASE_URL}/SearchRoute_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routetext: routetext.trim() }),
  });
  if (!res.ok) {
    throw new Error(`SearchRoute_v2 HTTP ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  return json.data || [];
}

/**
 * Search bus stops by name (e.g. "Silk Board", "Majestic", "Kadugodi")
 */
async function searchBusStop(stationName) {
  const res = await fetch(`${BASE_URL}/FindNearByBusStop_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stationName: stationName.trim() }),
  });
  if (!res.ok) {
    throw new Error(`FindNearByBusStop_v2 HTTP ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  return json.data || [];
}

/**
 * Get route stops and live vehicles for a route ID
 */
async function getRouteDetails(routeId, serviceTypeId = 0) {
  const res = await fetch(`${BASE_URL}/SearchByRouteDetails_v4`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeid: routeId, servicetypeid: serviceTypeId }),
  });
  if (!res.ok) {
    throw new Error(`SearchByRouteDetails_v4 HTTP ${res.status}: ${res.statusText}`);
  }
  return await res.json();
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
    const dist = haversineDistanceKm(busLat, busLon, stop.centerlat, stop.centerlong);
    if (dist < minDistance) {
      minDistance = dist;
      closestStop = stop;
      closestIndex = i;
    }
  }

  return { stop: closestStop, distanceKm: minDistance, stopIndex: closestIndex };
}

/**
 * Main function: Get live tracking summary for a route (e.g. "KIA-7A")
 * Optionally pass targetStopName to calculate distance and ETA to that stop
 */
async function trackBus(routeQuery, targetStopName = null) {
  const routes = await searchRoute(routeQuery);
  if (!routes || routes.length === 0) {
    return {
      success: false,
      message: `No routes found matching "${routeQuery}". Try searching route variations like "KIA-7" or "500".`,
    };
  }

  // Exact match or first match
  const matchedRoute =
    routes.find((r) => r.routeno?.toUpperCase() === routeQuery.toUpperCase()) ||
    routes[0];

  const routeParentId = matchedRoute.routeparentid;
  const routeName = matchedRoute.routeno;

  const routeData = await getRouteDetails(routeParentId);

  const directions = ['up', 'down'];
  const allBuses = [];

  for (const dir of directions) {
    const dirData = routeData[dir];
    if (!dirData) continue;

    const stops = dirData.data || [];
    const liveVehicles = dirData.mapData || [];

    const origin = stops.length > 0 ? stops[0].stationname : 'Unknown';
    const destination = stops.length > 0 ? stops[stops.length - 1].stationname : 'Unknown';

    for (const vehicle of liveVehicles) {
      const { centerlat, centerlong, vehiclenumber, heading, lastrefreshon, servicetype } = vehicle;
      
      const { stop: nearestStop, distanceKm: distToStop, stopIndex } = findClosestStop(
        centerlat,
        centerlong,
        stops
      );

      let targetInfo = null;
      if (targetStopName) {
        const targetIdx = stops.findIndex((s) =>
          s.stationname.toLowerCase().includes(targetStopName.toLowerCase())
        );

        if (targetIdx !== -1) {
          const targetStop = stops[targetIdx];
          const distToTarget = haversineDistanceKm(
            centerlat,
            centerlong,
            targetStop.centerlat,
            targetStop.centerlong
          );

          // Check if bus is before or after the stop in route direction
          const hasPassed = stopIndex > targetIdx;
          const stopsAway = targetIdx - stopIndex;

          // Estimate arrival time (assuming avg BMTC city speed of 18 km/h = 3.3 min/km)
          const avgSpeedKmH = 18;
          const etaMinutes = Math.round((distToTarget / avgSpeedKmH) * 60);

          targetInfo = {
            targetStop: targetStop.stationname,
            targetStopId: targetStop.stationid,
            distanceKm: Number(distToTarget.toFixed(2)),
            stopsAway: hasPassed ? 0 : stopsAway,
            hasPassed,
            estimatedMinutes: hasPassed ? null : etaMinutes,
          };
        }
      }

      allBuses.push({
        vehicleNumber: vehiclenumber,
        serviceType: servicetype || 'BMTC Bus',
        direction: `${origin} ➜ ${destination}`,
        origin,
        destination,
        coordinates: { lat: centerlat, lon: centerlong },
        headingDegrees: heading,
        lastUpdated: lastrefreshon,
        currentLocation: {
          nearestStop: nearestStop ? nearestStop.stationname : 'En route',
          distanceFromNearestStopKm: Number(distToStop.toFixed(2)),
        },
        targetStopAnalysis: targetInfo,
        googleMapsLink: `https://www.google.com/maps?q=${centerlat},${centerlong}`,
      });
    }
  }

  return {
    success: true,
    route: routeName,
    routeId: routeParentId,
    totalActiveBuses: allBuses.length,
    buses: allBuses,
  };
}

module.exports = {
  searchRoute,
  searchBusStop,
  getRouteDetails,
  trackBus,
};
