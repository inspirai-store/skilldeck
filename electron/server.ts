import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Engine } from '../src/core/engine';
import { dispatch } from '../src/core/api';
import { defaultCtx } from '../src/core/util';

/** No CORS, static files, or unauthenticated methods. Bind loopback only. */
export function createLocalServer(engine: Engine, token = randomBytes(32).toString('hex')) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const respond = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) { respond(403, { error: 'Forbidden' }); return; }
    if (req.method !== 'POST' || req.url !== '/rpc') { respond(404, { error: 'Not found' }); return; }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { respond(413, { error: 'Request too large' }); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body?.method !== 'string') throw new Error('method 必须是字符串');
      respond(200, { result: dispatch(engine, body.method, body.params ?? {}) });
    } catch (e) { respond(400, { error: e instanceof Error ? e.message : String(e) }); }
  });
  server.requestTimeout = 15000;
  return { server, token };
}

// esbuild CJS entry detection; importing this module in tests never starts a listener.
if (typeof require !== 'undefined' && require.main === module) {
  const { server, token } = createLocalServer(new Engine(defaultCtx()));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address() as import('node:net').AddressInfo;
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${address.port}/rpc`, token }) + '\n');
  });
}
