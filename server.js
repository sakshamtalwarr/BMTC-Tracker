const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const trackHandler = require('./api/track');
const stopsHandler = require('./api/stops');
const assistantHandler = require('./api/assistant');
const commuteHandler = require('./api/commute');
const planHandler = require('./api/plan');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const host = req.headers?.host || 'localhost';
  const parsedUrl = new URL(req.url, `http://${host}`);
  let pathname = parsedUrl.pathname.replace(/\.js$/, ''); // Normalize .js extensions if any

  if (pathname === '/api/track') {
    return trackHandler(req, res);
  }

  if (pathname === '/api/stops') {
    return stopsHandler(req, res);
  }

  if (pathname === '/api/assistant') {
    return assistantHandler(req, res);
  }

  if (pathname === '/api/commute') {
    return commuteHandler(req, res);
  }

  if (pathname === '/api/plan') {
    return planHandler(req, res);
  }

  // Serve static files from /public
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 BMTC Mobile Web Server running on port ${PORT}!`);
  console.log(`📱 Local: http://localhost:${PORT}`);
});
