# Amazon FBA Dev Handoff

## Branch
- current working branch: `feature/fba-amazon-api-integration`

## What Was Completed
- Added Amazon FBA integration module on the backend:
  - connection management
  - one-click Amazon OAuth authorization start / callback completion
  - inbound job creation from existing `fba_replenishments`
  - payload preview
  - push and sync
  - packing / placement / transportation flows
- Added Amazon shipment and box snapshot persistence:
  - `amazon_inbound_shipments`
  - `amazon_inbound_boxes`
- Clarified the carton model:
  - `sourceInventoryBoxId` means source inventory box only
  - `fbaCartonRef` means outbound FBA carton reference
  - current business rule: one outbound selection batch defaults to one outbound FBA carton
- Added front-end Amazon job operations in the existing static admin page:
  - create connection
  - open Seller Central authorization popup from the connection card or edit modal
  - create job
  - build payload
  - push
  - sync
  - packing / placement / transportation actions
- Added front-end structured packing editor:
  - edits the same packing JSON draft used for submission
  - only allows editing `FBA carton ref`, `weight`, `length`, `width`, `height`
  - packed `SKU` and `quantity` are read-only after outbound
- Added outbound automation for packing:
  - after `createInboundPlan`, the UI now auto-submits default single-carton `packingInformation`
- Added outbound placement precheck:
  - after default packing submission, the UI now generates and lists placement options before internal outbound
  - when a single-shipment placement option exists, the UI auto-confirms that placement option
  - if Amazon only returns split placement options, the flow stops before internal outbound
  - the created Amazon job is marked failed so the same replenishment rows can be retried after deselection
- Added conservative outbound transportation automation:
  - after placement auto-confirm, the UI generates and lists transportation options
  - if each shipment only has one transportation option, the UI auto-confirms transportation
  - if transportation has multiple options, the UI prefers carriers containing `佐川`, then `ヤマト`
  - if transportation still cannot be uniquely selected, outbound continues and the Amazon task remains for manual follow-up
- Added Amazon carton-content persistence:
  - shipment sync now stores box-level item details in a separate local table
  - the Amazon job detail page now shows each box's SKU/FNSKU/quantity summary directly
- Added Amazon box-label support:
  - shipment sync now stores `shipmentConfirmationId`
  - each shipment card can request box labels via Amazon `getLabels`
  - current business assumption is `1 shipment = 1 Amazon box`
  - multi-box shipments are blocked and must be handled manually
- Added Amazon tracking support:
  - each shipment card can now push shipment tracking details to Amazon
  - the tracking request defaults to the current outbound `expressNo`
  - current business assumption is `1 shipment = 1 Amazon box`
  - multi-box shipments are blocked and must be handled manually
  - after outbound succeeds, the UI now auto-syncs shipments and then tries to auto-fetch labels and auto-push tracking
  - shipment-level auto failures are warnings only and do not roll back internal outbound
  - the latest automation result is now persisted in `responsePayload.automation`
- Added validation to prevent mixing source inventory box codes into Amazon carton fields:
  - front-end validation before submit
  - back-end validation in `setPackingInformation`
- Added validation to freeze packed SKU and quantity after outbound:
  - front-end blocks packing JSON if SKU/qty diverge from outbound rows
  - back-end blocks packing JSON if SKU/qty diverge from outbound rows
- Added static callback pages:
  - `amazon-oauth-login.html`
  - `amazon-oauth-callback.html`
  - both pages reuse the current admin login token from browser localStorage and do not expose an anonymous callback API

## Current Business Semantics
- Inventory box and Amazon/FBA carton are different concepts
- Current FBA page behavior:
  - users select replenishment request rows
  - selected rows are combined into one outbound Send to Amazon job
  - selected request rows are currently combined into one default FBA carton
  - before internal outbound, the system now prechecks Amazon placement to ensure this selection does not split
  - if a single-shipment placement option exists, the system auto-confirms it and continues
  - if Amazon detects split placement, outbound is stopped and the operator must deselect some request rows and retry
  - transportation is auto-confirmed only when every shipment has exactly one option
  - after outbound, carton contents are treated as fixed: SKU and quantity should not be edited
- Current carton identifier:
  - `AmazonInboundJobItem.fbaCartonRef`
  - currently filled from the generated default carton ref, e.g. `${jobNo}-BOX-1`

## Key Files
- Backend module:
  - `apps/api/src/amazon-fba/amazon-fba.controller.ts`
  - `apps/api/src/amazon-fba/amazon-fba.service.ts`
  - `apps/api/src/amazon-fba/amazon-sp-api.service.ts`
- Prisma:
  - `apps/api/prisma/schema.prisma`
  - `apps/api/prisma/migrations/20260312090000_add_amazon_fba_phase1`
  - `apps/api/prisma/migrations/20260312103000_extend_amazon_fba_audit_events`
  - `apps/api/prisma/migrations/20260312120000_extend_amazon_fba_packing_audit_events`
  - `apps/api/prisma/migrations/20260312133000_add_amazon_inbound_boxes`
  - `apps/api/prisma/migrations/20260312150000_rename_amazon_job_item_box_semantics`
  - `apps/api/prisma/migrations/20260312162000_add_amazon_job_item_fba_carton_ref`
  - `apps/api/prisma/migrations/20260313103000_add_amazon_inbound_box_items`
  - `apps/api/prisma/migrations/20260313113000_add_amazon_labels_support`
  - `apps/api/prisma/migrations/20260313123000_add_amazon_tracking_support`
  - `apps/api/prisma/migrations/20260313133000_add_amazon_automation_summary_audit_event`
