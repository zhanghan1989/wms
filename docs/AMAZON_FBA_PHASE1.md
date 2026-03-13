# Amazon FBA Phase 1

## Goal
- Keep the existing internal FBA replenishment flow unchanged
- Add a separate Amazon integration layer for `Send to Amazon`
- Deliver a phase-1 backend that can:
  - manage Amazon shop connections
  - create Amazon inbound jobs from existing FBA replenishments
  - build a payload preview for future SP-API submission

## Why a Separate Module
- Current FBA logic already lives in `inventory.service.ts`
- Amazon integration has different concerns:
  - credentials
  - external API payloads
  - idempotency
  - sync logs
  - shipment mapping
- Keeping it separate avoids making the inventory module even larger

## New Data Model
- `amazon_shop_connections`
  - connection metadata and auth config snapshot
- `amazon_inbound_jobs`
  - one integration job for a batch of replenishment rows
- `amazon_inbound_job_items`
  - link each job to existing `fba_replenishments`
  - current `sourceInventoryBoxId` on this table means source inventory box only, not Amazon shipment carton
  - `fbaCartonRef` stores the default FBA carton reference for the outbound batch, currently generated from `jobNo`
- `amazon_inbound_shipments`
  - Amazon shipment snapshots and status
- `amazon_inbound_boxes`
  - Amazon shipment box snapshots synced from shipment detail APIs
- `amazon_api_logs`
  - request/response history for troubleshooting

## Phase-1 API
- `GET /api/amazon-fba/connections`
- `POST /api/amazon-fba/connections`
- `PUT /api/amazon-fba/connections/:id`
- `POST /api/amazon-fba/connections/:id/oauth/start`
- `POST /api/amazon-fba/connections/:id/oauth/complete`
- `GET /api/amazon-fba/jobs`
- `GET /api/amazon-fba/jobs/:id`
- `POST /api/amazon-fba/jobs`
- `POST /api/amazon-fba/jobs/:id/build-payload`
- `POST /api/amazon-fba/jobs/:id/push`
- `POST /api/amazon-fba/jobs/:id/sync`
- `POST /api/amazon-fba/jobs/:id/packing-options/generate`
- `GET /api/amazon-fba/jobs/:id/packing-options`
- `POST /api/amazon-fba/jobs/:id/packing-options/:packingOptionId/confirm`
- `POST /api/amazon-fba/jobs/:id/packing-information`
- `POST /api/amazon-fba/jobs/:id/placement-options/generate`
- `GET /api/amazon-fba/jobs/:id/placement-options`
- `POST /api/amazon-fba/jobs/:id/placement-options/:placementOptionId/confirm`
- `POST /api/amazon-fba/jobs/:id/transportation-options/generate`
- `GET /api/amazon-fba/jobs/:id/transportation-options?placementOptionId=...`
- `POST /api/amazon-fba/jobs/:id/transportation-options/confirm`

## Current Validation Rules
 - Amazon job creation accepts `pending_outbound` and `outbound` FBA replenishments
- One replenishment row can only belong to one active Amazon job
- Inventory source box and Amazon packing/shipment box are two different concepts and must not be mixed
- Current packing default follows business rule: one selected outbound batch defaults to one outbound FBA carton
- After outbound, packed SKU and quantity are treated as frozen and must stay consistent with the outbound selection
- Connection base `authConfig` must include:
  - `clientId`
  - `clientSecret`
  - `shipFromAddress`
- Runtime Amazon push/sync still requires:
  - `refreshToken`
- One-click Amazon authorization additionally requires:
  - `applicationId`
  - a registered Login URI pointing to `/amazon-oauth-login.html`
  - a registered Redirect URI pointing to `/amazon-oauth-callback.html`
- Payload build stores a `createInboundPlan` request preview
- Push currently targets Amazon `Fulfillment Inbound API v2024-03-20`
- Sync currently checks the returned `operationId`
- Sync now also tries to pull shipment snapshots after a placement option has been confirmed
- Sync now also persists shipment boxes when Amazon returns them
- Sync now also persists box-level item details when Amazon returns carton contents
- Shipment sync now also stores `shipmentConfirmationId` for later box-label requests
- Connection auth flow:
  - the front-end can now start Amazon authorization from the connection card or edit modal
  - the current implementation opens a popup to Seller Central consent
  - after Amazon redirects back, the callback page exchanges `spapi_oauth_code` for `refreshToken`
  - the returned `refreshToken` is stored back into the connection automatically
  - `authorizationVersion=beta` is supported for draft apps
  - `sellerCentralUrl` can be overridden per connection; otherwise the system falls back by region

## Current Scope Extension
- Packing flow:
  - generate packing options
  - list packing options
  - confirm one packing option
  - submit manual packing information JSON
  - front-end structured packing form now edits the same JSON draft for common cartons
  - FBA outbound now auto-creates and pushes the Amazon inbound-plan request by the selected connection
  - after push, the UI now auto-submits the default single-carton `packingInformation`
  - packed SKU and quantity are now read-only in the structured form after outbound
- Placement flow:
  - generate placement options
  - list placement options
  - FBA outbound now runs a placement precheck before internal outbound
  - when a single-shipment placement option exists, the UI now auto-confirms that placement option
  - if Amazon returns only split placement options, the outbound flow is stopped and the job is marked failed locally
  - the user is prompted to reduce the selected replenishment request rows and retry outbound
  - confirm one placement option
- Transportation flow:
  - generate transportation options from the selected placement option
  - list transportation options
  - when each shipment only has one transportation option, the UI auto-confirms transportation during outbound
  - when multiple transportation options exist, the UI prefers carriers containing `佐川` first, then `ヤマト`
  - if transportation still cannot be uniquely selected by those preferences, outbound still completes and the Amazon task stays available for manual follow-up
  - confirm transportation selections by shipment
- Labels:
  - each shipment card can now request Amazon box labels from `getLabels`
  - the request uses `shipmentConfirmationId`, not the v2024 shipmentId
  - current business assumption is `1 shipment = 1 Amazon box`
  - label requests now run only for single-box shipments; multi-box shipments are blocked for manual handling
- Tracking:
  - each shipment card can now push shipment tracking details to Amazon
  - by default it uses the current outbound `expressNo` as the shipment tracking id
  - current business assumption is `1 shipment = 1 Amazon box`
  - tracking requests now run only for single-box shipments; multi-box shipments are blocked for manual handling
  - after outbound succeeds, the UI now tries to auto-sync shipments, auto-fetch labels, and auto-push tracking
  - failures in this shipment-level auto step do not roll back outbound; they surface as warnings for manual follow-up
  - the latest auto-handling summary is now persisted in `responsePayload.automation`

## Handoff
- See `docs/AMAZON_FBA_DEV_HANDOFF.md` for the latest branch status, completed work, known gaps, and restart checklist

## Next Step
- Support multi-SKU cartons in the structured packing editor instead of requiring JSON edits
- Persist more Send to Amazon steps
- Map Amazon plan/shipment/package item entities into local tables
- Add stronger packing-information validation once carton dimensions and weight are stored in WMS
- Add front-end entry points for package-level shipment details
