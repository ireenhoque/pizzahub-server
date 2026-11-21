import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabaseReady } from '../src/app/config/bootstrap.js';
import vercelApp, { createVercelApp } from '../src/index.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const originalSecretKey = process.env.STRIPE_SECRET_KEY;
const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * Mirrors Vercel's @vercel/express entrypoint selection. Candidate order and
 * regex come from packages/express/src/build.ts in vercel/vercel.
 */
const VALID_FILENAMES = ['app', 'index', 'server', 'src/app', 'src/index', 'src/server'] as const;

const VALID_EXTENSIONS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'] as const;

const CANDIDATE_PATHS = VALID_FILENAMES.flatMap((filename) =>
  VALID_EXTENSIONS.map((extension) => `${filename}.${extension}`),
);

const EXPRESS_IMPORT_PATTERN = /(?:from|require|import)\s*(?:\(\s*)?["']express["']\s*(?:\))?/g;

function matchesExpressImport(filePath: string): boolean {
  return readFileSync(filePath, 'utf8').match(new RegExp(EXPRESS_IMPORT_PATTERN, 'g')) !== null;
}

function findVercelEntrypoint(): {
  selected: string | undefined;
  matchingCandidates: string[];
} {
  const matchingCandidates = CANDIDATE_PATHS.filter((candidate) => {
    const absolutePath = join(projectRoot, candidate);
    return existsSync(absolutePath) && matchesExpressImport(absolutePath);
  });

  return { selected: matchingCandidates[0], matchingCandidates };
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

beforeAll(() => {
  // Local test-only placeholders. Real .env values are never printed or changed.
  process.env.STRIPE_SECRET_KEY ??= 'sk_test_vercel_entry_placeholder';
  process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_vercel_entry_placeholder';
});

afterAll(() => {
  if (originalSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalSecretKey;

  if (originalWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
});

describe('Vercel Express entry point', () => {
  it('selects src/index.ts and no earlier candidate', () => {
    const { selected, matchingCandidates } = findVercelEntrypoint();
    const earlierCandidates = CANDIDATE_PATHS.slice(0, CANDIDATE_PATHS.indexOf('src/index.ts'));

    expect(selected).toBe('src/index.ts');
    expect(matchingCandidates).toEqual(['src/index.ts']);
    expect(matchingCandidates.filter((candidate) => earlierCandidates.includes(candidate))).toEqual(
      [],
    );
  });

  it('default-exports the gated Express app and never calls listen()', () => {
    const { selected } = findVercelEntrypoint();
    expect(selected).toBe('src/index.ts');

    const source = readFileSync(join(projectRoot, selected), 'utf8');
    const executableSource = stripComments(source);

    expect(typeof vercelApp).toBe('function');
    expect(executableSource).toMatch(/export\s+default\s+app\b/);
    expect(executableSource).toMatch(/createVercelApp\(\)/);
    expect(executableSource).toMatch(
      /bootstrapMiddleware:\s*options\.bootstrapMiddleware\s*\?\?\s*databaseBootstrapMiddleware/,
    );
    expect(executableSource).not.toMatch(/\.listen\s*\(/);
  });

  it('runs the database readiness gate before routes', async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const app = createVercelApp({
      bootstrapMiddleware: (_req, _res, next) => {
        void ready().then(() => next());
      },
    });

    await request(app).get('/api/health');

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('keeps the raw JSON body available for Stripe signature checks', async () => {
    const app = createVercelApp({
      bootstrapMiddleware: (_req, _res, next) => next(),
    });

    const response = await request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=invalid')
      .send('{"id":"evt_vercel_raw_body"}');

    // A parsed body would fail the route's Buffer.isBuffer() guard with 500.
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Webhook signature verification failed');
  });
});

describe('warm-invocation database bootstrap', () => {
  it('initializes once across concurrent ready calls', async () => {
    const connect = vi.fn().mockResolvedValue({} as Db);
    const ensureIndexes = vi.fn().mockResolvedValue(undefined);
    const enforceExpiredPremiumLimits = vi.fn().mockResolvedValue(undefined);

    const databaseReady = createDatabaseReady({
      connect,
      ensureIndexes,
      enforceExpiredPremiumLimits,
    });

    await Promise.all([databaseReady.ready(), databaseReady.ready(), databaseReady.ready()]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(ensureIndexes).toHaveBeenCalledTimes(1);
    expect(enforceExpiredPremiumLimits).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure and after an explicit reset', async () => {
    const connect = vi
      .fn<() => Promise<Db>>()
      .mockRejectedValueOnce(new Error('INTERNAL_BOOTSTRAP_DETAIL_MUST_NOT_LEAK'))
      .mockResolvedValue({} as Db);
    const ensureIndexes = vi.fn().mockResolvedValue(undefined);
    const enforceExpiredPremiumLimits = vi.fn().mockResolvedValue(undefined);

    const databaseReady = createDatabaseReady({
      connect,
      ensureIndexes,
      enforceExpiredPremiumLimits,
    });

    await expect(databaseReady.ready()).rejects.toMatchObject({
      statusCode: 503,
      message: 'Database is not ready',
    });

    await databaseReady.ready();
    expect(connect).toHaveBeenCalledTimes(2);

    databaseReady.reset();
    await databaseReady.ready();
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
