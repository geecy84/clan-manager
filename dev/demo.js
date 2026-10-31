// npm run demo — runs the whole app against a fake API (no key needed), data kept in ./data-demo
import { startMock, MY } from './mock-api.js';
process.env.CR_API_KEY = 'demo';
process.env.CR_API_BASE = 'http://localhost:4010/v1';
process.env.CLAN_TAG = MY;
process.env.DATA_DIR = process.env.DATA_DIR || './data-demo';
await startMock(4010);
await import('../src/server.js');