- Front-end:
  - `apps/api/public/app.js`
  - `apps/api/public/index.html`
  - `apps/api/public/styles.css`
- Overview doc:
  - `docs/AMAZON_FBA_PHASE1.md`
  - `docs/AMAZON_OAUTH_SETUP.md`

## Important Technical Notes
- `AmazonInboundJobItem.boxId` has been semantically renamed to `sourceInventoryBoxId` in Prisma code
- The underlying DB column is still `box_id`
- `fbaCartonRef` was added as a separate business field and is indexed by `(job_id, fba_carton_ref)`
- `loadJobDetail()` currently assembles shipment boxes manually after loading shipments to avoid Prisma typing friction
- `loadJobDetail()` now also assembles box-level item details manually after loading shipments/boxes
- `getLabels` depends on `shipmentConfirmationId`; if a shipment has no confirmation id yet, sync the job before requesting labels
- `getLabels` and `updateShipmentTrackingDetails` now enforce the default single-box shipment rule
- Connection save no longer requires `refreshToken`; this allows creating a connection first and then binding it through Amazon authorization
- One-click authorization needs:
  - `clientId`
  - `clientSecret`
  - `applicationId`
  - `shipFromAddress`
  - Amazon app registration with:
    - Login URI = `${your-origin}/amazon-oauth-login.html`
    - Redirect URI = `${your-origin}/amazon-oauth-callback.html`
  - detailed setup steps are in `docs/AMAZON_OAUTH_SETUP.md`
- `sellerCentralUrl` is optional on the connection:
  - if left empty, the system defaults by region
  - `na -> sellercentral.amazon.com`
  - `eu -> sellercentral-europe.amazon.com`
  - `fe -> sellercentral.amazon.co.jp`
- Packing form and packing JSON are intentionally linked:
  - form edits update the JSON draft
  - `from JSON` refresh rehydrates the form from the current textarea content

## Front-End Status
- Working now:
  - Amazon connection CRUD
  - one-click Amazon connection authorization
  - job creation
  - build payload
  - push
  - sync
  - FBA outbound now creates a local Amazon job draft and pushes the inbound-plan request automatically
  - after push, default single-carton `packingInformation` is auto-submitted
  - packing option generate/list/confirm
  - packing information submit
  - placement option generate/list/confirm
  - transportation option generate/list/confirm
  - shipment and box detail display
  - structured packing form for common carton edits
  - packed SKU/quantity are shown as read-only after outbound
- Not finished:
  - multi-SKU carton editing in structured form
  - package item table persisted locally

## Back-End Status
- Working now:
  - SP-API auth token fetch
  - authorization-code exchange to refresh token
  - create inbound plan
  - operation sync
  - packing / placement / transportation calls
  - shipment snapshot sync
  - shipment box snapshot sync
  - API log persistence
  - audit log writes for Amazon actions
  - validation that blocks source inventory box code from being used as `boxId` or `templateName`
- Not finished:
  - richer packing schema validation based on real carton master data
  - package item local persistence
  - label / tracking / later-stage STA steps
  - background retry jobs

## Verification Completed
- passed:
  - `npm run -w api prisma:generate`
  - `npm run build`
  - `npm test`
- current test coverage is still minimal and mostly unchanged

## Database Status
- Prisma schema and migration files are present
- Actual migration execution was not performed in this session
- Before next real environment test, run the required migration flow in the target database

## Recommended Restart Checklist
1. Confirm the branch is still `feature/fba-amazon-api-integration`
2. Run:
   - `npm run -w api prisma:generate`
   - `npm run build`
   - `npm test`
3. Apply pending Prisma migrations in the correct environment
4. Open the FBA page and verify:
  - create or edit an Amazon connection without manually filling `refreshToken`
  - click `授权` and finish the Seller Central consent flow
  - confirm the connection becomes authorized and `sellerId` is written back
  - selected replenishment rows create one Amazon job
  - selected rows merge into one default FBA carton
  - structured packing form edits update carton ref / dimensions / weight only
  - entering a source inventory box code as carton ref is blocked
  - selecting a combination that would split placement blocks outbound with a modal reminder

## Recommended Next Tasks
1. Add stronger validation for dimensions and weight after carton master data exists
2. Decide whether to keep the single-box shipment rule hard-enforced or later reopen multi-box support
3. Decide whether transportation carrier priority should stay `佐川 -> ヤマト` or become configurable per shop
4. If Amazon starts returning richer carton content fields, map them into normalized local columns beyond `msku/fnsku/asin/quantity`
5. Consider masking `clientSecret` / `refreshToken` in connection list responses instead of returning full authConfig to the browser
