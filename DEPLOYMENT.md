# PizzaHub deployment guide

PizzaHub uses two separate GitHub repositories and two Vercel projects:

- `pizzahub-client` GitHub repository — Next.js 16 / React 19 frontend and Better
  Auth routes (`/api/auth/*`)
- `pizzahub-server` GitHub repository — Express 5 / TypeScript API deployed as a
  Vercel Function using Vercel's zero-configuration Express support

Each Vercel project connects to its own repository and uses the repository root
(`./`) as Root Directory. Do not select a subdirectory.

No concrete deployment hostnames are hardcoded. Use your Vercel-assigned domains
or custom domains through environment variables.

## 1. Local install, build, and start

### Backend

```bash
# Run from the pizzahub-server repository root
npm ci
npm run dev       # local development with tsx watch
npm run build     # tsc -> dist
npm start         # compiled production server, local long-running process
```

`npm start` runs `dist/scripts/start-production.js`, which forces
`NODE_ENV=production` and starts `dist/scripts/serve-local.js`. The local server
completes the memoized database bootstrap before `app.listen()`. `package.json`
also points `main` at `dist/scripts/serve-local.js`, so direct Node execution
uses the long-running server rather than a no-op re-export.

For Vercel, do **not** use `npm start`. Vercel imports `src/index.ts`, exports
the Express app, and never calls `app.listen()`.

Optional explicit index initialization:

```bash
npm run db:indexes
```

### Frontend

```bash
# Run from the pizzahub-client repository root
npm ci
npm run dev
npm run build
npm start
```

`NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_SITE_URL` are required for a
production build. They are inlined at build time and must be set before Vercel
starts the build.

## 2. Vercel project settings

### `pizzahub-server` Vercel project

| Setting          | Value                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Git Repository   | `pizzahub-server` GitHub repository                                                                               |
| Root Directory   | `./` (repository root — do not select a subdirectory)                                                             |
| Framework Preset | Express (auto-detected; selected entry point `src/index.ts`)                                                      |
| Build Command    | Leave default / Vercel zero-config. Do **not** set `npm run build`; that emits `dist/` for the local Node server. |
| Output Directory | Leave default / empty                                                                                             |
| Install Command  | `npm install` (default)                                                                                           |
| Node.js Version  | `22.x` (20+ required)                                                                                             |
| Function runtime | Node.js (default), Fluid compute                                                                                  |

Vercel's zero-config Express builder checks candidate filenames in this order:
`app`, `index`, `server`, `src/app`, `src/index`, `src/server` (with JS/TS
extensions). It keeps candidates whose file contents contain a textual `express`
import, then selects the first match. It does not check for a default export
before selecting.

The app factory therefore lives in `src/create-app.ts`, which is deliberately
not a Vercel candidate filename. The only matching candidate is `src/index.ts`,
so that is the selected entry point. `src/index.ts` default-exports the gated
Express app from `createVercelApp()`, applies `databaseBootstrapMiddleware`, and
never calls `app.listen()`. `src/server.ts` is a harmless re-export and is not
selected because it has no `express` import match.
`src/scripts/serve-local.ts` is CLI-only and is not used by Vercel.

### `pizzahub-client` Vercel project

| Setting          | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Git Repository   | `pizzahub-client` GitHub repository                   |
| Root Directory   | `./` (repository root — do not select a subdirectory) |
| Framework Preset | Next.js (auto-detected)                               |
| Build Command    | `npm run build` (default)                             |
| Output Directory | `.next` (default)                                     |
| Install Command  | `npm install` (default)                               |
| Node.js Version  | `22.x`                                                |

No `vercel.json` is required for either project.

## 3. Environment variables

Never commit `.env`, `.env.local`, or real credentials. Set these in the Vercel
dashboard (Production and Preview as appropriate). Never print their values.

### Backend Vercel project

