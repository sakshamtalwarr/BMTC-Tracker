const { trackBus } = require('../bmtc');
const url = require('url');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (res.status) return res.status(204).end();
    res.writeHead(204);
    return res.end();
  }

  // Parse query params whether run via Vercel serverless (req.query) or standard Node (req.url)
  const parsed = url.parse(req.url, true);
  const query = req.query || parsed.query || {};
  const route = query.route;
  const stop = query.stop || null;

  const send = (code, obj) => {
    if (typeof res.status === 'function') {
      return res.status(code).json(obj);
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (!route) {
    return send(400, { success: false, message: 'Route parameter is required (e.g. ?route=KIA-7A)' });
  }

  try {
    const data = await trackBus(route, stop);
    return send(200, data);
  } catch (err) {
    return send(500, { success: false, message: err.message });
  }
};
