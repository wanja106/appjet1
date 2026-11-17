import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  constructor(message, code = 'invalid_request', details) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
    this.status = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message, code = 'not_found', details) {
    super(message);
    this.name = 'NotFoundError';
    this.code = code;
    this.details = details;
    this.status = 404;
  }
}

/** Markets the dropshipping store sells into. usdRate = USD per 1 unit of local currency. */
export const DEFAULT_MARKETS = [
  { code: 'US', name: 'United States', currency: 'USD', usdRate: 1 },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', usdRate: 1.27 },
  { code: 'DE', name: 'Germany', currency: 'EUR', usdRate: 1.08 },
  { code: 'CA', name: 'Canada', currency: 'CAD', usdRate: 0.73 },
  { code: 'AU', name: 'Australia', currency: 'AUD', usdRate: 0.66 },
  { code: 'MX', name: 'Mexico', currency: 'MXN', usdRate: 0.058 },
];

/** basePriceMinor is the USD price in cents; local prices are derived per market. */
export const DEFAULT_PRODUCTS = [
  { sku: 'DS-TUMB-01', name: 'Insulated Tumbler 20oz', category: 'Drinkware', basePriceMinor: 2999 },
  { sku: 'DS-LAMP-02', name: 'Sunset Projection Lamp', category: 'Home', basePriceMinor: 3499 },
  { sku: 'DS-MAT-03', name: 'Non-Slip Yoga Mat', category: 'Fitness', basePriceMinor: 4599 },
  { sku: 'DS-ORG-04', name: 'Cable Organizer Kit', category: 'Accessories', basePriceMinor: 1499 },
];

const CHANNELS = ['Shopify', 'TikTok Shop', 'Amazon', 'Etsy', 'Direct'];
const DAY_MS = 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();

function emptyData() {
  return { version: 1, products: [], markets: [], sales: [], seededAt: null };
}

