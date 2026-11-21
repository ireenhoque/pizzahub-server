# PizzaHub deployment guide

This guide is provider-neutral. The repository contains no `vercel.json`,
`Dockerfile`, `Procfile`, or other platform-specific deployment configuration,
so no hosting provider is assumed. Use any Node.js host for the Express API and
any Next.js-capable Node host for the client.

## 1. Layout

- `pizzahub-client/` — Next.js 16 / React 19 frontend and Better Auth server
  routes (`/api/auth/*`)
- `pizzahub-server/` — Express 5 / TypeScript API, MongoDB access, Stripe
  subscription webhooks

Both apps use the same MongoDB database. Better Auth owns the `users`
collection; the Express API reads it on every authenticated request.

## 2. Install, build, and start

### Backend

```bash
cd pizzahub-server
npm ci
npm run build
npm start
```

`npm start` runs the compiled `dist` output and forces `NODE_ENV=production`
before loading the app. Database connection and required index verification
finish before `app.listen()` is called. `npm run dev` and `npm run start:prod`
remain available for local development and direct compiled startup.

Optional explicit index initialization (creates all defined indexes, including
those on empty collections):

```bash
npm run db:indexes
```

### Frontend

```bash
cd pizzahub-client
npm ci
npm run build
npm start
```

`NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_SITE_URL` must be present at build
time in production. The build fails with the variable name (never its value)
when they are missing or invalid. The remaining auth variables are read only at
runtime by Better Auth.

## 3. Environment variables

Never commit `.env`, `.env.local`, or real credentials. Copy the tracked
`.env.example` files and inject values through the host's secret manager.

### Backend (`pizzahub-server/.env.example`)

| Variable | Purpose | Required |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode (`development` / `production`) | Yes |
| `PORT` | HTTP listening port | Yes |
| `CORS_ALLOWED_ORIGINS` | Comma-separated exact browser origins; required in production, wildcards rejected | Production yes |
| `MONGODB_URI` | MongoDB connection string | Yes |
| `DB_NAME` | Shared PizzaHub database name | Yes |
| `BETTER_AUTH_JWKS_URL` | Frontend JWKS endpoint, usually `https://<frontend>/api/auth/jwks` | Yes |
| `JWT_ISSUER` | Expected `iss`; must match the client's `JWT_ISSUER` | Yes |
| `JWT_AUDIENCE` | Expected `aud`; must match the client's `JWT_AUDIENCE` | Yes |
| `IMGBB_API_KEY` | Server-side image upload key | Yes |
| `IMGBB_UPLOAD_URL` | Optional upload endpoint override | No |
| `STRIPE_SECRET_KEY` | Stripe API key | Billing endpoints |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe signatures on the raw webhook body | Webhook |
| `STRIPE_PREMIUM_PRICE_ID` | Existing server-owned Premium recurring Price ID | Checkout |
| `STRIPE_SUCCESS_URL` | Browser return URL after successful checkout | Checkout |
| `STRIPE_CANCEL_URL` | Browser return URL after cancelled checkout | Checkout |

Stripe variables are read lazily so non-billing endpoints still boot when
Stripe is not configured; affected endpoints return `503` naming the missing
variable.

### Frontend (`pizzahub-client/.env.example`)

| Variable | Purpose | Required |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | Browser-reachable API base, including `/api` | Yes, at build time in production |
| `NEXT_PUBLIC_SITE_URL` | Canonical frontend origin for metadata and absolute links | Yes, at build time in production |
| `BETTER_AUTH_URL` | Canonical Better Auth origin and JWT `iss`/`aud` source | Yes, at runtime |
| `BETTER_AUTH_SECRET` | Signs cookies and encrypts stored JWT keys | Yes, at runtime |
| `MONGODB_URI` | Same MongoDB cluster as the backend | Yes, at runtime |
| `DB_NAME` | Same database name as the backend | Yes, at runtime |
| `JWT_ISSUER` | Must exactly match `BETTER_AUTH_URL` and backend `JWT_ISSUER` | Yes, at runtime |
| `JWT_AUDIENCE` | Must exactly match `BETTER_AUTH_URL` and backend `JWT_AUDIENCE` | Yes, at runtime |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Yes, at runtime |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Yes, at runtime |

No `NEXT_PUBLIC_` variable should ever contain a secret. Error messages name
the variable but never include its value.

## 4. MongoDB and indexes

