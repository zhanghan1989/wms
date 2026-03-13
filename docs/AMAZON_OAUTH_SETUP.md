# Amazon OAuth Setup

## Goal
- Provide a direct checklist for binding an Amazon seller account from the WMS admin page
- Record the exact fields, URLs, and current implementation constraints

## Branch
- current working branch: `feature/fba-amazon-api-integration`

## Current Flow
1. Open `FBA补货申请一览`
2. In `Amazon店铺连接`, create or edit a connection
3. Fill:
   - `连接名称`
   - `Marketplace ID`
   - `区域`
   - `Client ID`
   - `Client Secret`
   - `Application ID`
   - `发货地址`
4. `Refresh Token` can stay empty before authorization
5. Save the connection
6. Click `授权` on the connection card, or click `授权Amazon` inside the edit modal
7. A popup opens Seller Central consent
8. After Amazon redirects back, the callback page exchanges `spapi_oauth_code` for `refreshToken`
9. The connection is updated automatically and `sellerId` is written back from `selling_partner_id`

## WMS Pages
- Connection list and authorize button:
  - `apps/api/public/index.html`
  - `apps/api/public/app.js`
- Static OAuth pages:
  - `apps/api/public/amazon-oauth-login.html`
  - `apps/api/public/amazon-oauth-callback.html`

## Backend APIs
- `POST /api/amazon-fba/connections/:id/oauth/start`
- `POST /api/amazon-fba/connections/:id/oauth/complete`

## Required Amazon App Configuration
- In Amazon application settings, register:
  - `Login URI = https://<your-origin>/amazon-oauth-login.html`
  - `Redirect URI = https://<your-origin>/amazon-oauth-callback.html`
- `<your-origin>` must match the actual admin origin used by the browser
- If this is a draft app, set connection field `授权版本 = beta`

## Required Connection Fields
- Always required for saving the connection:
  - `clientId`
  - `clientSecret`
  - `shipFromAddress`
- Required for one-click authorization:
  - `applicationId`
- Required later for real Amazon API push/sync:
  - `refreshToken`

## Region Defaults
- If `Seller Central URL` is empty, the system uses:
  - `na -> https://sellercentral.amazon.com`
  - `eu -> https://sellercentral-europe.amazon.com`
  - `fe -> https://sellercentral.amazon.co.jp`

## Implementation Notes
- The callback is not anonymous
- The popup callback page reuses the current admin JWT from browser `localStorage`
- If the admin login expires before callback completion, authorization completion will fail
- The connection card now shows authorization state:
  - `未授权`
  - `授权中`
  - `已授权`

## Verification Checklist
1. Save a connection without `refreshToken`
2. Click `授权`
3. Complete Seller Central consent
4. Confirm connection state becomes `已授权`
5. Confirm `sellerId` is backfilled
6. Confirm later `push/createInboundPlan` no longer fails for missing `refreshToken`

## Known Limitations
- Connection list API still returns full `authConfig` to the browser, including secrets
- Secrets are not masked in current UI payloads
- OAuth state is stored inside connection `authConfig`, not a separate table
- The callback flow assumes the popup and opener share the same origin

## Recommended Next Steps
1. Mask `clientSecret` and `refreshToken` in list/detail responses
2. Move OAuth state out of `authConfig` into a dedicated server-side store if needed
3. Add explicit UI error display for OAuth callback failures
4. Add a “重新授权” status hint when token-related Amazon API calls fail
