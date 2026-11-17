import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT) || 3000;
const filePath = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json');

const store = createStore({ filePath });
const app = createApp({ store });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`dropship-sales-tracker listening on http://0.0.0.0:${port} (data: ${filePath})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
