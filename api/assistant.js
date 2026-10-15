const { trackBus } = require('../bmtc');
const url = require('url');

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

  // Support both GET query params and Dialogflow / Google Assistant POST body
  let route = query.route;
  let stop = query.stop || null;

  if (req.method === 'POST' && req.body) {
    // Dialogflow ES / CX parameter extraction
    const params = req.body.queryResult?.parameters || req.body.sessionInfo?.parameters || req.body;
    route = route || params.route || params.bus_route || params.routeno;
    stop = stop || params.stop || params.bus_stop || params.station;
  }

  const send = (code, obj) => {
    if (typeof res.status === 'function') {
      return res.status(code).json(obj);
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (!route) {
    const errorText = "Please specify a bus route, for example KIA-7A or 500-D.";
    return send(200, {
      speech: errorText,
      fulfillmentText: errorText,
      fulfillmentResponse: {
        messages: [{ text: { text: [errorText] } }]
      }
    });
  }

  try {
    const data = await trackBus(route, stop);

    if (!data.success || !data.buses || data.buses.length === 0) {
      const msg = `There are currently no active GPS buses reported on route ${route}.`;
      return send(200, {
        speech: msg,
        fulfillmentText: msg,
        fulfillmentResponse: {
          messages: [{ text: { text: [msg] } }]
        }
      });
    }

    // Select the best bus (nearest to target stop if provided, or first active bus)
    let bestBus = data.buses[0];
    let speech = '';

    if (stop) {
      const incomingBuses = data.buses.filter(b => b.targetStopAnalysis && !b.targetStopAnalysis.hasPassed);
      if (incomingBuses.length > 0) {
        // Sort by closest ETA
        incomingBuses.sort((a, b) => a.targetStopAnalysis.estimatedMinutes - b.targetStopAnalysis.estimatedMinutes);
        bestBus = incomingBuses[0];
        const t = bestBus.targetStopAnalysis;
        speech = `Bus ${bestBus.vehicleNumber} is currently near ${bestBus.currentLocation.nearestStop}, about ${t.distanceKm} kilometers from ${t.targetStop}. It is estimated to arrive in approximately ${t.estimatedMinutes} minutes.`;
      } else {
        speech = `Found ${data.totalActiveBuses} buses on route ${route}, but all currently active buses appear to have already passed ${stop}.`;
      }
    } else {
      speech = `Found ${data.totalActiveBuses} active buses on route ${route}. The nearest one, vehicle ${bestBus.vehicleNumber}, is near ${bestBus.currentLocation.nearestStop} heading towards ${bestBus.destination}.`;
    }

    return send(200, {
      speech,
      fulfillmentText: speech,
      fulfillmentResponse: {
        messages: [{ text: { text: [speech] } }]
      },
      data
    });
  } catch (err) {
    const errMsg = `Sorry, I couldn't reach the BMTC tracking service right now.`;
    return send(500, {
      speech: errMsg,
      fulfillmentText: errMsg,
      fulfillmentResponse: {
        messages: [{ text: { text: [errMsg] } }]
      },
      error: err.message
    });
  }
};
