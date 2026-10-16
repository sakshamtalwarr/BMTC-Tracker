const { planTrip } = require('../bmtc');
const url = require('url');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (res.status) return res.status(204).end();
    res.writeHead(204);
    return res.end();
  }

  const host = req.headers?.host || 'localhost';
  const parsed = new URL(req.url, `http://${host}`);
  const query = req.query || Object.fromEntries(parsed.searchParams);

  const from = query.from || query.source || query.origin || '';
  const to = query.to || query.destination || query.dest || '';

  const send = (code, obj) => {
    if (typeof res.status === 'function') {
      return res.status(code).json(obj);
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (!from.trim() || !to.trim()) {
    return send(400, {
      success: false,
      message: 'Both "from" (origin) and "to" (destination) query parameters are required (e.g. /api/plan?from=Domlur&to=Majestic)',
    });
  }

  try {
    const plan = await planTrip(from, to);
    return send(200, plan);
  } catch (err) {
    console.error('Trip planner error:', err);
    return send(500, {
      success: false,
      message: `Failed to plan bus route: ${err.message}`,
    });
  }
};
