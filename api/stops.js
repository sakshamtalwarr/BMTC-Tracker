const { searchBusStop } = require('../bmtc');
const url = require('url');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    if (res.status) return res.status(204).end();
    res.writeHead(204);
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  const query = req.query || parsed.query || {};
  const q = query.q;

  const send = (code, obj) => {
    if (typeof res.status === 'function') {
      return res.status(code).json(obj);
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (!q) {
    return send(400, { success: false, message: 'q query parameter is required (e.g. ?q=Silk)' });
  }

  try {
    const stops = await searchBusStop(q);
    return send(200, { success: true, stops: stops.slice(0, 15) });
  } catch (err) {
    return send(500, { success: false, message: err.message });
  }
};
