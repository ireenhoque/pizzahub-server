// Forces production mode before the compiled server (and its env module) is
// imported. `npm start` therefore runs dist output without adding a runtime
// dependency on the dev-only cross-env package.
process.env.NODE_ENV = 'production';

await import('../server.js');
