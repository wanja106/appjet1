import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

let server;
let baseUrl;
let store;
let tmpDir;
let tumbler;
let lamp;

const post = (url, body) => fetch(`${baseUrl}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const get = (url) => fetch(`${baseUrl}${url}`);

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropship-sales-'));
  store = createStore({ filePath: path.join(tmpDir, 'store.json'), seed: false });

  tumbler = store.createProduct({ name: 'Insulated Tumbler', sku: 'T-100', basePriceMinor: 3000 });
  lamp = store.createProduct({ name: 'Sunset Lamp', sku: 'L-200', basePriceMinor: 4000 });

  // Product under test sells in three markets; the other product must not leak in.
  store.recordSale({ productId: tumbler.id, marketCode: 'US', quantity: 2, unitPriceMinor: 3000, soldAt: '2026-01-05T10:00:00Z' });
  store.recordSale({ productId: tumbler.id, marketCode: 'DE', quantity: 1, unitPriceMinor: 2800, soldAt: '2026-01-06T10:00:00Z' });
  store.recordSale({ productId: tumbler.id, marketCode: 'GB', quantity: 3, unitPriceMinor: 2400, soldAt: '2026-01-07T10:00:00Z' });
  store.recordSale({ productId: lamp.id, marketCode: 'US', quantity: 5, unitPriceMinor: 4000, soldAt: '2026-01-07T11:00:00Z' });

  const app = createApp({ store });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('health endpoint responds', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('reference data exposes products and markets', async () => {
  const products = await (await get('/api/products')).json();
  const markets = await (await get('/api/markets')).json();

  assert.ok(products.products.length >= 2);
  assert.ok(markets.markets.some((m) => m.code === 'US'));
  assert.ok(markets.markets.some((m) => m.code === 'GB'));
});

test('report aggregates one product across any market', async () => {
  const res = await get(`/api/reports/product-sales?productId=${tumbler.id}&market=ALL`);
  assert.equal(res.status, 200);
  const report = await res.json();

  assert.equal(report.product.sku, 'T-100');
  assert.equal(report.market, 'ALL');
  assert.equal(report.marketLabel, 'Any market');
  assert.equal(report.totals.units, 6);
  assert.equal(report.totals.orders, 3);
  assert.equal(report.totals.marketsSoldIn, 3);

  // 2 x 3000 USD + 1 x 2800 EUR x 1.08 + 3 x 2400 GBP x 1.27
  assert.equal(report.totals.revenueUsdMinor, 6000 + 3024 + 9144);
  assert.equal(report.totals.avgOrderValueUsdMinor, Math.round((6000 + 3024 + 9144) / 3));

  const byMarket = Object.fromEntries(report.byMarket.map((m) => [m.marketCode, m]));
  assert.deepEqual(Object.keys(byMarket).sort(), ['DE', 'GB', 'US']);
  assert.equal(byMarket.US.revenueUsdMinor, 6000);
  assert.equal(byMarket.DE.revenueLocalMinor, 2800);
  assert.equal(byMarket.DE.currency, 'EUR');
  assert.equal(byMarket.GB.units, 3);
  assert.equal(byMarket.GB.revenueUsdMinor, 9144);

  const shareSum = report.byMarket.reduce((sum, m) => sum + m.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 0.01, `shares should sum to 1, got ${shareSum}`);

  // Another product's sales never appear.
  assert.ok(!report.byMarket.some((m) => m.units === 5));
});

test('report narrows to a single market', async () => {
  const res = await get(`/api/reports/product-sales?productId=${tumbler.id}&market=GB`);
  const report = await res.json();

  assert.equal(report.market, 'GB');
  assert.equal(report.currency, 'GBP');
  assert.equal(report.totals.units, 3);
  assert.equal(report.totals.orders, 1);
  assert.equal(report.totals.revenueUsdMinor, 9144);
  assert.equal(report.byMarket.length, 1);
  assert.equal(report.byMarket[0].revenueLocalMinor, 7200);
});

test('report rejects unknown products and unknown markets', async () => {
  const missingProduct = await get('/api/reports/product-sales?productId=nope');
  assert.equal(missingProduct.status, 404);

  const noProductParam = await get('/api/reports/product-sales');
  assert.equal(noProductParam.status, 400);

  const missingMarket = await get(`/api/reports/product-sales?productId=${tumbler.id}&market=ZZ`);
  assert.equal(missingMarket.status, 404);
});

test('sales list filters by product and market', async () => {
  const all = await (await get(`/api/sales?productId=${tumbler.id}&market=ALL`)).json();
  assert.equal(all.count, 3);
  assert.ok(all.sales.every((sale) => sale.productId === tumbler.id));

  const gb = await (await get(`/api/sales?productId=${tumbler.id}&market=GB`)).json();
  assert.equal(gb.count, 1);
  assert.equal(gb.sales[0].lineUsdMinor, 9144);

  const newestFirst = await (await get(`/api/sales?productId=${tumbler.id}`)).json();
  assert.equal(newestFirst.sales[0].marketCode, 'GB');
});

test('recording a sale through the API updates the report', async () => {
  const res = await post('/api/sales', {
    productId: tumbler.id,
    marketCode: 'CA',
    quantity: 2,
    unitPriceMinor: 4100,
    channel: 'Shopify',
    orderRef: 'ORD-777',
  });
  assert.equal(res.status, 201);
  const { sale } = await res.json();
  assert.equal(sale.marketCode, 'CA');
  assert.equal(sale.currency, 'CAD');
  assert.equal(sale.lineLocalMinor, 8200);
  assert.equal(sale.lineUsdMinor, Math.round(8200 * 0.73));

  const report = await (await get(`/api/reports/product-sales?productId=${tumbler.id}&market=ALL`)).json();
  assert.equal(report.totals.units, 8);
  assert.equal(report.totals.marketsSoldIn, 4);
  assert.equal(report.totals.revenueUsdMinor, 6000 + 3024 + 9144 + Math.round(8200 * 0.73));
});

test('sale defaults to the product base price converted to the market currency', async () => {
  const res = await post('/api/sales', { productId: lamp.id, marketCode: 'DE', quantity: 1 });
  assert.equal(res.status, 201);
  const { sale } = await res.json();
  assert.equal(sale.unitPriceMinor, Math.round(4000 / 1.08));
});

test('invalid sales are rejected with 400', async () => {
  const badQuantity = await post('/api/sales', { productId: tumbler.id, marketCode: 'US', quantity: 0 });
  assert.equal(badQuantity.status, 400);

  const fractionalQuantity = await post('/api/sales', { productId: tumbler.id, marketCode: 'US', quantity: 1.5 });
  assert.equal(fractionalQuantity.status, 400);

  const unknownProduct = await post('/api/sales', { productId: 'missing', marketCode: 'US' });
  assert.equal(unknownProduct.status, 404);

  const unknownMarket = await post('/api/sales', { productId: tumbler.id, marketCode: 'ZZ' });
  assert.equal(unknownMarket.status, 404);
});

test('sales survive a reload of the store file', () => {
  const reloaded = createStore({ filePath: store.filePath, seed: false });
  const report = reloaded.productSalesReport({ productId: tumbler.id, marketCode: 'ALL' });
  assert.equal(report.totals.orders, 4);
  assert.equal(report.totals.units, 8);
});
