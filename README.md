# blurmagic-backend

Backend service for BlurMagic AI payments (USDT TRC20 self-custody).

## Endpoints

- GET `/health`
- POST `/payments/tron/deposit` (Bearer Firebase ID token)
- POST `/payments/tron/claim` (Bearer Firebase ID token) body: `{ txid?: string }`

## Env

- `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (required)
- `TRON_KEY_ENCRYPTION_SECRET` (required)
- `TRON_API_KEY` (recommended)
- `TRON_FULL_HOST` (default `https://api.trongrid.io`)
- `PRO_PRICE_USDT` (default `10`)
- `PRO_MONTHLY_CREDITS` (default `1000`)
- `PRO_PERIOD_DAYS` (default `30`)
- `CORS_ALLOW_ORIGINS` (comma separated, optional)

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Cloud Run (outline)

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>

gcloud run deploy blurmagic-backend \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated
```

Then set env vars in Cloud Run service settings.
