import { buildApp } from './app.js';
import { loadConfigOrExit } from './config.js';

const config = loadConfigOrExit();
const app = buildApp();
await app.listen({ port: config.port, host: config.host });
