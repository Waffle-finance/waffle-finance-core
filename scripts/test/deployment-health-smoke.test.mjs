import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { formatReport, runSmokeCheck, safeOrigin } from '../deployment-health-smoke.mjs';

async function stubServer(readyStatus = 'ok', failingCheck = false) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', uptime: 1000 }));
      return;
    }
    if (req.url === '/readyz') {
      const checks = [
        { name: 'ethereum_rpc', ok: !failingCheck },
        { name: 'soroban_rpc', ok: true },
      ];
      res.statusCode = failingCheck ? 503 : 200;
      res.end(JSON.stringify({ status: readyStatus, checks, degradedServices: failingCheck ? ['ethereum_rpc'] : [] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/?api_key=super-secret-value` };
}

test('deployment smoke check passes when all services report healthy dependencies', async () => {
  const server = await stubServer();
  try {
    const config = {
      services: {
        coordinator: { baseUrl: '' },
        relayer: { baseUrl: '' },
        resolver: { baseUrl: '' },
      },
      timeoutMs: 2000,
      requiredChains: ['ethereum', 'soroban'],
    };
    for (const name of Object.keys(config.services)) config.services[name].baseUrl = server.baseUrl;
    const report = await runSmokeCheck(config);
    assert.equal(report.ok, true);
    assert.equal(report.results.length, 3);
    assert.deepEqual(report.results[0].chains, { ethereum: true, soroban: true });
    assert.ok(!formatReport(report).includes('super-secret-value'));
    assert.ok(!formatReport(report).includes('api_key'));
  } finally {
    server.server.close();
  }
});

test('deployment smoke check reports the service and failing chain dependency', async () => {
  const healthy = await stubServer();
  const failing = await stubServer('degraded', true);
  try {
    const config = {
      services: {
        coordinator: { baseUrl: healthy.baseUrl },
        relayer: { baseUrl: failing.baseUrl },
        resolver: { baseUrl: healthy.baseUrl },
      },
      timeoutMs: 2000,
      requiredChains: ['ethereum'],
    };
    const report = await runSmokeCheck(config);
    assert.equal(report.ok, false);
    const relayer = report.results.find((r) => r.service === 'relayer');
    assert.equal(relayer.ok, false);
    assert.equal(relayer.chains.ethereum, false);
    const text = formatReport(report);
    assert.ok(text.includes('relayer'));
    assert.ok(text.includes('ethereum'));
    assert.ok(!text.includes('super-secret-value'));
  } finally {
    healthy.server.close();
    failing.server.close();
  }
});

test('safeOrigin never exposes credentials, paths or query strings', () => {
  assert.equal(safeOrigin('https://user:pass@example.com/v3/key/abc?api_key=secret#frag'), 'https://example.com');
  assert.equal(safeOrigin('not a url'), '<invalid-url>');
});
