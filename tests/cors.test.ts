import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  corsAllowedOrigins,
  DEVELOPMENT_CORS_ORIGINS,
  parseCorsAllowedOrigins,
} from '../src/app/config/cors.js';

const app = createApp();
const allowedOrigin = corsAllowedOrigins[0] ?? DEVELOPMENT_CORS_ORIGINS[0];

describe('CORS configuration', () => {
  it('reflects an explicitly allowed origin', async () => {
    const response = await request(app).get('/api/health').set('Origin', allowedOrigin);

    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
  });

  it('does not reflect a disallowed origin', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'https://not-allowed.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight with the required methods and headers', async () => {
    const response = await request(app)
      .options('/api/menu')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'content-type',
    );
  });

  it('keeps localhost defaults for development', () => {
    expect(parseCorsAllowedOrigins(undefined, 'development')).toEqual(DEVELOPMENT_CORS_ORIGINS);
  });

  it('requires explicit origins in production', () => {
    expect(() => parseCorsAllowedOrigins(undefined, 'production')).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it('rejects wildcards and non-origin values', () => {
    expect(() => parseCorsAllowedOrigins('*', 'development')).toThrow(/wildcard/);
    expect(() => parseCorsAllowedOrigins('https://app.example.com/path', 'development')).toThrow(
      /http\(s\) origins/,
    );
  });

  it('normalizes a comma-separated production origin list', () => {
    expect(
      parseCorsAllowedOrigins('https://app.example.com/, https://admin.example.com', 'production'),
    ).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });
});
