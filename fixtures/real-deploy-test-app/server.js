const http = require('http');

const port = Number(process.env.PORT || 3000);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('LaunchOS First Real Deploy\n');
});

server.listen(port, '0.0.0.0');
