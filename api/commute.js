const { trackBus } = require('../bmtc');
const url = require('url');

const STOPS = {
  office: {
    name: 'Domlur',
    fullName: 'Domlur Bus Stand (Office: Murugeshpalya)',
    keywords: ['domlur', 'murugeshpalya', 'office'],
  },
  home: {
    name: 'RM Guttahalli',
    fullName: 'RM Guttahalli Bus Stand (Home)',
    keywords: ['guttahalli', 'rm guttahalli', 'guthhali', 'home'],
  },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (res.status) return res.status(204).end();
    res.writeHead(204);
    return res.end();
  }

  const host = req.headers?.host || 'localhost';
  const parsed = new URL(req.url, `http://${host}`);
  const query = req.query || Object.fromEntries(parsed.searchParams);

  // 'home' or 'office'
  let destination = (query.to || query.destination || 'home').toLowerCase();
  let route = query.route || 'KIA-7A';

  const send = (code, obj) => {
    if (typeof res.status === 'function') {
      return res.status(code).json(obj);
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const isGoingHome = destination.includes('home') || destination.includes('guttahalli') || destination.includes('guthhali');
  const boardingStopName = isGoingHome ? STOPS.office.name : STOPS.home.name;
  const targetStopName = isGoingHome ? STOPS.home.name : STOPS.office.name;

  try {
    // Track KIA-7A towards the boarding stop
    const data = await trackBus(route, boardingStopName);

    if (!data.success || !data.buses || data.buses.length === 0) {
      const speech = `No active ${route} buses are currently broadcasting GPS on the road.`;
      return send(200, {
        success: false,
        speech,
        fulfillmentText: speech,
        buses: [],
      });
    }

    // Filter buses that are heading towards the user's destination
    // If going home (Domlur -> RM Guttahalli): heading towards Airport
    // If going to office (RM Guttahalli -> Domlur): heading towards HSR Layout
    const expectedDirKeyword = isGoingHome ? 'Airport' : 'HSR Layout';

    const relevantBuses = data.buses.filter((b) => {
      const dirMatch = b.direction.toLowerCase().includes(expectedDirKeyword.toLowerCase());
      const hasNotPassed = b.targetStopAnalysis && !b.targetStopAnalysis.hasPassed;
      return dirMatch && hasNotPassed;
    });

    // If no buses in ideal window, fallback to all upcoming buses towards that stop
    const candidateBuses = relevantBuses.length > 0 
      ? relevantBuses 
      : data.buses.filter((b) => b.targetStopAnalysis && !b.targetStopAnalysis.hasPassed);

    if (candidateBuses.length === 0) {
      const speech = `There are currently ${data.totalActiveBuses} active buses on route ${route}, but all approaching buses have already passed ${boardingStopName}. The next bus should start soon.`;
      return send(200, {
        success: true,
        speech,
        fulfillmentText: speech,
        totalActiveBuses: data.totalActiveBuses,
        buses: data.buses,
      });
    }

    // Sort by nearest arrival time
    candidateBuses.sort(
      (a, b) => a.targetStopAnalysis.estimatedMinutes - b.targetStopAnalysis.estimatedMinutes
    );

    const nextBus = candidateBuses[0];
    const t = nextBus.targetStopAnalysis;

    let speech = isGoingHome
      ? `Heading Home: Your next ${route} bus (${nextBus.vehicleNumber}) will reach Domlur Bus Stand in about ${t.estimatedMinutes} minutes. It is currently ${t.distanceKm} kilometers away near ${nextBus.currentLocation.nearestStop}.`
      : `Heading to Murugeshpalya Office: Your next ${route} bus (${nextBus.vehicleNumber}) will reach RM Guttahalli in about ${t.estimatedMinutes} minutes to take you to Domlur Bus Stand. It is currently ${t.distanceKm} kilometers away near ${nextBus.currentLocation.nearestStop}.`;

    if (candidateBuses.length > 1) {
      const secondBus = candidateBuses[1];
      speech += ` Another bus (${secondBus.vehicleNumber}) is behind it in ${secondBus.targetStopAnalysis.estimatedMinutes} minutes.`;
    }

    return send(200, {
      success: true,
      mode: isGoingHome ? 'Office ➔ Home' : 'Home ➔ Office',
      boardingStop: boardingStopName,
      destinationStop: targetStopName,
      route,
      speech,
      fulfillmentText: speech,
      nextBus: {
        vehicleNumber: nextBus.vehicleNumber,
        serviceType: nextBus.serviceType,
        etaMinutes: t.estimatedMinutes,
        distanceKm: t.distanceKm,
        currentNear: nextBus.currentLocation.nearestStop,
        coordinates: nextBus.coordinates,
        googleMapsLink: nextBus.googleMapsLink,
      },
      allUpcomingBuses: candidateBuses,
    });
  } catch (err) {
    return send(500, {
      success: false,
      speech: `Could not fetch live bus data right now: ${err.message}`,
      error: err.message,
    });
  }
};