function readData(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyData(), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function asInteger(value, field) {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
    throw new ValidationError(`${field} must be a whole number`, 'invalid_field', { field });
  }
  return num;
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === '') return nowIso();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field} must be a valid date`, 'invalid_field', { field });
  }
  return date.toISOString();
}

/** USD cents for a local-currency amount, rounded per line so totals stay stable. */
export function toUsdMinor(localMinor, usdRate) {
  return Math.round(localMinor * usdRate);
}

export function createStore({ filePath = null, seed = true, seedSales = seed } = {}) {
  const data = (filePath && readData(filePath)) || emptyData();

  const persist = () => {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  };

  if (!data.markets.length) data.markets = DEFAULT_MARKETS.map((m) => ({ ...m }));

  if (seed && !data.products.length) {
    data.products = DEFAULT_PRODUCTS.map((p) => ({
      id: randomUUID(),
      sku: p.sku,
      name: p.name,
      category: p.category,
      basePriceMinor: p.basePriceMinor,
      createdAt: nowIso(),
    }));
  }

  // One-time demo history so the tracker is not empty on first open.
  if (seedSales && !data.seededAt && data.products.length && data.markets.length) {
    let seedState = 42;
    const rand = () => {
      seedState = (seedState * 1103515245 + 12345) % 2147483648;
      return seedState / 2147483648;
    };
    const start = Date.now() - 20 * DAY_MS;
    for (let day = 0; day < 21; day += 1) {
      for (const product of data.products) {
        const salesToday = Math.floor(rand() * 3);
        for (let n = 0; n < salesToday; n += 1) {
          const market = data.markets[Math.floor(rand() * data.markets.length)];
          const quantity = 1 + Math.floor(rand() * 2);
          const localMinor = Math.round(product.basePriceMinor / market.usdRate);
          data.sales.push({
            id: randomUUID(),
            productId: product.id,
            marketCode: market.code,
            quantity,
            unitPriceMinor: localMinor,
            soldAt: new Date(start + day * DAY_MS + Math.floor(rand() * DAY_MS)).toISOString(),
            channel: CHANNELS[Math.floor(rand() * CHANNELS.length)],
            orderRef: `SEED-${day + 1}-${product.sku.slice(-2)}-${n + 1}`,
            createdAt: nowIso(),
          });
        }
      }
    }
    data.seededAt = nowIso();
  }

  const getProduct = (id) => data.products.find((p) => p.id === id) || null;
  const getMarket = (code) => data.markets.find((m) => m.code === String(code).toUpperCase()) || null;

  function requireProduct(id) {
    const product = getProduct(id);
    if (!product) {
      throw new NotFoundError(`Product ${id} not found`, 'unknown_product', { productId: id });
    }
    return product;
  }

  function requireMarket(code) {
    const market = getMarket(code);
    if (!market) {
      throw new NotFoundError(`Market ${code} is not tracked`, 'unknown_market', { marketCode: code });
    }
    return market;
  }

  const api = {
    get filePath() {
      return filePath;
    },

    listProducts() {
      return [...data.products].sort((a, b) => a.name.localeCompare(b.name));
    },

    getProduct,

    createProduct(input = {}) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new ValidationError('name is required', 'invalid_field', { field: 'name' });
      const sku = String(input.sku ?? '').trim().toUpperCase() || `DS-${randomUUID().slice(0, 8).toUpperCase()}`;
      if (data.products.some((p) => p.sku === sku)) {
        throw new ValidationError(`SKU ${sku} already exists`, 'duplicate_sku', { field: 'sku' });
      }
      const basePriceMinor = input.basePriceMinor === undefined
        ? 1999
        : asInteger(input.basePriceMinor, 'basePriceMinor');
      if (basePriceMinor < 0) {
        throw new ValidationError('basePriceMinor must not be negative', 'invalid_field', { field: 'basePriceMinor' });
      }
      const product = {
        id: randomUUID(),
        sku,
        name,
        category: String(input.category ?? 'General').trim() || 'General',
        basePriceMinor,
        createdAt: nowIso(),
      };
      data.products.push(product);
      persist();
      return product;
    },

    listMarkets() {
      return [...data.markets];
    },

    getMarket,

    /** Local (market currency) price for a product, derived from its USD base price. */
    priceFor(product, market) {
      return Math.round(product.basePriceMinor / market.usdRate);
    },

    recordSale(input = {}) {
      const product = requireProduct(String(input.productId ?? ''));
      const market = requireMarket(input.marketCode ?? input.market ?? '');

      const quantity = input.quantity === undefined ? 1 : asInteger(input.quantity, 'quantity');
      if (quantity < 1) {
        throw new ValidationError('quantity must be at least 1', 'invalid_field', { field: 'quantity' });
      }

      let unitPriceMinor;
      if (input.unitPriceMinor === undefined || input.unitPriceMinor === '') {
        unitPriceMinor = api.priceFor(product, market);
      } else {
        unitPriceMinor = asInteger(input.unitPriceMinor, 'unitPriceMinor');
      }
      if (unitPriceMinor < 0) {
        throw new ValidationError('unitPriceMinor must not be negative', 'invalid_field', { field: 'unitPriceMinor' });
      }

      const sale = {
        id: randomUUID(),
        productId: product.id,
        marketCode: market.code,
        quantity,
        unitPriceMinor,
        soldAt: parseDate(input.soldAt, 'soldAt'),
        channel: String(input.channel ?? 'Direct').trim() || 'Direct',
        orderRef: input.orderRef ? String(input.orderRef).trim() : null,
        createdAt: nowIso(),
      };
      data.sales.push(sale);
      persist();
      return api.decorateSale(sale);
    },

    decorateSale(sale) {
      const product = getProduct(sale.productId);
      const market = getMarket(sale.marketCode);
      const lineLocalMinor = sale.quantity * sale.unitPriceMinor;
      const usdRate = market ? market.usdRate : 1;
      return {
        ...sale,
        productName: product ? product.name : 'Unknown product',
        sku: product ? product.sku : null,
        marketName: market ? market.name : sale.marketCode,
        currency: market ? market.currency : 'USD',
        lineLocalMinor,
        lineUsdMinor: toUsdMinor(lineLocalMinor, usdRate),
      };
    },

    deleteSale(id) {
      const index = data.sales.findIndex((s) => s.id === id);
      if (index === -1) throw new NotFoundError(`Sale ${id} not found`, 'unknown_sale', { saleId: id });
      const [removed] = data.sales.splice(index, 1);
      persist();
      return removed;
    },

    listSales({ productId, marketCode, from, to, limit = 100 } = {}) {
      const fromTime = from ? new Date(from).getTime() : null;
      const toTime = to ? new Date(to).getTime() : null;
      const marketFilter = marketCode && String(marketCode).toUpperCase() !== 'ALL'
        ? String(marketCode).toUpperCase()
        : null;

      const rows = data.sales
        .filter((sale) => (productId ? sale.productId === productId : true))
        .filter((sale) => (marketFilter ? sale.marketCode === marketFilter : true))
        .filter((sale) => (fromTime ? new Date(sale.soldAt).getTime() >= fromTime : true))
        .filter((sale) => (toTime ? new Date(sale.soldAt).getTime() <= toTime : true))
        .sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));

      const max = Math.max(1, Math.min(Number(limit) || 100, 500));
      return rows.slice(0, max).map(api.decorateSale);
    },

    /**
     * Sales report for one product. marketCode 'ALL' (or omitted) aggregates every
     * market the product sold in and keeps a per-market breakdown.
     */
    productSalesReport({ productId, marketCode = 'ALL' } = {}) {
      const product = requireProduct(String(productId ?? ''));
      const isAll = !marketCode || String(marketCode).toUpperCase() === 'ALL';
      const market = isAll ? null : requireMarket(marketCode);

      const rows = data.sales
        .filter((sale) => sale.productId === product.id)
        .filter((sale) => (market ? sale.marketCode === market.code : true))
        .sort((a, b) => new Date(a.soldAt) - new Date(b.soldAt));

      const totals = { units: 0, orders: rows.length, revenueUsdMinor: 0, revenueLocalMinor: 0 };
      const byMarketMap = new Map();
      const dailyMap = new Map();
      const channels = new Map();

      for (const sale of rows) {
        const saleMarket = getMarket(sale.marketCode);
        const usdRate = saleMarket ? saleMarket.usdRate : 1;
        const currency = saleMarket ? saleMarket.currency : 'USD';
        const lineLocalMinor = sale.quantity * sale.unitPriceMinor;
        const lineUsdMinor = toUsdMinor(lineLocalMinor, usdRate);
        const day = sale.soldAt.slice(0, 10);

        totals.units += sale.quantity;
        totals.revenueUsdMinor += lineUsdMinor;
        totals.revenueLocalMinor += lineLocalMinor;

        const entry = byMarketMap.get(sale.marketCode) || {
          marketCode: sale.marketCode,
          marketName: saleMarket ? saleMarket.name : sale.marketCode,
          currency,
          units: 0,
          orders: 0,
          revenueLocalMinor: 0,
          revenueUsdMinor: 0,
        };
        entry.units += sale.quantity;
        entry.orders += 1;
        entry.revenueLocalMinor += lineLocalMinor;
        entry.revenueUsdMinor += lineUsdMinor;
        byMarketMap.set(sale.marketCode, entry);

        const dayEntry = dailyMap.get(day) || { date: day, units: 0, revenueUsdMinor: 0 };
        dayEntry.units += sale.quantity;
        dayEntry.revenueUsdMinor += lineUsdMinor;
        dailyMap.set(day, dayEntry);

        channels.set(sale.channel, (channels.get(sale.channel) || 0) + sale.quantity);
      }

      const byMarket = [...byMarketMap.values()]
        .sort((a, b) => b.revenueUsdMinor - a.revenueUsdMinor)
        .map((entry) => ({
          ...entry,
          share: totals.revenueUsdMinor > 0
            ? Math.round((entry.revenueUsdMinor / totals.revenueUsdMinor) * 1000) / 1000
            : 0,
          avgUnitPriceLocalMinor: entry.units > 0 ? Math.round(entry.revenueLocalMinor / entry.units) : 0,
        }));

      return {
        product: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          category: product.category,
          basePriceMinor: product.basePriceMinor,
        },
        market: market ? market.code : 'ALL',
        marketLabel: market ? `${market.name} (${market.code})` : 'Any market',
        currency: market ? market.currency : 'USD',
        totals: {
          ...totals,
          avgOrderValueUsdMinor: totals.orders > 0 ? Math.round(totals.revenueUsdMinor / totals.orders) : 0,
          marketsSoldIn: byMarket.length,
        },
        byMarket,
        daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
        channels: [...channels.entries()].map(([channel, units]) => ({ channel, units })),
        firstSaleAt: rows.length ? rows[0].soldAt : null,
        lastSaleAt: rows.length ? rows[rows.length - 1].soldAt : null,
      };
    },
  };

  if (filePath && (seed || data.products.length || data.markets.length)) persist();

  return api;
}
