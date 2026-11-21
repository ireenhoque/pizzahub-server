// Vercel also recognizes `src/server.ts`, so keep this as another safe entry
// point. It exports the Express app without listening or connecting to MongoDB
// at import time. The long-running local server is in `src/scripts/serve-local.ts`.
export { default } from './index.js';
