const { searchBusStop } = require('../bmtc');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const { q } = req.query;

  if (!q) {
    res.status(400).json({ success: false, message: 'q query parameter is required' });
    return;
  }

  try {
    const stops = await searchBusStop(q);
    res.status(200).json({ success: true, stops: stops.slice(0, 15) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
