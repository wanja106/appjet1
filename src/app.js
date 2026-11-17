import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

export function createApp({ store }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const route = (handler) => (req, res, next) => {
    try {
      handler(req, res);
    } catch (err) {
      next(err);
    }
  };

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'dropship-sales-tracker' });
  });

  app.get('/api/products', (req, res) => {
    res.json({ products: store.listProducts() });
  });

  app.post('/api/products', route((req, res) => {
    res.status(201).json({ product: store.createProduct(req.body ?? {}) });
  }));

  app.get('/api/markets', (req, res) => {
    res.json({ markets: store.listMarkets() });
  });

  app.get('/api/sales', route((req, res) => {
    const sales = store.listSales({
      productId: req.query.productId,
      marketCode: req.query.market,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });
    res.json({ count: sales.length, sales });
  }));

  app.post('/api/sales', route((req, res) => {
    res.status(201).json({ sale: store.recordSale(req.body ?? {}) });
  }));

  app.delete('/api/sales/:id', route((req, res) => {
    store.deleteSale(req.params.id);
    res.status(204).end();
  }));

  // The core feature: sales of one product, in one market or across any market.
  app.get('/api/reports/product-sales', route((req, res) => {
    const productId = req.query.productId;
    if (!productId) {
      res.status(400).json({
        error: { code: 'missing_product', message: 'productId query parameter is required' },
      });
      return;
    }
    res.json(store.productSalesReport({ productId, marketCode: req.query.market ?? 'ALL' }));
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `No API route for ${req.method} ${req.originalUrl}` } });
  });

  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: {
        code: err.code || 'internal_error',
        message: status >= 500 ? 'Unexpected server error' : err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  });

  return app;
}