| Variable                  | Purpose                                                                | Required          |
| ------------------------- | ---------------------------------------------------------------------- | ----------------- |
| `NODE_ENV`                | Vercel injects `production`; no manual value normally needed           | Vercel-managed    |
| `CORS_ALLOWED_ORIGINS`    | Exact deployed frontend origin(s), comma-separated; wildcards rejected | Yes               |
| `MONGODB_URI`             | MongoDB connection string                                              | Yes               |
| `DB_NAME`                 | Shared PizzaHub database name                                          | Yes               |
| `BETTER_AUTH_JWKS_URL`    | `https://<frontend-origin>/api/auth/jwks`                              | Yes               |
| `JWT_ISSUER`              | Expected `iss`; must match the frontend's `JWT_ISSUER`                 | Yes               |
| `JWT_AUDIENCE`            | Expected `aud`; must match the frontend's `JWT_AUDIENCE`               | Yes               |
| `IMGBB_API_KEY`           | Server-side image upload key                                           | Yes               |
| `IMGBB_UPLOAD_URL`        | Optional upload endpoint override                                      | No                |
| `STRIPE_SECRET_KEY`       | Stripe API key                                                         | Billing endpoints |
| `STRIPE_WEBHOOK_SECRET`   | Verifies Stripe signatures on the raw webhook body                     | Webhook           |
| `STRIPE_PREMIUM_PRICE_ID` | Existing server-owned Premium recurring Price ID                       | Checkout          |
| `STRIPE_SUCCESS_URL`      | Browser return URL after successful checkout                           | Checkout          |
| `STRIPE_CANCEL_URL`       | Browser return URL after cancelled checkout                            | Checkout          |

`PORT` is not required on Vercel. Stripe variables are read lazily; missing
billing configuration returns a `503` naming the variable, never its value.

### Frontend Vercel project

| Variable                   | Purpose                                                         | Required        |
| -------------------------- | --------------------------------------------------------------- | --------------- |
| `NEXT_PUBLIC_API_BASE_URL` | Browser-reachable backend base, including `/api`                | Yes, build-time |
| `NEXT_PUBLIC_SITE_URL`     | Canonical frontend origin used for metadata                     | Yes, build-time |
| `BETTER_AUTH_URL`          | Canonical Better Auth origin and JWT `iss`/`aud` source         | Yes, runtime    |
| `BETTER_AUTH_SECRET`       | Signs cookies and encrypts stored JWT keys                      | Yes, runtime    |
| `MONGODB_URI`              | Same MongoDB cluster as the backend                             | Yes, runtime    |
| `DB_NAME`                  | Same database name as the backend                               | Yes, runtime    |
| `JWT_ISSUER`               | Must exactly match `BETTER_AUTH_URL` and backend `JWT_ISSUER`   | Yes, runtime    |
| `JWT_AUDIENCE`             | Must exactly match `BETTER_AUTH_URL` and backend `JWT_AUDIENCE` | Yes, runtime    |
| `GOOGLE_CLIENT_ID`         | Google OAuth client ID                                          | Yes, runtime    |
| `GOOGLE_CLIENT_SECRET`     | Google OAuth client secret                                      | Yes, runtime    |

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is not used by the current client and is
not required. Production validation errors name the variable only, never its
value.

## 4. MongoDB, warm starts, and indexes

The backend memoizes one database bootstrap promise per function instance:

1. `connectDatabase()` reuses a warm `MongoClient`.
2. `ensureRequiredIndexes(db)` verifies the required unique indexes.
3. `enforceExpiredPremiumMenuLimits()` reconciles lapsed Premium vendors.
4. The same promise is reused by all warm invocations. A failure clears the
   cache so the next request can retry.

The readiness middleware runs before all routes, including protected database
operations. It never disconnects per request. `npm run db:indexes` remains
available for explicit provisioning; it is repeatable.

MongoDB Atlas must allow connections from Vercel's function IP ranges or use
private networking. Reusing the same cluster/database in both Vercel projects
is required: Better Auth owns `users`, Express reads it on every request.

## 5. URLs, CORS, and Better Auth JWKS

