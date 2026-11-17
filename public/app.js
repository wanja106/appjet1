const state = {
  products: [],
  markets: [],
  report: null,
  sales: [],
};

const el = (id) => document.getElementById(id);

const productSelect = el('product-select');
const marketSelect = el('market-select');
const formProduct = el('form-product');
const formMarket = el('form-market');
const form = el('sale-form');
const formStatus = el('form-status');

function money(minor, currency = 'USD') {
  const value = (Number(minor) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function marketByCode(code) {
  return state.markets.find((m) => m.code === code) || null;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = body?.error?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

function fillSelect(select, options, selected) {
  select.innerHTML = '';
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    if (option.value === selected) node.selected = true;
    select.append(node);
  }
}

function renderCards(report) {
  const container = el('summary-cards');
  const totals = report.totals;
  const cards = [
    {
      label: 'Units sold',
      value: totals.units.toLocaleString(),
      sub: `${totals.orders} order${totals.orders === 1 ? '' : 's'}`,
    },
    {
      label: 'Revenue (USD)',
      value: money(totals.revenueUsdMinor, 'USD'),
      sub: `across ${totals.marketsSoldIn} market${totals.marketsSoldIn === 1 ? '' : 's'}`,
    },
    {
      label: 'Avg order value',
      value: money(totals.avgOrderValueUsdMinor, 'USD'),
      sub: 'USD per order',
    },
    {
      label: 'Last sale',
      value: report.lastSaleAt ? new Date(report.lastSaleAt).toLocaleDateString() : '—',
      sub: report.firstSaleAt ? `first ${new Date(report.firstSaleAt).toLocaleDateString()}` : 'no sales yet',
    },
  ];

  container.innerHTML = cards
    .map(
      (card) => `
      <div class="card">
        <div class="label">${card.label}</div>
        <div class="value">${card.value}</div>
        <div class="sub">${card.sub}</div>
      </div>`,
    )
    .join('');
}

function renderBreakdown(report) {
  const container = el('market-breakdown');
  const hint = el('market-hint');
  hint.textContent = `${report.product.name} · ${report.marketLabel}`;

  if (!report.byMarket.length) {
    container.innerHTML = '<p class="empty">No sales recorded for this product yet. Log one on the right to start tracking.</p>';
    return;
  }

  container.innerHTML = report.byMarket
    .map((entry) => {
      const width = Math.max(2, Math.round((entry.share || 0) * 100));
      return `
        <div class="market-row">
          <div>
            <div class="name">${entry.marketName} <span class="pill">${entry.marketCode}</span></div>
            <div class="meta">${entry.units} unit${entry.units === 1 ? '' : 's'} · ${entry.orders} order${entry.orders === 1 ? '' : 's'} · avg ${money(entry.avgUnitPriceLocalMinor, entry.currency)}</div>
          </div>
          <div class="amount">
            <div>${money(entry.revenueUsdMinor, 'USD')}</div>
            <div class="meta">${money(entry.revenueLocalMinor, entry.currency)} · ${Math.round((entry.share || 0) * 100)}%</div>
          </div>
          <div class="bar"><span style="width:${width}%"></span></div>
        </div>`;
    })
    .join('');
}

function renderSales(sales, report) {
  const tbody = el('sales-table').querySelector('tbody');
  const hint = el('recent-hint');
  hint.textContent = `${sales.length} most recent sale${sales.length === 1 ? '' : 's'} for ${report.product.name} · ${report.marketLabel}`;

  if (!sales.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No sales match this product and market.</td></tr>';
    return;
  }

  tbody.innerHTML = sales
    .map(
      (sale) => `
      <tr>
        <td>${new Date(sale.soldAt).toLocaleDateString()}</td>
        <td>${sale.marketName} <span class="pill">${sale.marketCode}</span></td>
        <td class="num">${sale.quantity}</td>
        <td class="num">${money(sale.unitPriceMinor, sale.currency)}</td>
        <td class="num">${money(sale.lineLocalMinor, sale.currency)}</td>
        <td class="num">${money(sale.lineUsdMinor, 'USD')}</td>
        <td>${sale.channel}</td>
        <td>${sale.orderRef || '—'}</td>
      </tr>`,
    )
    .join('');
}

async function refresh() {
  const productId = productSelect.value || state.products[0]?.id;
  const market = marketSelect.value || 'ALL';
  if (!productId) return;

  const query = new URLSearchParams({ productId, market });
  const [report, sales] = await Promise.all([
    api(`/api/reports/product-sales?${query}`),
    api(`/api/sales?${new URLSearchParams({ productId, market, limit: '25' })}`),
  ]);

  state.report = report;
  state.sales = sales.sales;
  renderCards(report);
  renderBreakdown(report);
  renderSales(state.sales, report);
}

async function loadReferenceData() {
  const [productsRes, marketsRes] = await Promise.all([api('/api/products'), api('/api/markets')]);
  state.products = productsRes.products;
  state.markets = marketsRes.markets;

  const productOptions = state.products.map((p) => ({ value: p.id, label: `${p.name} · ${p.sku}` }));
  const marketOptions = [
    { value: 'ALL', label: 'Any market' },
    ...state.markets.map((m) => ({ value: m.code, label: `${m.name} (${m.currency})` })),
  ];

  fillSelect(productSelect, productOptions, state.products[0]?.id);
  fillSelect(marketSelect, marketOptions, 'ALL');
  fillSelect(formProduct, productOptions, state.products[0]?.id);
  fillSelect(formMarket, marketOptions.slice(1), state.markets[0]?.code);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el('submit-sale');
  const data = new FormData(form);
  const payload = {
    productId: data.get('productId'),
    marketCode: data.get('marketCode'),
    quantity: Number(data.get('quantity') || 1),
    soldAt: data.get('soldAt') ? new Date(`${data.get('soldAt')}T12:00:00`).toISOString() : undefined,
    channel: data.get('channel') || 'Direct',
    orderRef: data.get('orderRef') || undefined,
  };
  const price = data.get('unitPrice');
  if (price !== null && String(price).trim() !== '') {
    payload.unitPriceMinor = Math.round(Number(price) * 100);
  }

  button.disabled = true;
  formStatus.className = 'form-status';
  formStatus.textContent = 'Saving…';
  try {
    const { sale } = await api('/api/sales', { method: 'POST', body: JSON.stringify(payload) });
    formStatus.className = 'form-status ok';
    formStatus.textContent = `Recorded ${sale.quantity} × ${sale.productName} in ${sale.marketName}.`;

    // Follow the sale the user just logged.
    productSelect.value = sale.productId;
    if (marketSelect.value !== 'ALL' && marketSelect.value !== sale.marketCode) {
      marketSelect.value = 'ALL';
    }
    form.reset();
    await refresh();
  } catch (err) {
    formStatus.className = 'form-status error';
    formStatus.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

productSelect.addEventListener('change', () => {
  refresh().catch((err) => {
    formStatus.className = 'form-status error';
    formStatus.textContent = err.message;
  });
});

marketSelect.addEventListener('change', () => {
  refresh().catch((err) => {
    formStatus.className = 'form-status error';
    formStatus.textContent = err.message;
  });
});

loadReferenceData()
  .then(refresh)
  .catch((err) => {
    formStatus.className = 'form-status error';
    formStatus.textContent = `Could not load the tracker: ${err.message}`;
  });
