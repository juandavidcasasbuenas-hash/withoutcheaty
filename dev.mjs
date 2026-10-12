import http from 'node:http';
import { Readable } from 'node:stream';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true } });
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/api/league')) {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const { default: handler } = await import('./api/league.js');
      const response = await handler.fetch(new Request(`http://localhost:5173${req.url}`, { method: req.method, signal: abort.signal }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'The calculation could not be completed. Please try again.' }));
    }
    return;
  }
  vite.middlewares(req, res);
});
server.listen(5173, '127.0.0.1', () => console.log('withoutcheaty → http://127.0.0.1:5173'));