- Backend API base: `https://<backend-origin>/api`
- Frontend/Better Auth origin: `https://<frontend-origin>`
- Set backend `CORS_ALLOWED_ORIGINS` to the exact frontend origin(s).
- Preflight `OPTIONS` returns `204` with `Authorization` and `Content-Type`.
- The browser client sends the JWT in `Authorization: Bearer`; CORS cookies
  are not required.

Better Auth configuration requirements:

- `BETTER_AUTH_URL` on the frontend must be the exact deployed origin, with no
  trailing slash or path.
- `JWT_ISSUER` and `JWT_AUDIENCE` must equal that origin on both projects.
- Backend `BETTER_AUTH_JWKS_URL` must be
  `https://<frontend-origin>/api/auth/jwks`.
- The frontend route `src/app/api/auth/[...all]/route.ts` exposes JWKS, token,
  sign-in, sign-up, and sign-out endpoints.
- Google OAuth callback:
  `https://<frontend-origin>/api/auth/callback/google`.

Because Better Auth uses one canonical origin, Vercel preview URLs have a known
limitation: tokens still use the production issuer/audience, but Google OAuth
redirects and origin checks follow `BETTER_AUTH_URL`. Configure Preview
environment variables deliberately or test auth only on the canonical domain.

## 6. Stripe

Keep all Stripe values on the backend Vercel project. Sandbox and live mode use
separate keys, webhook secrets, and Price IDs; stored customer/subscription IDs
are mode-specific. Reuse the existing Premium Price ID via
`STRIPE_PREMIUM_PRICE_ID`; do not recreate Stripe products or prices.

Webhook endpoint:

```text
POST https://<backend-origin>/api/stripe/webhook
```

Subscribe it to:

- `checkout.session.completed`
- `checkout.session.expired`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Vercel's Express builder passes the raw request stream to Express. The app's
path-level `express.raw({ type: 'application/json' })` middleware runs before
`express.json()`, and the webhook route fails closed if `req.body` is not a
`Buffer`. No Vercel `bodyParser` override is needed for the zero-config Express
Function.

## 7. Recommended deployment order

1. Provision MongoDB and allow Vercel connections.
2. Deploy the frontend with build-time public URLs and runtime auth variables.
3. Confirm `GET https://<frontend-origin>/api/auth/jwks` returns JWKS.
4. Deploy the backend with `CORS_ALLOWED_ORIGINS`, JWKS URL, issuer/audience,
   MongoDB, ImgBB, and Stripe variables.
5. Run `npm run db:indexes` once if provisioning empty collections.
6. Register the Google OAuth callback and Stripe webhook endpoint.
7. Run the smoke tests below. Do not consider deployment successful until they
   pass.

## 8. Smoke tests

- `GET https://<backend-origin>/api/health` is healthy.
- `GET https://<backend-origin>/api/menu` returns the public menu.
- `OPTIONS` preflight from the frontend origin returns `204`; an unknown origin
  is not reflected.
- `GET https://<frontend-origin>/api/auth/jwks` returns JSON Web Keys.
- Sign in, then call a protected API route with the Bearer token.
- Vendor: create/edit a menu item; Premium/free-plan rules still apply.
- Customer: place an order; admin: load the overview dashboard.
- Send a signed Sandbox event to `/api/stripe/webhook`; expect `200` and the
  expected subscription state change.
- Verify backend Function logs show MongoDB connected once per cold start, not
  once per request.

## 9. Remaining manual configuration

- Connect the frontend Vercel project to the `pizzahub-client` GitHub repository
  with Root Directory `./`, and connect the backend Vercel project to the
  `pizzahub-server` GitHub repository with Root Directory `./`. Do not select a
  subdirectory.
- Add all environment variables listed above.
- Register deployed Google OAuth callback URLs.
- Create the Stripe webhook endpoint and subscribe the seven event types.
- Add deployed frontend origins to backend CORS.
- Confirm MongoDB network access from Vercel.