Use a MongoDB Atlas (or equivalent) URI with network access granted to both
apps. The backend calls `ensureRequiredIndexes(db)` during startup and refuses
to listen if required index verification fails; optional indexes on not-yet-
existing collections are skipped without creating empty business collections.
`npm run db:indexes` can be run once during provisioning to create every
defined index explicitly. Re-running it is a no-op for identical definitions.

## 5. URLs and CORS

- Backend API base: `https://<api-host>/api`
- Frontend/Better Auth origin: `https://<frontend-host>`
- Set backend `CORS_ALLOWED_ORIGINS=https://<frontend-host>` (add extra exact
  origins as a comma-separated list).
- In development the backend defaults to `http://localhost:3000` and
  `http://127.0.0.1:3000`; production has no implicit origins.
- Preflight `OPTIONS` returns `204` with
  `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS` and allows `Authorization`
  and `Content-Type`.
- The browser client sends the short-lived JWT in `Authorization: Bearer`;
  CORS credentials are not required.
- Stripe success/cancel URLs must point to existing frontend pages.

## 6. Better Auth, JWKS, issuer, audience, and Google OAuth

1. Enable the Better Auth JWT plugin with RS256. The app already configures
   `jwks` with `RS256` and a 2048-bit modulus.
2. Point backend `BETTER_AUTH_JWKS_URL` at
   `https://<frontend-host>/api/auth/jwks`.
3. Use the same exact origin for `BETTER_AUTH_URL` (client),
   `JWT_ISSUER` (client), `JWT_AUDIENCE` (client), `JWT_ISSUER` (backend), and
   `JWT_AUDIENCE` (backend). Do not add trailing slashes.
4. Register `https://<frontend-host>/api/auth/callback/google` as an authorized
   redirect URI in Google Cloud Console and set the client ID/secret on the
   frontend only.
5. Keep `BETTER_AUTH_SECRET`, Google credentials, and MongoDB credentials
   server-side on the Next.js host.

## 7. Stripe

Keep all Stripe keys and webhook secrets on the backend. Sandbox and live mode
use separate API keys, webhook secrets, and Price IDs; stored customer and
subscription IDs are mode-specific, so switching modes is a data migration
decision, not a code change. Reuse the existing Premium Price ID through
`STRIPE_PREMIUM_PRICE_ID`; do not recreate Stripe products or prices.

Webhook endpoint:

```text
POST https://<api-host>/api/stripe/webhook
```

Subscribe it to these event types:

- `checkout.session.completed`
- `checkout.session.expired`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

The endpoint verifies the raw request body with `STRIPE_WEBHOOK_SECRET` and is
idempotent. Use a Sandbox endpoint while testing; create a separate live
endpoint for production.

## 8. Recommended deployment order

1. Provision MongoDB and confirm network access from both apps.
2. Deploy the frontend with all public build-time URLs and runtime auth
   secrets. Confirm `/api/auth/jwks` responds.
3. Set backend `CORS_ALLOWED_ORIGINS` to the deployed frontend origin, then
   deploy the backend. Confirm startup logs show a successful database boot.
4. Run `npm run db:indexes` once if provisioning empty collections.
5. Configure Google OAuth redirect URIs and Stripe success/cancel URLs with
   the deployed frontend origin.
6. Configure the Stripe webhook endpoint and secret, then perform a Sandbox
   checkout and webhook smoke test.
7. Only then switch to live-mode Stripe values if required.

## 9. Smoke tests

- `GET https://<api-host>/api/health` returns a healthy response.
- `GET https://<api-host>/api/menu` returns the public menu.
- `OPTIONS` preflight from the configured frontend origin returns `204` with
  the expected allow-methods/allow-headers; an unknown origin is not reflected.
- `GET https://<frontend-host>/api/auth/jwks` returns JSON Web Keys.
- Sign in, then call a protected API route with the Bearer token.
- Vendor: create/edit a menu item and verify Premium/free-plan behavior.
- Customer: place an order; admin: load the overview dashboard.
- Send a signed Sandbox Stripe test event to `/api/stripe/webhook` and verify a
  `200` plus the expected subscription state change.

## 10. Pre-flight blockers to resolve outside this repository

- Choose concrete frontend/backend hosts, DNS names, and TLS certificates.
- Supply real MongoDB, Better Auth, Google OAuth, ImgBB, and Stripe values.
- Confirm the Stripe mode and corresponding existing Premium Price ID.
- Register the deployed Google OAuth callback and Stripe webhook endpoint.
