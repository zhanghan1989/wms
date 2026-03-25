# WMS Release v1.0.3

- Version: `v1.0.3`
- Release date: `2026-03-25`
- Base branch: `main`
- Git tag: `v1.0.3`
- Change window: `2026-03-24` to `2026-03-25 morning`

## Scope

This release covers the changes landed on `main` from commit `90b486a` through `9fe3933`.

Included effective commits:

- `00b5dbb` fix: normalize equivalent box codes
- `a984e96` fix: streamline manage query dialogs
- `3e1cc82` fix: query manage dialogs by exact record
- `2197ef2` fix: simplify home inventory actions
- `27889db` fix: use z-0 as default shelf code
- `d48a5c8` feat: archive and release box codes
- `9fe3933` fix: remove box delete action from manage view

Rolled back and not included in the final release behavior:

- `6df54c0` fix: switch shelf codes to letter-number format
- `e2fdbe4` revert that change on `main`

## Main Changes

### 1. Box code and management hardening

- Unified equivalent box-code handling to avoid duplicates such as `9` and `009`.
- Applied the same box-code normalization rule across box creation, inbound, inventory, and batch inbound flows.
- Reduced repeated and ambiguous box matching in management operations.

### 2. Management query experience

- Added direct query actions in box management and shelf management.
- Management query buttons now open the result directly for the selected row instead of requiring manual re-entry.
- Box query from management now uses exact `boxId`.
- Shelf query from management now uses exact `shelfId`.

### 3. Homepage inventory actions

- Removed the homepage `编辑` action.
- Renamed the homepage `FBA补货` button text to `查看`.

### 4. Default shelf behavior

- Switched the system default shelf code to `Z-0`.
- Kept compatibility for historical default shelf aliases `00` and `S-00`.

### 5. Box lifecycle: archive and release

- Added `归档释放` in box management.
- Added backend endpoint `POST /api/boxes/:id/archive-release`.
- A box can be archived and its box code released for reuse only when:
  - total inventory is `0`
  - there is no active FBA replenishment
  - there is no locking batch inbound flow
- Archived boxes are hidden from the active box list after release.

### 6. Box management action cleanup

- Removed the box-management `删除` button from the frontend.
- Kept the backend delete capability untouched as a reserved low-level operation.

## Verification

- `node --check apps/api/public/app.js`
- `npm.cmd run -w api build`
- `npm.cmd run -w api lint`

## Notes

- Shelf-code migration to `A-1` format was attempted during the same time window but was rolled back before release.
- Final `v1.0.3` behavior remains compatible with the existing numeric shelf-code scheme on `main`.
