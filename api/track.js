const { trackBus } = require('../bmtc');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const { route, stop } = req.query;

  if (!route) {
    res.status(400).json({ success: false, message: 'Route parameter is required' });
    return;
  }

  try {
    const data = await trackBus(route, stop || null);
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
