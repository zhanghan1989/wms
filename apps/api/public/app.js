const state = {
  token: localStorage.getItem("wms_token") || "",
  me: null,
  shelves: [],
  boxes: [],
  emptyBoxes: [],
  inventorySkus: [],
  brands: [],
  skuTypes: [],
  shops: [],
  skuEditRequests: [],
  inventoryLocations: new Map(),
  inventoryTotalsBySku: {},
  inventorySortedSkus: [],
  inventoryVisibleCount: 0,
  inventoryListPageSize: 20,
  inventoryPageSize: 30,
  inventorySearchMode: false,
  inventorySearchKeyword: "",
  inventorySearchPage: 0,
  inventorySearchPageSize: 10,
  inventorySearchHasMore: false,
  inventorySearchLoading: false,
  inventorySearchSkus: [],
  inventorySearchLocationMap: new Map(),
  inventorySearchBoxSkuMap: new Map(),
  users: [],
  usersById: new Map(),
  usersVisibleCount: 0,
  departmentOptions: [],
  roleOptions: [],
  auditLogs: [],
  auditVisibleCount: 0,
  myAuditLogs: [],
  myAuditVisibleCount: 0,
  batchInboundOrders: [],
  batchInboundVisibleCount: 0,
  selectedBatchInboundOrderId: "",
  selectedBatchInboundOrderDetail: null,
  fbaReplenishments: [],
  fbaReplenishmentsVisibleCount: 0,
  skuEditRequestsVisibleCount: 0,
  fbaPendingCount: 0,
  productEditPendingCount: 0,
  fbaPendingBySku: {},
  fbaPendingByBoxSku: {},
  selectedProductEditRequestId: null,
  selectedProductEditRequestChangedFields: [],
  selectedProductEditRequestIds: new Set(),
  selectedEditUserId: null,
  selectedResetPasswordUserId: null,
  selectedFbaIds: new Set(),
  brandEditingIds: new Set(),
  skuTypeEditingIds: new Set(),
  shopEditingIds: new Set(),
  shelfEditingIds: new Set(),
  boxEditingIds: new Set(),
  shelfManageVisibleCount: 10,
  boxManageVisibleCount: 10,
  manageModalInitialPageSize: 10,
  manageModalLoadStep: 20,
  departmentOptionEditingCodes: new Set(),
  roleOptionEditingCodes: new Set(),
  auditFbaRequestNoById: {},
  overviewDashboard: null,
  dataBackups: [],
  pendingPrintLabel: null,
  stocktakeTasks: [],
  stocktakeVisibleCount: 0,
  selectedStocktakeTask: null,
  selectedStocktakeTaskRows: [],
};

let deleteConfirmResolver = null;
let actionConfirmResolver = null;
let suppressAuthErrorToastUntil = 0;
let adjustBoxValidationTimer = null;
let adjustBoxValidationToken = 0;
let modalZIndexSeed = 20;

const SILENT_AUTH_ERROR_MESSAGE = "__silent_auth__";
const $ = (id) => document.getElementById(id);

$("openEmptyBoxManageModal")?.remove();
$("emptyBoxManageModal")?.remove();

const DEFAULT_DEPARTMENT_OPTIONS = [
  { code: "factory", name: "蟾･蜴・, status: 1, sort: 10 },
  { code: "overseas_warehouse", name: "豬ｷ螟紋ｻ・, status: 1, sort: 20 },
  { code: "china_warehouse", name: "荳ｭ蝗ｽ莉・, status: 1, sort: 30 },
];

const DEFAULT_ROLE_OPTIONS = [
  { code: "employee", name: "\u5458\u5de5", status: 1, sort: 10 },
  { code: "admin", name: "\u7ba1\u7406\u8005", status: 1, sort: 20 },
  { code: "system_admin", name: "\u7cfb\u7edf\u7ba1\u7406\u5458", status: 1, sort: 30 },
];
const SKU_EDIT_PENDING_BLOCK_MESSAGE = "豁｣蝨ｨ郛冶ｾ台ｺｧ蜩∫筏隸ｷ荳ｭ・瑚ｯｷ邂｡逅・遭遑ｮ隶､蜷主・謇ｧ陦檎嶌蜈ｳ謫堺ｽ懊・;

const AUDIT_EVENT_TEXT_MAP = {
  box_created: "譁ｰ蠅樒ｮｱ蜿ｷ",
  box_field_updated: "邂ｱ蜿ｷ菫｡諱ｯ譖ｴ譁ｰ",
  box_renamed: "邂ｱ蜿ｷ驥榊多蜷・,
  box_disabled: "遖∫畑邂ｱ蜿ｷ",
  box_deleted: "蛻髯､邂ｱ蜿ｷ",
  box_stock_increased: "邂ｱ蜀・ｺ灘ｭ伜｢槫刈",
  box_stock_outbound: "邂ｱ蜀・ｺ灘ｭ伜・蠎・,
  sku_created: "譁ｰ蠅樔ｺｧ蜩・,
  sku_field_updated: "莠ｧ蜩∽ｿ｡諱ｯ譖ｴ譁ｰ",
  sku_disabled: "遖∫畑莠ｧ蜩・,
  sku_deleted: "蛻髯､莠ｧ蜩・,
  shelf_created: "譁ｰ蠅櫁ｴｧ譫ｶ",
  shelf_field_updated: "雍ｧ譫ｶ菫｡諱ｯ譖ｴ譁ｰ",
  shelf_disabled: "遖∫畑雍ｧ譫ｶ",
  shelf_deleted: "蛻髯､雍ｧ譫ｶ",
  brand_created: "譁ｰ蠅槫刀迚・,
  brand_updated: "譖ｴ譁ｰ蜩∫煙",
  brand_deleted: "蛻髯､蜩∫煙",
  sku_type_created: "譁ｰ蠅樒ｱｻ蝙・,
  sku_type_updated: "譖ｴ譁ｰ邀ｻ蝙・,
  sku_type_deleted: "蛻髯､邀ｻ蝙・,
  shop_created: "譁ｰ蠅槫ｺ鈴銅",
  shop_updated: "譖ｴ譁ｰ蠎鈴銅",
  shop_deleted: "蛻髯､蠎鈴銅",
  user_created: "譁ｰ蠅樒畑謌ｷ",
  user_updated: "譖ｴ譁ｰ逕ｨ謌ｷ",
  user_disabled: "遖∫畑逕ｨ謌ｷ",
  user_deleted: "蛻髯､逕ｨ謌ｷ",
  inbound_order_created: "蛻帛ｻｺ蜈･蠎灘黒",
  inbound_order_confirmed: "遑ｮ隶､蜈･蠎灘黒",
  inbound_order_voided: "菴懷ｺ溷・蠎灘黒",
  outbound_order_created: "蛻帛ｻｺ蜃ｺ蠎灘黒",
  outbound_order_confirmed: "遑ｮ隶､蜃ｺ蠎灘黒",
  outbound_order_voided: "菴懷ｺ溷・蠎灘黒",
  stocktake_task_created: "蛻帛ｻｺ逶倡せ莉ｻ蜉｡",
  stocktake_task_started: "蠑蟋狗尨轤ｹ莉ｻ蜉｡",
  stocktake_task_finished: "螳梧・逶倡せ莉ｻ蜉｡",
  stocktake_task_voided: "菴懷ｺ溽尨轤ｹ莉ｻ蜉｡",
  inventory_adjust_created: "蛻帛ｻｺ蠎灘ｭ倩ｰ・紛蜊・,
  inventory_adjust_confirmed: "遑ｮ隶､蠎灘ｭ倩ｰ・紛蜊・,
  inventory_adjust_voided: "菴懷ｺ溷ｺ灘ｭ倩ｰ・紛蜊・,
};

const AUDIT_ENTITY_TEXT_MAP = {
  box: "邂ｱ蜿ｷ",
  sku: "莠ｧ蜩・,
  shelf: "雍ｧ譫ｶ",
  user: "逕ｨ謌ｷ",
  brand: "蜩∫煙",
  sku_type: "邀ｻ蝙・,
  shop: "蠎鈴銅",
  inbound_order: "蜈･蠎灘黒",
  outbound_order: "蜃ｺ蠎灘黒",
  stocktake_task: "逶倡せ莉ｻ蜉｡",
  inventory_adjust_order: "蠎灘ｭ倩ｰ・紛蜊・,
  fba_replenishment: "FBA陦･雍ｧ逕ｳ隸ｷ",
  product_edit_request: "莠ｧ蜩∫ｼ冶ｾ醍筏隸ｷ",
};
const PRODUCT_EDIT_CONFIRM_PERMISSION_MESSAGE_FACTORY = "莉・ｽ帛ｱｱ蟾･蜴らｮ｡逅・・庄遑ｮ隶､郛冶ｾ醍筏隸ｷ";

function showToast(message, isError = false, options = {}) {
  if (String(message || "") === SILENT_AUTH_ERROR_MESSAGE) {
    return;
  }
  showErrorModal(message, isError, options);
}

function showErrorModal(message, isError = true, options = {}) {
  const text = String(message || "蜿醍函譛ｪ遏･髞呵ｯｯ");
  const modalCard = document.querySelector("#errorModal .modal-card");
  const title = $("errorModalTitle");
  const icon = $("errorModalIcon");
  const messageEl = $("errorModalMessage");
  const closeBtn = $("errorModalCloseBtn");
  const printLabelBtn = $("errorModalPrintLabelBtn");
  const labelData = !isError && options && typeof options === "object" ? options.labelData || null : null;
  state.pendingPrintLabel = labelData;
  if (modalCard) {
    modalCard.classList.toggle("is-info", !isError);
  }
  if (title) {
    title.innerHTML = `<span id="errorModalIcon" class="confirm-icon">${isError ? "!" : "i"}</span>${
      isError ? "髞呵ｯｯ" : "謠千､ｺ"
    }`;
  }
  if (icon && !title) {
    icon.textContent = isError ? "!" : "i";
  }
  if (messageEl) {
    messageEl.textContent = text;
  }
  if (closeBtn) {
    closeBtn.textContent = isError ? "謌醍衍驕謎ｺ・ : "蜈ｳ髣ｭ";
    closeBtn.classList.toggle("danger-solid", isError);
  }
  if (printLabelBtn) {
    const shouldShowPrint = Boolean(labelData && String(labelData.fnsku || "").trim());
    printLabelBtn.classList.toggle("hidden", !shouldShowPrint);
  }
  openModal("errorModal");
}

function closeErrorModal() {
  state.pendingPrintLabel = null;
  const printLabelBtn = $("errorModalPrintLabelBtn");
  if (printLabelBtn) {
    printLabelBtn.classList.add("hidden");
  }
  closeModal("errorModal");
}

function normalizeErrorMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "蜿醍函譛ｪ遏･髞呵ｯｯ";
  }

  const exactMap = {
    "Request failed": "隸ｷ豎ょ､ｱ雍･",
    "Internal Server Error": "譛榊苅蝎ｨ蜀・Κ髞呵ｯｯ",
    "Failed to fetch": "鄂醍ｻ懆ｯｷ豎ょ､ｱ雍･・瑚ｯｷ譽譟･鄂醍ｻ懆ｿ樊磁",
    Unauthorized: "譛ｪ謗域揀・瑚ｯｷ驥肴眠逋ｻ蠖・,
    Forbidden: "譌譚・剞謇ｧ陦瑚ｯ･謫堺ｽ・,
    "Forbidden resource": "譌譚・剞謇ｧ陦瑚ｯ･謫堺ｽ・,
  };
  if (exactMap[raw]) {
    return exactMap[raw];
  }

  const httpMatch = raw.match(/^HTTP\s+(\d{3})$/i);
  if (httpMatch) {
    return `隸ｷ豎ょ､ｱ雍･・・TTP ${httpMatch[1]}・荏;
  }

  const lockedMatch = raw.match(
    /^box code is locked by batch inbound order\s+(.+),\s*please confirm or delete that order first$/i,
  );
  if (lockedMatch) {
    return `邂ｱ蜿ｷ蟾ｲ陲ｫ謇ｹ驥丞・蠎灘黒 ${lockedMatch[1]} 髞∝ｮ夲ｼ瑚ｯｷ蜈育｡ｮ隶､謌門唖髯､隸･蜊墓紺`;
  }

  return raw;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const LABEL_5030_SIZE_MM = {
  width: 50.186,
  height: 30.113,
};

const CODE39_PATTERNS = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "$": "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
};

function normalizeFnskuForLabel(rawValue) {
  const normalized = String(rawValue || "").trim().toUpperCase();
  if (!normalized) {
    throw new Error("fnSKU荳ｺ遨ｺ・梧裏豕墓遠蜊ｰ譬・ｭｾ");
  }
  const unsupportedChars = Array.from(normalized).filter((char) => !CODE39_PATTERNS[char]);
  if (unsupportedChars.length) {
    throw new Error(`fnSKU蜷ｫ譛我ｸ肴髪謖∫噪荳扈ｴ遐∝ｭ礼ｬｦ・・{unsupportedChars.join(" ")}`);
  }
  return normalized;
}

function normalizeLabelPrintQty(rawQty) {
  const qty = Number(rawQty);
  if (!Number.isInteger(qty) || qty <= 0) {
    return 1;
  }
  return qty;
}

function buildCode39BarcodeSvg(value) {
  const encoded = `*${normalizeFnskuForLabel(value)}*`;
  const narrow = 2;
  const wide = 5;
  const height = 88;
  let x = 0;
  const bars = [];

  for (let idx = 0; idx < encoded.length; idx += 1) {
    const pattern = CODE39_PATTERNS[encoded[idx]];
    for (let i = 0; i < pattern.length; i += 1) {
      const isBar = i % 2 === 0;
      const width = pattern[i] === "w" ? wide : narrow;
      if (isBar) {
        bars.push(`<rect x="${x}" y="0" width="${width}" height="${height}" fill="#111" />`);
      }
      x += width;
    }
    if (idx < encoded.length - 1) {
      x += narrow;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} ${height}" preserveAspectRatio="none">${bars.join(
    "",
  )}</svg>`;
}

function openPrintLabelWindow(labelData) {
  const fnsku = normalizeFnskuForLabel(labelData?.fnsku);
  const printQty = normalizeLabelPrintQty(labelData?.qty);
  const skuText = String(labelData?.sku || "").trim();
  const newProductText = `譁ｰ蜩・${skuText || "-"}`;
  const barcodeSvg = buildCode39BarcodeSvg(fnsku);
  const pageWidth = LABEL_5030_SIZE_MM.width;
  const pageHeight = LABEL_5030_SIZE_MM.height;
  const popup = window.open("", "_blank", "width=520,height=360");
  if (!popup) {
    throw new Error("謇灘魂遯怜哨陲ｫ諡ｦ謌ｪ・瑚ｯｷ蜈∬ｮｸ蠑ｹ遯怜錘驥崎ｯ・);
  }

  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>謇灘魂譬・ｭｾ</title>
    <style>
      @page {
        size: ${pageWidth}mm ${pageHeight}mm;
        margin: 0;
      }
      html, body {
        margin: 0;
        padding: 0;
        width: ${pageWidth}mm;
        height: ${pageHeight}mm;
      }
      body {
        font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      }
      .print-page {
        width: ${pageWidth}mm;
        height: ${pageHeight}mm;
        page-break-after: always;
      }
      .print-page:last-child {
        page-break-after: auto;
      }
      .label {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        padding: 1mm;
        display: flex;
        flex-direction: column;
      }
      .label-barcode {
        height: 40%;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        box-sizing: border-box;
        padding: 0 3mm;
        margin-top: 2mm;
        overflow: hidden;
      }
      .label-barcode svg {
        width: 100%;
        height: 100%;
      }
      .label-bottom {
        flex: 1;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 1.2mm;
        overflow: hidden;
        word-break: break-all;
      }
      .label-bottom-text {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.8mm;
      }
      .label-fnsku {
        text-align: center;
        font-size: 4.5mm;
        font-weight: 700;
        color: #111;
        line-height: 1.1;
        transform: translateY(-0.8mm);
      }
      .label-sku {
        text-align: center;
        font-size: 3.4mm;
        font-weight: 700;
        color: #111;
        line-height: 1.2;
      }
    </style>
  </head>
  <body>
    ${Array.from({ length: printQty })
      .map(
        () => `<div class="print-page">
      <div class="label">
        <div class="label-barcode">${barcodeSvg}</div>
        <div class="label-bottom">
          <div class="label-bottom-text">
            <span class="label-fnsku">${escapeHtml(fnsku)}</span>
            <span class="label-sku">${escapeHtml(newProductText)}</span>
          </div>
        </div>
      </div>
    </div>`,
      )
      .join("")}
    <script>
      window.addEventListener("load", function () {
        setTimeout(function () {
          window.focus();
          window.print();
        }, 120);
      });
      window.addEventListener("afterprint", function () {
        window.close();
      });
    </script>
  </body>
</html>`);
  popup.document.close();
}

function printPendingLabelFromErrorModal() {
  if (!state.pendingPrintLabel) {
    throw new Error("蠖灘燕豐｡譛牙庄謇灘魂逧・・ｭｾ謨ｰ謐ｮ");
  }
  openPrintLabelWindow(state.pendingPrintLabel);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function formatDateOnly(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function formatDateOnlyWithWeekday(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const weekdays = ["譏滓悄譌･", "譏滓悄荳", "譏滓悄莠・, "譏滓悄荳・, "譏滓悄蝗・, "譏滓悄莠・, "譏滓悄蜈ｭ"];
  return `${formatDateOnly(value)}(${weekdays[date.getDay()] || "-"})`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getTodayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatDateForFilename(date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((item) => item.type !== "literal")
      .map((item) => [item.type, item.value]),
  );
  return `${parts.year || "0000"}${parts.month || "00"}${parts.day || "00"}-${parts.hour || "00"}${
    parts.minute || "00"
  }${parts.second || "00"}`;
}

async function downloadStockAdjustmentCsv() {
  if (!state.token) {
    throw new Error("隸ｷ蜈育匳蠖・);
  }
  let response;
  try {
    response = await fetch("/api/inventory/stock-adjustment-csv", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename="?([^";]+)"?/i);
  let fileName = `stock_ajustment_${formatDateForFilename(new Date())}.csv`;
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`蟾ｲ荳玖ｽｽ ${fileName}`);
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function triggerCsvDownload(fileName, rows) {
  const csvContent = `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n")}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

async function downloadInventorySkuSummaryCsv() {
  if (!state.token) {
    throw new Error("隸ｷ蜈育匳蠖慕ｳｻ扈・);
  }
  if (!Array.isArray(state.inventorySkus) || state.inventorySkus.length === 0) {
    await loadInventory({ preserveSearch: true });
  }

  const rows = [
    ["蝙句捷", "蜩∫煙", "邀ｻ蝙・, "鬚懆牡", "蠎鈴銅", "螟・ｳｨ", "SKU", "ASIN", "FNSKU", "FBMSKU", "rbSKU", "蠎灘ｭ俶ｻ謨ｰ"],
  ];
  const list =
    Array.isArray(state.inventorySortedSkus) && state.inventorySortedSkus.length
      ? state.inventorySortedSkus
      : Array.isArray(state.inventorySkus)
        ? [...state.inventorySkus]
        : [];

  list.forEach((sku) => {
    rows.push([
      displayText(sku?.model),
      displayText(sku?.brand),
      displayText(sku?.type),
      displayText(sku?.color),
      displayText(sku?.shop),
      displayText(sku?.remark),
      displayText(sku?.sku),
      displayText(sku?.asin),
      displayText(sku?.fnsku),
      displayText(sku?.fbmSku),
      displayText(sku?.rbSku),
      Number(state.inventoryTotalsBySku?.[String(sku?.id)] ?? 0),
    ]);
  });

  const fileName = `inventory_sku_summary_${formatDateForFilename(new Date())}.csv`;
  triggerCsvDownload(fileName, rows);
  showToast(`蟾ｲ荳玖ｽｽ ${fileName}`);
}

async function downloadFbaOutboundExcel() {
  if (!state.token) {
    throw new Error("隸ｷ蜈育匳蠖・);
  }
  let response;
  try {
    response = await fetch("/api/inventory/fba-replenishments/outbound-excel", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let fileName = `fba_outbound_${formatDateForFilename(new Date())}.xlsx`;
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`蟾ｲ荳玖ｽｽ ${fileName}`);
}

async function downloadBatchInboundTemplate() {
  if (!state.token) {
    throw new Error("隸ｷ蜈育匳蠖・);
  }
  let response;
  try {
    response = await fetch("/api/batch-inbound/upload-template", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename="?([^";]+)"?/i);
  let fileName = "謇ｹ驥丞・蠎・xlsx";
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`蟾ｲ荳玖ｽｽ讓｡譚ｿ ${fileName}`);
}

async function downloadSkuUploadTemplate() {
  if (!state.token) {
    throw new Error("隸ｷ蜈育匳蠖・);
  }
  let response;
  try {
    response = await fetch("/api/skus/upload-template", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename="?([^";]+)"?/i);
  let fileName = "謇ｹ驥丈ｸ贋ｼ莠ｧ蜩・xlsx";
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`蟾ｲ荳玖ｽｽ讓｡譚ｿ ${fileName}`);
}

async function downloadInventoryUpdateTemplate() {
  if (!state.token) {
    throw new Error("隸ｷ蜈育匳蠖・);
  }
  let response;
  try {
    response = await fetch("/api/inventory/bulk-update-template", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let fileName = "謇ｹ驥乗峩譁ｰ蠎灘ｭ・xlsx";
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`蟾ｲ荳玖ｽｽ讓｡譚ｿ ${fileName}`);
}

function getStatusText(status) {
  return Number(status) === 1 ? "蜷ｯ逕ｨ" : "遖∫畑";
}

function getRoleText(role) {
  const code = String(role || "");
  const item = state.roleOptions.find((option) => option.code === code);
  if (item?.name) return item.name;
  if (code === "system_admin") return "\u7cfb\u7edf\u7ba1\u7406\u5458";
  return code === "admin" ? "\u7ba1\u7406\u8005" : "\u5458\u5de5";
}

function hasAdminAccess(role) {
  return ["admin", "system_admin"].includes(String(role || ""));
}

function getDepartmentText(department) {
  const code = String(department || "");
  if (!code) return "";
  const item = state.departmentOptions.find((option) => option.code === code);
  if (item?.name) return item.name;
  if (code === "factory") return "蟾･蜴・;
  if (code === "overseas_warehouse") return "豬ｷ螟紋ｻ・;
  return "荳ｭ蝗ｽ莉・;
}

function sortUserOptions(options) {
  return [...(Array.isArray(options) ? options : [])].sort((a, b) => {
    const sortA = Number(a?.sort ?? 0);
    const sortB = Number(b?.sort ?? 0);
    if (sortA !== sortB) return sortA - sortB;
    return String(a?.code || "").localeCompare(String(b?.code || ""));
  });
}

function getDepartmentOptionsWithFallback() {
  const items = state.departmentOptions.length ? state.departmentOptions : DEFAULT_DEPARTMENT_OPTIONS;
  return sortUserOptions(items);
}

function getRoleOptionsWithFallback() {
  const items = state.roleOptions.length ? state.roleOptions : DEFAULT_ROLE_OPTIONS;
  return sortUserOptions(items);
}

function getAssignableRoleOptions() {
  return getRoleOptionsWithFallback().filter((item) => String(item?.code || "") !== "system_admin");
}

function getAvailableDepartmentOptionItems() {
  return getDepartmentOptionsWithFallback().filter((item) => Number(item?.status) !== 1);
}

function getAvailableRoleOptionItems() {
  return getRoleOptionsWithFallback().filter((item) => Number(item?.status) !== 1);
}

function isUserOptionEnabled(options, code) {
  const target = String(code || "");
  const item = (Array.isArray(options) ? options : []).find(
    (option) => String(option?.code || "") === target,
  );
  if (!item) return true;
  return Number(item.status) === 1;
}

function normalizeProductEditChangedFields(changedFields) {
  const allowed = new Set([
    "sku",
    "rbSku",
    "asin",
    "fnsku",
    "fbmSku",
    "model",
    "brand",
    "type",
    "color",
    "shop",
    "remark",
  ]);
  return Array.from(
    new Set(
      (Array.isArray(changedFields) ? changedFields : [])
        .map((field) => String(field || "").trim())
        .filter((field) => allowed.has(field)),
    ),
  );
}

function canCurrentUserConfirmFactoryProductEditRequest() {
  const user = state.me;
  if (!user) return false;
  if (!hasAdminAccess(user.role)) return false;
  if (Number(user.status) !== 1) return false;

  const roleEnabled = isUserOptionEnabled(getRoleOptionsWithFallback(), String(user.role || ""));
  if (!roleEnabled) return false;
  if (String(user.role || "") === "system_admin") return true;
  if (String(user.department || "") !== "factory") return false;
  const departmentEnabled = isUserOptionEnabled(getDepartmentOptionsWithFallback(), "factory");
  return departmentEnabled;
}

function getProductEditConfirmContactMessage() {
  return "隸ｷ閨皮ｳｻ菴帛ｱｱ蟾･蜴らｮ｡逅・遭遑ｮ隶､";
}

function resolveProductEditConfirmPermission(changedFields) {
  void changedFields;
  return {
    allowed: canCurrentUserConfirmFactoryProductEditRequest(),
    message: PRODUCT_EDIT_CONFIRM_PERMISSION_MESSAGE_FACTORY,
    contactMessage: getProductEditConfirmContactMessage(),
  };
}

function hasChineseChars(text) {
  return /[\u3400-\u9FFF]/.test(String(text || ""));
}

function randomDigits(length) {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function buildDefaultPasswordByUsername(username) {
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername) {
    return randomDigits(6);
  }
  if (hasChineseChars(normalizedUsername)) {
    return randomDigits(6);
  }
  const safePrefix = normalizedUsername.slice(0, 60);
  return `${safePrefix}${randomDigits(4)}`;
}

function getFbaStatusText(status) {
  if (status === "pending_confirm") return "蠕・｡ｮ隶､";
  if (status === "pending_outbound") return "蠕・・蠎・;
  if (status === "outbound") return "蟾ｲ蜃ｺ蠎・;
  if (status === "deleted") return "蟾ｲ蛻髯､";
  return displayText(status);
}

function getProductEditRequestStatusText(status) {
  if (status === "pending") return "蠕・､・炊";
  if (status === "confirmed") return "蟾ｲ遑ｮ隶､";
  if (status === "deleted") return "蟾ｲ蛻髯､";
  return displayText(status);
}

function parseFixedDigits(raw, length, fieldName) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length !== length) {
    throw new Error(`${fieldName}蠢・｡ｻ譏ｯ${length}菴肴焚蟄輿);
  }
  return digits;
}

function buildBoxCode(rawDigits) {
  return parseFixedDigits(rawDigits, 3, "邂ｱ蜿ｷ");
}

function buildShelfCode(rawDigits) {
  return parseFixedDigits(rawDigits, 2, "雍ｧ譫ｶ蜿ｷ");
}

function clearStats() {
  $("statUsers").textContent = "-";
  $("statSkus").textContent = "-";
  $("statShelves").textContent = "-";
  $("statBoxes").textContent = "-";
  $("statInboundDraft").textContent = "-";
}

function buildStrictShelfCode(rawValue) {
  const value = String(rawValue ?? "").trim().toUpperCase();
  if (/^(?:00|[A-Z][0-9])$/.test(value)) {
    return value;
  }
  throw new Error("雍ｧ譫ｶ蜿ｷ蠢・｡ｻ譏ｯ00謌泡0譬ｼ蠑・);
}

function setTextById(id, text) {
  const el = $(id);
  if (el) {
    el.textContent = text;
  }
}

function formatOverviewNumber(value, fractionDigits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatOverviewRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  if (numeric >= 999) {
    return "999+";
  }
  return formatOverviewNumber(numeric, 1);
}

function renderOverviewTable(bodyId, html, colspan) {
  const body = $(bodyId);
  if (!body) return;
  body.innerHTML = html || `<tr><td colspan="${colspan}" class="muted">-</td></tr>`;
}

function clearOverviewDashboard() {
  state.overviewDashboard = null;
  [
    "overviewTotalStock",
    "overviewAvailableStock",
    "overviewLockedStock",
    "overviewInTransitStock",
    "overviewOutOfStockSkuCount",
    "overviewLowCoverageSkuCount",
    "overviewCoverageDays",
    "overviewAvgDailyOutbound",
    "overviewOutboundQty7d",
    "overviewOutboundQty14d",
    "overviewOutboundQty30d",
    "overviewDemandAvgDailyOutbound",
    "overviewRecommendationCount",
    "overviewRecommendationUrgentCount",
    "overviewRecommendationHighCount",
    "overviewRecommendationMediumCount",
    "overviewTargetDays",
    "overviewNoSales90Count",
    "overviewNoSales270Count",
  ].forEach((id) => setTextById(id, "-"));
  renderOverviewTable("overviewTopDemandBody", "", 5);
  renderOverviewTable("overviewAnomalyBody", "", 6);
  renderOverviewTable("overviewProductionBody", "", 9);
  renderOverviewTable("overviewNoSales90Body", "", 6);
  renderOverviewTable("overviewNoSales270Body", "", 6);
}

function renderOverviewDashboard(data) {
  const health = data?.health || {};
  const demand = data?.demand || {};
  const production = data?.production || {};
  const obsolete = data?.obsolete || {};

  setTextById("overviewTotalStock", formatOverviewNumber(health.totalStock));
  setTextById("overviewAvailableStock", formatOverviewNumber(health.availableStock));
  setTextById("overviewLockedStock", formatOverviewNumber(health.lockedStock));
  setTextById("overviewInTransitStock", formatOverviewNumber(health.inTransitStock));
  setTextById("overviewOutOfStockSkuCount", formatOverviewNumber(health.outOfStockSkuCount));
  setTextById("overviewLowCoverageSkuCount", formatOverviewNumber(health.lowCoverageSkuCount));
  setTextById("overviewCoverageDays", formatOverviewRatio(health.coverageDays));
  setTextById("overviewAvgDailyOutbound", formatOverviewNumber(health.avgDailyOutbound, 1));

  setTextById("overviewOutboundQty7d", formatOverviewNumber(demand.outboundQty7d));
  setTextById("overviewOutboundQty14d", formatOverviewNumber(demand.outboundQty14d));
  setTextById("overviewOutboundQty30d", formatOverviewNumber(demand.outboundQty30d));
  setTextById("overviewDemandAvgDailyOutbound", formatOverviewNumber(demand.avgDailyOutbound, 1));

  setTextById("overviewRecommendationCount", formatOverviewNumber(production.recommendationCount));
  setTextById("overviewRecommendationUrgentCount", formatOverviewNumber(production.urgentCount));
  setTextById("overviewRecommendationHighCount", formatOverviewNumber(production.highCount));
  setTextById("overviewRecommendationMediumCount", formatOverviewNumber(production.mediumCount));
  setTextById("overviewTargetDays", formatOverviewNumber(production.targetDays));
  setTextById("overviewNoSales90Count", formatOverviewNumber(obsolete.noSales90dCount));
  setTextById("overviewNoSales270Count", formatOverviewNumber(obsolete.noSales270dCount));

  const topRows = (Array.isArray(demand.topSkus) ? demand.topSkus : [])
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(displayText(item.sku))}</td>
        <td>${escapeHtml(displayText(item.model))}</td>
        <td>${escapeHtml(displayText(item.rbSku))}</td>
        <td>${formatOverviewNumber(item.qty30d)}</td>
        <td>${formatOverviewNumber(item.avgDailyOutbound, 1)}</td>
      </tr>
    `,
    )
    .join("");
  renderOverviewTable("overviewTopDemandBody", topRows, 5);

  const anomalyRows = (Array.isArray(demand.anomalySkus) ? demand.anomalySkus : [])
    .map((item) => {
      const ratio = Number(item.ratio);
      const ratioText = Number.isFinite(ratio) ? `${formatOverviewNumber(ratio, 2)}x` : "NEW";
      return `
      <tr>
        <td>${escapeHtml(displayText(item.sku))}</td>
        <td>${escapeHtml(displayText(item.model))}</td>
        <td>${escapeHtml(displayText(item.rbSku))}</td>
        <td>${formatOverviewNumber(item.qty7d)}</td>
        <td>${formatOverviewNumber(item.prev7d)}</td>
        <td>${ratioText}</td>
      </tr>
    `;
    })
    .join("");
  renderOverviewTable("overviewAnomalyBody", anomalyRows, 6);

  const productionRows = (Array.isArray(production.recommendations) ? production.recommendations : [])
    .map((item) => {
      const priority = displayText(item.priority);
      const priorityClass =
        priority === "邏ｧ諤･" ? "urgent" : priority === "鬮・ ? "high" : priority === "荳ｭ" ? "medium" : "normal";
      return `
      <tr>
        <td>${escapeHtml(displayText(item.sku))}</td>
        <td>${escapeHtml(displayText(item.model))}</td>
        <td>${escapeHtml(displayText(item.rbSku))}</td>
        <td>${formatOverviewNumber(item.availableStock)}</td>
        <td>${formatOverviewNumber(item.inTransitStock)}</td>
        <td>${formatOverviewNumber(item.avgDailyOutbound, 1)}</td>
        <td>${formatOverviewRatio(item.coverageDays)}</td>
        <td>${formatOverviewNumber(item.suggestedProductionQty)}</td>
        <td><span class="priority-chip priority-${priorityClass}">${escapeHtml(priority)}</span></td>
      </tr>
    `;
    })
    .join("");
  renderOverviewTable("overviewProductionBody", productionRows, 9);

  const noSales90Rows = (Array.isArray(obsolete.noSales90dSkus) ? obsolete.noSales90dSkus : [])
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(displayText(item.sku))}</td>
        <td>${escapeHtml(displayText(item.model))}</td>
        <td>${escapeHtml(displayText(item.rbSku))}</td>
        <td>${formatOverviewNumber(item.totalStock)}</td>
        <td>${formatOverviewNumber(item.availableStock)}</td>
        <td>${formatOverviewNumber(item.inTransitStock)}</td>
      </tr>
    `,
    )
    .join("");
  renderOverviewTable("overviewNoSales90Body", noSales90Rows, 6);

  const noSales270Rows = (Array.isArray(obsolete.noSales270dSkus) ? obsolete.noSales270dSkus : [])
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(displayText(item.sku))}</td>
        <td>${escapeHtml(displayText(item.model))}</td>
        <td>${escapeHtml(displayText(item.rbSku))}</td>
        <td>${formatOverviewNumber(item.totalStock)}</td>
        <td>${formatOverviewNumber(item.availableStock)}</td>
        <td>${formatOverviewNumber(item.inTransitStock)}</td>
      </tr>
    `,
    )
    .join("");
  renderOverviewTable("overviewNoSales270Body", noSales270Rows, 6);
}

async function loadOverviewDashboard() {
  const data = await request("/inventory/dashboard");
  state.overviewDashboard = data || null;
  renderOverviewDashboard(state.overviewDashboard);
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = idx === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

function renderDataBackupTable() {
  const body = $("dataBackupBody");
  if (!body) return;
  const rows = Array.isArray(state.dataBackups) ? state.dataBackups : [];
  body.innerHTML =
    rows
      .map((item) => {
        const fileName = String(item?.fileName || "");
        const hasFile = Boolean(item?.hasFile);
        const action = hasFile
          ? `<button class="tiny-btn" data-action="downloadDataBackup" data-file-name="${escapeHtml(fileName)}">荳玖ｽｽ</button>`
          : '<span class="muted">莉・ｮｰ蠖・/span>';
        return `
      <tr>
        <td>${escapeHtml(formatDate(item?.createdAt))}</td>
        <td>${escapeHtml(displayText(fileName))}</td>
        <td>${escapeHtml(formatFileSize(item?.sizeBytes))}</td>
        <td>${action}</td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="4" class="muted">證よ裏螟・ｻｽ隶ｰ蠖・/td></tr>';
}

async function loadDataBackups() {
  const rows = await request("/backups");
  state.dataBackups = Array.isArray(rows) ? rows : [];
  renderDataBackupTable();
}

async function runDataBackupNow(button) {
  await withBusyButton(button, "螟・ｻｽ荳ｭ...", async () => {
    const result = await request("/backups/run", { method: "POST" });
    await loadDataBackups();
    showToast(`螟・ｻｽ螳梧・・・{displayText(result?.fileName)}`);
  });
}

async function downloadDataBackup(fileName) {
  const normalizedFileName = String(fileName || "").trim();
  if (!normalizedFileName) {
    throw new Error("郛ｺ蟆大､・ｻｽ譁・ｻｶ蜷・);
  }
  if (!state.token) {
    throw new Error("隸ｷ蜈育匳蠖・);
  }

  let response;
  try {
    response = await fetch(`/api/backups/${encodeURIComponent(normalizedFileName)}/download`, {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let downloadName = normalizedFileName;
  if (utf8NameMatch?.[1]) {
    try {
      downloadName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    downloadName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`蟾ｲ荳玖ｽｽ螟・ｻｽ ${downloadName}`);
}

function displayText(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function applyRoleView() {
  const layout = document.querySelector(".layout");
  const quickActions = $("employeeQuickActions");
  const isLoggedIn = Boolean(state.me);
  const isEmployee = Boolean(state.me?.role === "employee");

  if (layout) {
    layout.classList.toggle("no-sidebar", isEmployee);
  }
  if (quickActions) {
    quickActions.classList.toggle("hidden", !isLoggedIn);
  }
}

function setAuthGate(isLoggedIn) {
  $("loginGate").classList.toggle("hidden", isLoggedIn);
  $("appTopbar").classList.toggle("hidden", !isLoggedIn);
  $("appLayout").classList.toggle("hidden", !isLoggedIn);
}

function setInventoryDisplayMode(searchMode) {
  state.inventorySearchMode = searchMode;
  const listSection = $("inventoryListSection");
  const searchSection = $("inventorySearchSection");
  if (listSection) listSection.classList.toggle("hidden", searchMode);
  if (searchSection) searchSection.classList.toggle("hidden", !searchMode);
}

function resetInventorySearchState() {
  state.inventorySearchKeyword = "";
  state.inventorySearchPage = 0;
  state.inventorySearchHasMore = false;
  state.inventorySearchLoading = false;
  state.inventorySearchSkus = [];
  state.inventorySearchLocationMap = new Map();
  state.inventorySearchBoxSkuMap = new Map();
}

function focusInventorySearch() {
  const panel = $("inventory");
  if (!panel || !panel.classList.contains("active")) return;
  const input = $("inventoryKeyword");
  if (!input || document.activeElement === input) return;
  setTimeout(() => input.focus(), 0);
}

async function openInventoryHomeDefault() {
  switchPanel("inventory");
  const keywordInput = $("inventoryKeyword");
  if (keywordInput) {
    keywordInput.value = "";
  }

  resetInventorySearchState();
  setInventoryDisplayMode(false);

  if (state.inventorySortedSkus.length) {
    state.inventoryVisibleCount = state.inventoryListPageSize;
    renderInventoryTable();
    focusInventorySearch();
    return;
  }

  await loadInventory();
  focusInventorySearch();
}

function switchPanel(targetId) {
  document.querySelectorAll(".nav-btn").forEach((button) => button.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));

  const button = document.querySelector(`.nav-btn[data-target="${targetId}"]`);
  if (button) button.classList.add("active");

  const panel = $(targetId);
  if (panel) panel.classList.add("active");
  if (targetId === "inventory") {
    focusInventorySearch();
    return;
  }
  if (targetId === "users" && hasAdminAccess(state.me?.role) && !state.users.length) {
    Promise.all([loadUserOptions(), loadUsers()]).catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "audit" && hasAdminAccess(state.me?.role) && !state.auditLogs.length) {
    loadAudit().catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "overview" && !state.overviewDashboard) {
    loadOverviewDashboard().catch((error) => showToast(error.message, true));
  }
}

function ensureBrandingUi() {
  document.title = "譌･譛ｬ荵仙､ｩ蠎灘ｭ倡ｳｻ扈・;
  document.querySelectorAll(".brand-title").forEach((node) => {
    node.textContent = "譌･譛ｬ荵仙､ｩ蠎灘ｭ倡ｳｻ扈・;
  });
}

function ensureInventoryPanelUi() {
  const bulkUploadButton = $("openBulkSkuUploadModal");
  if (!bulkUploadButton) return;
  if ($("downloadInventorySkuSummaryBtn")) return;

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.id = "downloadInventorySkuSummaryBtn";
  downloadButton.textContent = "荳玖ｽｽ邉ｻ扈滓園譛我ｺｧ蜩・;
  bulkUploadButton.insertAdjacentElement("afterend", downloadButton);
}

function openModal(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  modalZIndexSeed += 1;
  modal.style.zIndex = String(modalZIndexSeed);
  modal.classList.remove("hidden");
}

function closeModal(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.style.zIndex = "";
}

function ensureOverseasWarehouseQueryUi() {
  const actionRow = document.querySelector("#overseasWarehouse .card .action-row");
  const boxManageForm = $("boxManageForm");
  const shelfManageForm = $("shelfManageForm");
  let boxQueryBtn = $("openBoxContentQueryModal");
  if (!boxQueryBtn) {
    boxQueryBtn = document.createElement("button");
    boxQueryBtn.type = "button";
    boxQueryBtn.id = "openBoxContentQueryModal";
    boxQueryBtn.textContent = "邂ｱ蜀・膚蜩∵衍隸｢";
  }
  if (boxManageForm && boxQueryBtn) {
    boxQueryBtn.classList.add("small-btn", "manage-create-btn");
    const createBtn = $("openCreateBoxFromManage");
    boxManageForm.insertBefore(boxQueryBtn, createBtn || null);
  }

  let shelfQueryBtn = $("openShelfBoxQueryModal");
  if (!shelfQueryBtn) {
    shelfQueryBtn = document.createElement("button");
    shelfQueryBtn.type = "button";
    shelfQueryBtn.id = "openShelfBoxQueryModal";
    shelfQueryBtn.textContent = "雍ｧ譫ｶ蜀・ｮｱ蜿ｷ譟･隸｢";
  }
  if (shelfManageForm && shelfQueryBtn) {
    shelfQueryBtn.classList.add("small-btn", "manage-create-btn");
    const createBtn = $("openCreateShelfFromManage");
    shelfManageForm.insertBefore(shelfQueryBtn, createBtn || null);
  } else if (actionRow && shelfQueryBtn && !shelfQueryBtn.parentElement) {
    actionRow.insertBefore(shelfQueryBtn, $("downloadStockAdjustmentCsvBtn") || null);
  }

  if (!$("boxContentQueryModal")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="boxContentQueryModal" class="modal hidden">
          <div class="modal-card modal-wide modal-manage modal-manage-scroll">
            <div class="modal-head">
              <h3>邂ｱ蜀・膚蜩∵衍隸｢</h3>
              <button type="button" class="ghost" data-action="closeBoxContentQueryModal">蜈ｳ髣ｭ</button>
            </div>
            <form id="boxContentQueryForm" class="manage-inline-form manage-inline-form-triple">
              <input id="boxContentQueryBoxCode" inputmode="numeric" maxlength="16" placeholder="隸ｷ霎灘・邂ｱ蜿ｷ" required />
              <button type="submit" class="small-btn manage-create-btn">譟･隸｢</button>
              <div id="boxContentQuerySummary" class="muted manage-query-summary">隸ｷ霎灘・邂ｱ蜿ｷ蜷取衍隸｢縲・/div>
            </form>
            <div class="manage-table-scroll">
              <table>
                <thead><tr><th>邂ｱ蜿ｷ</th><th>雍ｧ譫ｶ蜿ｷ</th><th>SKU</th><th>謨ｰ驥・/th></tr></thead>
                <tbody id="boxContentQueryBody">
                  <tr><td colspan="4" class="muted">隸ｷ霎灘・邂ｱ蜿ｷ蜷取衍隸｢縲・/td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
    );
  }

  if (!$("shelfBoxQueryModal")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="shelfBoxQueryModal" class="modal hidden">
          <div class="modal-card modal-wide modal-manage modal-manage-scroll">
            <div class="modal-head">
              <h3>雍ｧ譫ｶ蜀・ｮｱ蜿ｷ譟･隸｢</h3>
              <button type="button" class="ghost" data-action="closeShelfBoxQueryModal">蜈ｳ髣ｭ</button>
            </div>
            <form id="shelfBoxQueryForm" class="manage-inline-form manage-inline-form-triple">
              <input id="shelfBoxQueryShelfCode" inputmode="text" maxlength="16" placeholder="隸ｷ霎灘・雍ｧ譫ｶ蜿ｷ・・0謌泡0・・ required />
              <button type="submit" class="small-btn manage-create-btn">譟･隸｢</button>
              <div id="shelfBoxQuerySummary" class="muted manage-query-summary">隸ｷ霎灘・雍ｧ譫ｶ蜿ｷ蜷取衍隸｢縲・/div>
            </form>
            <div class="manage-table-scroll">
              <table>
                <thead><tr><th>邂ｱ蜿ｷ</th><th>SKU</th><th>謨ｰ驥・/th></tr></thead>
                <tbody id="shelfBoxQueryBody">
                  <tr><td colspan="3" class="muted">隸ｷ霎灘・雍ｧ譫ｶ蜿ｷ蜷取衍隸｢縲・/td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
    );
  }

  if (!$("stocktakeTaskDetailModal")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="stocktakeTaskDetailModal" class="modal hidden">
          <div class="modal-card modal-wide modal-manage modal-manage-scroll">
            <div class="modal-head">
              <h3>蠎灘ｭ倡尨轤ｹ譏守ｻ・/h3>
              <div class="panel-tools">
                <button type="button" class="ghost" id="printStocktakeTaskDetailBtn">謇灘魂</button>
                <button type="button" class="ghost" data-action="closeStocktakeTaskDetailModal">蜈ｳ髣ｭ</button>
              </div>
            </div>
            <div id="stocktakeTaskDetailMeta" class="batch-detail-meta"></div>
            <div id="stocktakeTaskDetailSummary" class="muted manage-query-summary">隸ｷ騾画叫逶倡せ莉ｻ蜉｡蜷取衍逵九・/div>
            <div class="manage-table-scroll">
              <table>
                <thead><tr><th>邂ｱ蜿ｷ</th><th>SKU</th><th>謨ｰ驥・/th></tr></thead>
                <tbody id="stocktakeTaskDetailBody">
                  <tr><td colspan="3" class="muted">隸ｷ騾画叫逶倡せ莉ｻ蜉｡蜷取衍逵九・/td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
    );
  }
}

function getSubmitButton(form, event) {
  if (event?.submitter instanceof HTMLButtonElement) {
    return event.submitter;
  }
  if (!form) return null;
  return form.querySelector("button[type='submit']");
}

async function withBusyButton(button, busyText, task) {
  if (typeof task !== "function") return undefined;
  if (!button) return task();
  if (button.dataset.busy === "1") return undefined;

  const previousText = button.textContent;
  const previousDisabled = button.disabled;
  button.dataset.busy = "1";
  button.disabled = true;
  if (busyText) {
    button.textContent = busyText;
  }

  try {
    return await task();
  } finally {
    button.disabled = previousDisabled;
    if (busyText) {
      button.textContent = previousText;
    }
    delete button.dataset.busy;
  }
}

function openDeleteConfirmModal(messageText) {
  const message = $("deleteConfirmMessage");
  if (message) {
    message.textContent = String(messageText || "遑ｮ隶､蛻髯､蠖灘燕謨ｰ謐ｮ・・);
  }
  if (typeof deleteConfirmResolver === "function") {
    deleteConfirmResolver(false);
    deleteConfirmResolver = null;
  }
  openModal("deleteConfirmModal");
  return new Promise((resolve) => {
    deleteConfirmResolver = resolve;
  });
}

function resolveDeleteConfirm(confirmed) {
  closeModal("deleteConfirmModal");
  if (typeof deleteConfirmResolver === "function") {
    const resolve = deleteConfirmResolver;
    deleteConfirmResolver = null;
    resolve(Boolean(confirmed));
  }
}

function openActionConfirmModal(messageText, titleText = "遑ｮ隶､謫堺ｽ・, confirmText = "遑ｮ隶､", options = {}) {
  const title = $("actionConfirmTitle");
  const message = $("actionConfirmMessage");
  const okBtn = $("actionConfirmOkBtn");
  const cancelBtn = $("actionConfirmCancelBtn");
  const showCancel = options?.showCancel !== false;
  if (title) {
    title.innerHTML = `<span class="confirm-icon">!</span>${escapeHtml(titleText)}`;
  }
  if (message) {
    message.textContent = String(messageText || "遑ｮ隶､謇ｧ陦悟ｽ灘燕謫堺ｽ懶ｼ・);
  }
  if (okBtn) {
    okBtn.textContent = String(confirmText || "遑ｮ隶､");
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle("hidden", !showCancel);
  }
  if (typeof actionConfirmResolver === "function") {
    actionConfirmResolver(false);
    actionConfirmResolver = null;
  }
  openModal("actionConfirmModal");
  return new Promise((resolve) => {
    actionConfirmResolver = resolve;
  });
}

function resolveActionConfirm(confirmed) {
  closeModal("actionConfirmModal");
  if (typeof actionConfirmResolver === "function") {
    const resolve = actionConfirmResolver;
    actionConfirmResolver = null;
    resolve(Boolean(confirmed));
  }
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isFormData = options.body instanceof FormData;

  if (!isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  let res;
  try {
    res = await fetch(`/api${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }
  const text = await res.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text || "隸ｷ豎ょ､ｱ雍･" };
  }

  if (!res.ok || payload.code !== 0) {
    const message = normalizeErrorMessage(payload.message || `HTTP ${res.status}`);
    const shouldSuppressAuthError =
      res.status === 401 && (!state.token || Date.now() < suppressAuthErrorToastUntil);
    if (shouldSuppressAuthError) {
      throw new Error(SILENT_AUTH_ERROR_MESSAGE);
    }
    throw new Error(message);
  }

  return payload.data;
}

function buildDeleteBlockedMessage(entityLabel, reasons) {
  const list = Array.isArray(reasons)
    ? reasons
        .map((item) => String(item || "").trim())
        .filter((item) => Boolean(item))
    : [];
  if (!list.length) {
    return `${entityLabel}蟄伜惠蜈ｳ閨疲焚謐ｮ・梧嘯譌ｶ譌豕募唖髯､`;
  }
  return `${entityLabel}證よ慮譌豕募唖髯､・・{list.join("・・)}`;
}

function bindTabs() {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => switchPanel(button.dataset.target));
  });
}

function bindDigitInput(id, maxLen) {
  const input = $(id);
  if (!input) return;
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, maxLen);
    if (input.value !== digits) {
      input.value = digits;
    }
  });
}

function bindShelfCodeInput(id) {
  const input = $(id);
  if (!input) return;
  input.addEventListener("input", () => {
    const normalized = String(input.value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 2);
    if (input.value !== normalized) {
      input.value = normalized;
    }
  });
}

function bindPositiveIntegerInput(id, { min = 1, max = null } = {}) {
  const input = $(id);
  if (!input) return;

  const normalize = () => {
    let digits = String(input.value || "").replace(/\D/g, "");
    digits = digits.replace(/^0+/, "");
    if (!digits) {
      input.value = "";
      return;
    }
    let value = Number(digits);
    if (Number.isNaN(value)) {
      input.value = "";
      return;
    }
    if (value < min) value = min;
    if (max !== null && value > max) value = max;
    input.value = String(value);
  };

  input.addEventListener("input", normalize);
  input.addEventListener("blur", normalize);
}

function bindBatchNoInput(id) {
  const input = $(id);
  if (!input) return;
  input.addEventListener("input", () => {
    const normalized = String(input.value || "")
      .replace(/\D/g, "")
      .replace(/^0+/, "")
      .slice(0, 20);
    if (input.value !== normalized) {
      input.value = normalized;
    }
  });
}

function bindInputRules() {
  bindShelfCodeInput("newShelfCodeDigits");
  bindDigitInput("newBoxCodeDigits", 3);
  bindDigitInput("modalNewBoxCodeDigits", 3);
  bindDigitInput("boxManageCodeInput", 3);
  bindShelfCodeInput("modalNewShelfCodeDigits");
  bindShelfCodeInput("shelfManageCodeInput");
  bindPositiveIntegerInput("batchCollectBoxCount", { min: 1, max: 500 });
  bindBatchNoInput("batchCollectBatchNo");
}

async function loadMe() {
  if (!state.token) {
    state.me = null;
    $("sessionInfo").textContent = "譛ｪ逋ｻ蠖・;
    setAuthGate(false);
    applyRoleView();
    return;
  }

  try {
    state.me = await request("/auth/me");
    $("sessionInfo").textContent = `${state.me.username}`;
    setAuthGate(true);
    applyRoleView();
  } catch {
    state.token = "";
    state.me = null;
    localStorage.removeItem("wms_token");
    $("sessionInfo").textContent = "逋ｻ蠖募､ｱ謨・;
    setAuthGate(false);
    applyRoleView();
  }
}

function renderDepartmentOptionsTable() {
  const body = $("departmentOptionsBody");
  if (!body) return;

  const items = sortUserOptions(getDepartmentOptionsWithFallback()).filter((item) => Number(item.status) === 1);
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="2" class="muted">-</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const code = String(item.code || "");
      const editing = state.departmentOptionEditingCodes.has(code);
      return `
        <tr data-user-option-kind="departments" data-user-option-code="${escapeHtml(code)}">
          <td>
            <input
              id="departmentOptionName-${escapeHtml(code)}"
              class="tiny-input user-option-input"
              data-field="name"
              maxlength="64"
              value="${escapeHtml(item.name || "")}"
              data-original-name="${escapeHtml(item.name || "")}"
              ${editing ? "" : "readonly"}
            />
          </td>
          <td>
            <div class="action-row">
              <button type="button" class="tiny-btn" data-action="editDepartmentOption">
                ${editing ? "遑ｮ隶､蜿俶峩" : "蜿俶峩"}
              </button>
              <button type="button" class="tiny-btn danger" data-action="deleteDepartmentOption">蛻髯､</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderRoleOptionsTable() {
  const body = $("roleOptionsBody");
  if (!body) return;

  const items = sortUserOptions(getRoleOptionsWithFallback()).filter((item) => Number(item.status) === 1);
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="2" class="muted">-</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const code = String(item.code || "");
      const editing = state.roleOptionEditingCodes.has(code);
      return `
        <tr data-user-option-kind="roles" data-user-option-code="${escapeHtml(code)}">
          <td>
            <input
              id="roleOptionName-${escapeHtml(code)}"
              class="tiny-input user-option-input"
              data-field="name"
              maxlength="64"
              value="${escapeHtml(item.name || "")}"
              data-original-name="${escapeHtml(item.name || "")}"
              ${editing ? "" : "readonly"}
            />
          </td>
          <td>
            <div class="action-row">
              <button type="button" class="tiny-btn" data-action="editRoleOption">
                ${editing ? "遑ｮ隶､蜿俶峩" : "蜿俶峩"}
              </button>
              <button type="button" class="tiny-btn danger" data-action="deleteRoleOption">蛻髯､</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderUserOptionsTable() {
  renderDepartmentOptionsTable();
  renderRoleOptionsTable();
  renderDepartmentOptionCreateForm();
  renderRoleOptionCreateForm();
}

function renderDepartmentOptionCreateForm() {
  const form = $("departmentOptionCreateForm");
  const nameInput = $("departmentOptionCreateName");
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (!form || !nameInput || !submitBtn) return;
  nameInput.disabled = false;
  nameInput.placeholder = "\u8bf7\u8f93\u5165\u90e8\u95e8\u540d\u79f0";
  submitBtn.disabled = false;
}

function renderRoleOptionCreateForm() {
  const form = $("roleOptionCreateForm");
  const nameInput = $("roleOptionCreateName");
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (!form || !nameInput || !submitBtn) return;
  const options = getAvailableRoleOptionItems();
  nameInput.disabled = false;
  nameInput.placeholder = options.length === 0
    ? "蠖灘燕豐｡譛牙庄譁ｰ蠅櫁ｧ定牡・悟ｦる怙謾ｹ蜷崎ｯｷ轤ｹ荳区婿窶懷序譖ｴ窶・
    : "隸ｷ霎灘・隗定牡蜷咲ｧｰ";
  submitBtn.disabled = false;
}

function renderUserSelectOptions() {
  const newDepartmentEl = $("newDepartment");
  const newRoleEl = $("newRole");
  const editDepartmentEl = $("editUserDepartment");
  const editRoleEl = $("editUserRole");

  if (newDepartmentEl) {
    const selected = newDepartmentEl.value || "china_warehouse";
    const options = getDepartmentOptionsWithFallback().filter((item) => Number(item.status) === 1);
    newDepartmentEl.innerHTML = options
      .map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name || item.code)}</option>`)
      .join("");
    if (!newDepartmentEl.value && options.length) {
      newDepartmentEl.value = options[0].code;
    }
    if (options.some((item) => item.code === selected)) {
      newDepartmentEl.value = selected;
    }
  }

  if (newRoleEl) {
    const selected = newRoleEl.value || "employee";
    const options = getAssignableRoleOptions().filter((item) => Number(item.status) === 1);
    newRoleEl.innerHTML = options
      .map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name || item.code)}</option>`)
      .join("");
    if (!newRoleEl.value && options.length) {
      newRoleEl.value = options[0].code;
    }
    if (options.some((item) => item.code === selected)) {
      newRoleEl.value = selected;
    }
  }

  if (editDepartmentEl) {
    const selected = editDepartmentEl.value || "china_warehouse";
    const options = getDepartmentOptionsWithFallback().filter((item) => Number(item.status) === 1 || item.code === selected);
    editDepartmentEl.innerHTML = options
      .map((item) => {
        const suffix = Number(item.status) === 1 ? "" : "・育ｦ∫畑・・;
        return `<option value="${escapeHtml(item.code)}">${escapeHtml((item.name || item.code) + suffix)}</option>`;
      })
      .join("");
    if (selected && options.some((item) => item.code === selected)) {
      editDepartmentEl.value = selected;
    }
  }

  if (editRoleEl) {
    const selected = editRoleEl.value || "employee";
    const options = getAssignableRoleOptions().filter(
      (item) => Number(item.status) === 1 || item.code === selected,
    );
    editRoleEl.innerHTML = options
      .map((item) => {
        const suffix = Number(item.status) === 1 ? "" : "・育ｦ∫畑・・;
        return `<option value="${escapeHtml(item.code)}">${escapeHtml((item.name || item.code) + suffix)}</option>`;
      })
      .join("");
    if (selected && options.some((item) => item.code === selected)) {
      editRoleEl.value = selected;
    }
  }
}

async function loadUserOptions() {
  const data = await request("/user-options");
  const departments = Array.isArray(data?.departments) ? data.departments : [];
  const roles = Array.isArray(data?.roles) ? data.roles : [];
  state.departmentOptions = sortUserOptions(
    departments.map((item) => ({
      code: String(item.code || ""),
      name: String(item.name || ""),
      status: Number(item.status) === 1 ? 1 : 0,
      sort: Number(item.sort ?? 0),
    })),
  );
  state.roleOptions = sortUserOptions(
    roles.map((item) => ({
      code: String(item.code || ""),
      name: String(item.name || ""),
      status: Number(item.status) === 1 ? 1 : 0,
      sort: Number(item.sort ?? 0),
    })),
  );
  const enabledDepartmentCodes = new Set(
    state.departmentOptions.filter((item) => Number(item.status) === 1).map((item) => String(item.code)),
  );
  const enabledRoleCodes = new Set(
    state.roleOptions.filter((item) => Number(item.status) === 1).map((item) => String(item.code)),
  );
  state.departmentOptionEditingCodes = new Set(
    [...state.departmentOptionEditingCodes].filter((code) => enabledDepartmentCodes.has(String(code))),
  );
  state.roleOptionEditingCodes = new Set(
    [...state.roleOptionEditingCodes].filter((code) => enabledRoleCodes.has(String(code))),
  );
  renderUserOptionsTable();
  renderUserSelectOptions();
  if (state.users.length) {
    renderUsersTable();
  }
}

function renderUsersTable() {
  const body = $("usersBody");
  if (!body) return;
  const users = state.users.slice(0, state.usersVisibleCount);
  body.innerHTML =
    users
      .map((user) => {
        const isProtectedUser = String(user.username || "").trim() === "admin";
        const actions = isProtectedUser
          ? ""
          : `
            <button
              type="button"
              class="tiny-btn"
              data-action="editUser"
              data-id="${escapeHtml(user.id)}"
              data-username="${escapeHtml(user.username)}"
              data-role="${escapeHtml(user.role)}"
              data-department="${escapeHtml(user.department || "")}"
              data-status="${escapeHtml(Number(user.status) === 1 ? 1 : 0)}"
            >
              \u7f16\u8f91
            </button>
            <button
              type="button"
              class="tiny-btn"
              data-action="resetUserPassword"
              data-id="${escapeHtml(user.id)}"
              data-username="${escapeHtml(user.username)}"
              data-password-initialized="${user.passwordInitialized ? "1" : "0"}"
            >
              ${user.passwordInitialized ? "\u91cd\u7f6e\u5bc6\u7801" : "\u6fc0\u6d3b\u7528\u6237"}
            </button>`;
        return `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(getDepartmentText(user.department))}</td>
        <td>${escapeHtml(getRoleText(user.role))}</td>
        <td>${getStatusText(user.status)}</td>
        <td>${formatDate(user.updatedAt)}</td>
        <td>
          <div class="action-row">${actions}</div>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="6" class="muted">-</td></tr>';
}

async function loadUsers() {
  const users = await request("/users");
  state.users = Array.isArray(users) ? users : [];
  state.usersById = new Map(state.users.map((user) => [String(user.id), user]));
  state.usersVisibleCount = state.inventoryPageSize;
  $("statUsers").textContent = state.users.length;
  renderUsersTable();
}

function loadMoreUsersIfNeeded() {
  const panel = $("users");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.usersVisibleCount >= state.users.length) return;
  state.usersVisibleCount += state.inventoryPageSize;
  renderUsersTable();
}

function findUserById(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return state.usersById.get(id) || null;
}

function syncEditUserActionButtons(userId, status, username) {
  const toggleBtn = $("editUserToggleBtn");
  const deleteBtn = $("editUserDeleteBtn");
  const normalizedUserId = String(userId || "").trim();
  const normalizedUsername = String(username || "").trim();
  const normalizedStatus = Number(status) === 1 ? 1 : 0;
  if (toggleBtn) {
    toggleBtn.dataset.id = normalizedUserId;
    toggleBtn.dataset.username = normalizedUsername;
    toggleBtn.dataset.nextStatus = normalizedStatus === 1 ? "0" : "1";
    toggleBtn.textContent = normalizedStatus === 1 ? "遖∫畑" : "蜷ｯ逕ｨ";
  }
  if (deleteBtn) {
    deleteBtn.dataset.id = normalizedUserId;
    deleteBtn.dataset.username = normalizedUsername;
  }
}

async function toggleUserStatus(userId, username, nextStatus) {
  if (![0, 1].includes(nextStatus)) {
    throw new Error("迥ｶ諤∝ｼ譌謨・);
  }
  const actionLabel = nextStatus === 1 ? "蜷ｯ逕ｨ" : "遖∫畑";
  const ok = await openActionConfirmModal(`遑ｮ隶､${actionLabel}逕ｨ謌ｷ ${username} 蜷暦ｼ歔, `${actionLabel}逕ｨ謌ｷ`, actionLabel);
  if (!ok) return false;

  await request(`/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: JSON.stringify({ status: nextStatus }),
  });
  showToast(`逕ｨ謌ｷ蟾ｲ${actionLabel}`);
  await Promise.all([loadUsers(), loadAudit()]);

  if (String(state.me?.id || "") === String(userId) && nextStatus !== 1) {
    state.token = "";
    state.me = null;
    localStorage.removeItem("wms_token");
    showToast("蠖灘燕逕ｨ謌ｷ蟾ｲ陲ｫ遖∫畑・瑚ｯｷ驥肴眠逋ｻ蠖・);
    await reloadAll();
    switchPanel("overview");
  }
  return true;
}

async function removeUser(userId, username) {
  const ok = await openDeleteConfirmModal(`遑ｮ隶､蛻髯､逕ｨ謌ｷ ${username} 蜷暦ｼ歔);
  if (!ok) return false;

  await request(`/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  showToast("逕ｨ謌ｷ蟾ｲ蛻髯､");
  await Promise.all([loadUsers(), loadAudit()]);

  if (String(state.me?.id || "") === String(userId)) {
    state.token = "";
    state.me = null;
    localStorage.removeItem("wms_token");
    showToast("蠖灘燕逕ｨ謌ｷ蟾ｲ陲ｫ蛻髯､・瑚ｯｷ驥肴眠逋ｻ蠖・);
    await reloadAll();
    switchPanel("overview");
  }
  return true;
}

function openEditUserModal(userId, username, role, department, status = 1) {
  state.selectedEditUserId = String(userId);
  $("editUserId").value = String(userId);
  $("editUsername").value = String(username || "");
  renderUserSelectOptions();
  const normalizedRole = ["employee", "admin"].includes(String(role || "")) ? String(role) : "employee";
  $("editUserRole").value = normalizedRole;
  $("editUserDepartment").value = department || "china_warehouse";
  syncEditUserActionButtons(userId, status, username);
  openModal("editUserModal");
}

function openResetUserPasswordModal(userId, username, passwordInitialized) {
  const mode = passwordInitialized ? "reset" : "activate";
  const generatedPassword = buildDefaultPasswordByUsername(username);
  state.selectedResetPasswordUserId = String(userId);
  $("resetPasswordUserId").value = String(userId);
  $("resetPasswordMode").value = mode;
  $("resetPasswordUsername").value = String(username || "");
  $("resetPasswordNewPassword").value = generatedPassword;
  $("resetUserPasswordModalTitle").textContent = mode === "activate" ? "豼豢ｻ逕ｨ謌ｷ" : "驥咲ｽｮ蟇・・;
  $("resetPasswordSubmitBtn").textContent = mode === "activate" ? "遑ｮ隶､豼豢ｻ" : "遑ｮ隶､驥咲ｽｮ";
  openModal("resetUserPasswordModal");
}

async function getSkuInventoryRows(skuId) {
  try {
    return await request(`/inventory/product-boxes?skuId=${skuId}`);
  } catch {
    return [];
  }
}

async function getCurrentBoxSkuQty(skuId, boxCode) {
  const normalizedBoxCode = normalizeBoxCodeInput(boxCode);
  if (!normalizedBoxCode) return 0;
  const rows = await getSkuInventoryRows(skuId);
  const matched = rows.find(
    (row) => String(row?.box?.boxCode || "").toUpperCase() === normalizedBoxCode,
  );
  return Math.max(0, Number(matched?.qty ?? 0));
}

async function getBoxSkuInventoryRows(boxId) {
  try {
    return await request(`/inventory/box-skus?boxId=${boxId}`);
  } catch {
    return [];
  }
}

function findBoxByAnyCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return null;
  return (
    (Array.isArray(state.boxes) ? state.boxes : []).find(
      (box) => normalizeBoxCodeInput(box?.boxCode) === normalized,
    ) || null
  );
}

function findShelfByAnyCode(raw) {
  const normalized = normalizeShelfCodeInput(raw);
  if (!normalized) return null;
  return (
    (Array.isArray(state.shelves) ? state.shelves : []).find(
      (shelf) => normalizeShelfCodeInput(shelf?.shelfCode) === normalized,
    ) || null
  );
}

function resetBoxContentQueryResult() {
  const summary = $("boxContentQuerySummary");
  const body = $("boxContentQueryBody");
  if (summary) {
    summary.textContent = "隸ｷ霎灘・邂ｱ蜿ｷ蜷取衍隸｢縲・;
    summary.classList.remove("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="4" class="muted">隸ｷ霎灘・邂ｱ蜿ｷ蜷取衍隸｢縲・/td></tr>';
  }
}

function renderBoxContentQueryNotFound(boxCode = "") {
  const summary = $("boxContentQuerySummary");
  const body = $("boxContentQueryBody");
  if (summary) {
    summary.textContent = boxCode ? `譛ｪ謇ｾ蛻ｰ邂ｱ蜿ｷ ${boxCode}` : "譛ｪ謇ｾ蛻ｰ隸･邂ｱ蜿ｷ";
    summary.classList.add("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="4" class="muted">隸ｷ霎灘・邂ｱ蜿ｷ蜷取衍隸｢縲・/td></tr>';
  }
}

function resetShelfBoxQueryResult() {
  const summary = $("shelfBoxQuerySummary");
  const body = $("shelfBoxQueryBody");
  if (summary) {
    summary.textContent = "隸ｷ霎灘・雍ｧ譫ｶ蜿ｷ蜷取衍隸｢縲・;
    summary.classList.remove("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="3" class="muted">隸ｷ霎灘・雍ｧ譫ｶ蜿ｷ蜷取衍隸｢縲・/td></tr>';
  }
}

function renderShelfBoxQueryNotFound(shelfCode = "") {
  const summary = $("shelfBoxQuerySummary");
  const body = $("shelfBoxQueryBody");
  if (summary) {
    summary.textContent = "譛ｪ謇ｾ蛻ｰ隸･雍ｧ譫ｶ蜿ｷ";
    summary.classList.add("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="3" class="muted">隸ｷ霎灘・雍ｧ譫ｶ蜿ｷ蜷取衍隸｢縲・/td></tr>';
  }
}

function setQueryModalDirectResultMode(kind, enabled) {
  const isBox = kind === "box";
  const form = $(isBox ? "boxContentQueryForm" : "shelfBoxQueryForm");
  const input = $(isBox ? "boxContentQueryBoxCode" : "shelfBoxQueryShelfCode");
  const submitButton = form?.querySelector("button[type='submit']");

  if (form) {
    form.classList.toggle("manage-inline-form-direct-result", Boolean(enabled));
  }
  if (input) {
    input.classList.toggle("hidden", Boolean(enabled));
  }
  if (submitButton) {
    submitButton.classList.toggle("hidden", Boolean(enabled));
  }
}

async function openBoxContentQueryModalForBoxCode(boxCode, preferredBoxId = "") {
  await Promise.all([loadShelves(), loadBoxes()]);
  const normalizedBoxCode = normalizeBoxCodeInput(boxCode);
  const box =
    (Array.isArray(state.boxes) ? state.boxes : []).find(
      (item) => String(item?.id || "") === String(preferredBoxId || ""),
    ) || findBoxByAnyCode(normalizedBoxCode);
  if (!box) {
    throw new Error("譛ｪ謇ｾ蛻ｰ蟇ｹ蠎皮ｮｱ蜿ｷ");
  }

  setQueryModalDirectResultMode("box", true);
  $("boxContentQueryBoxCode").value = box?.boxCode || normalizedBoxCode;
  const rows = await getBoxSkuInventoryRows(box.id);
  renderBoxContentQueryResult(box, rows);
  openModal("boxContentQueryModal");
}

async function openShelfBoxQueryModalForShelfCode(shelfCode, preferredShelfId = "") {
  await Promise.all([loadShelves(), loadBoxes()]);
  const normalizedShelfCode = normalizeShelfCodeInput(shelfCode);
  const shelf =
    (Array.isArray(state.shelves) ? state.shelves : []).find(
      (item) => String(item?.id || "") === String(preferredShelfId || ""),
    ) || findShelfByAnyCode(normalizedShelfCode);
  setQueryModalDirectResultMode("shelf", true);
  $("shelfBoxQueryShelfCode").value = shelf?.shelfCode || normalizedShelfCode;
  if (!shelf) {
    renderShelfBoxQueryNotFound(normalizedShelfCode);
    openModal("shelfBoxQueryModal");
    return;
  }
  const { boxCount, rows } = await getShelfBoxQueryRows(shelf);
  renderShelfBoxQueryResult(shelf, rows, boxCount);
  openModal("shelfBoxQueryModal");
}

function renderBoxContentQueryResult(box, rows) {
  const summary = $("boxContentQuerySummary");
  const body = $("boxContentQueryBody");
  if (!summary || !body) return;
  summary.classList.remove("is-error");

  const boxCode = displayText(box?.boxCode);
  const shelfCode = displayText(box?.shelf?.shelfCode || box?.shelfCode);
  const sortedRows = [...(Array.isArray(rows) ? rows : [])].sort((a, b) =>
    String(a?.sku?.sku || "").localeCompare(String(b?.sku?.sku || ""), "en", { numeric: true }),
  );

  if (!sortedRows.length) {
    summary.textContent = `邂ｱ蜿ｷ ${boxCode} 蠖灘燕豐｡譛臥ｮｱ蜀・膚蜩√Ａ;
    body.innerHTML = `
      <tr>
        <td>${escapeHtml(boxCode)}</td>
        <td>${escapeHtml(shelfCode)}</td>
        <td class="muted">-</td>
        <td class="muted">0</td>
      </tr>
    `;
    return;
  }

  summary.textContent = `邂ｱ蜿ｷ ${boxCode} 蜈ｱ ${sortedRows.length} 荳ｪSKU縲Ａ;
  body.innerHTML = sortedRows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(boxCode)}</td>
          <td>${escapeHtml(shelfCode)}</td>
          <td>${escapeHtml(displayText(row?.sku?.sku))}</td>
          <td>${escapeHtml(displayText(row?.qty))}</td>
        </tr>
      `,
    )
    .join("");
}

async function getShelfBoxQueryRows(shelf) {
  const boxes = (Array.isArray(state.boxes) ? state.boxes : [])
    .filter((box) => Number(box?.shelf?.id) === Number(shelf?.id))
    .sort((a, b) => String(a?.boxCode || "").localeCompare(String(b?.boxCode || ""), "en", { numeric: true }));

  const rowsByBox = await Promise.all(
    boxes.map(async (box) => {
      const sortedRows = [...(await getBoxSkuInventoryRows(box.id))].sort((a, b) =>
        String(a?.sku?.sku || "").localeCompare(String(b?.sku?.sku || ""), "en", { numeric: true }),
      );

      if (!sortedRows.length) {
        return [
          {
            boxCode: displayText(box?.boxCode),
            sku: "-",
            qty: 0,
          },
        ];
      }

      return sortedRows.map((row, index) => ({
        boxCode: index === 0 ? displayText(box?.boxCode) : "",
        sku: displayText(row?.sku?.sku),
        qty: displayText(row?.qty),
      }));
    }),
  );

  return {
    boxCount: boxes.length,
    rows: rowsByBox.flat(),
  };
}

function renderShelfBoxQueryResult(shelf, rows, boxCount = 0) {
  const summary = $("shelfBoxQuerySummary");
  const body = $("shelfBoxQueryBody");
  if (!summary || !body) return;
  summary.classList.remove("is-error");

  const shelfCode = displayText(shelf?.shelfCode);
  const safeRows = Array.isArray(rows) ? rows : [];

  if (!boxCount) {
    summary.textContent = `雍ｧ譫ｶ ${shelfCode} 蠖灘燕豐｡譛臥ｮｱ蜿ｷ縲Ａ;
    body.innerHTML = `<tr><td colspan="3" class="muted">雍ｧ譫ｶ ${escapeHtml(shelfCode)} 蠖灘燕豐｡譛臥ｮｱ蜿ｷ縲・/td></tr>`;
    return;
  }

  summary.textContent = `雍ｧ譫ｶ ${shelfCode} 蜈ｱ ${boxCount} 荳ｪ邂ｱ蜿ｷ縲Ａ;
  body.innerHTML = safeRows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(displayText(row?.boxCode))}</td>
          <td>${escapeHtml(displayText(row?.sku))}</td>
          <td>${escapeHtml(displayText(row?.qty))}</td>
        </tr>
      `,
    )
    .join("");
}

function getEligibleStocktakeShelves() {
  return getEnabledShelvesSorted().filter((shelf) => {
    const shelfCode = normalizeShelfCodeInput(shelf?.shelfCode);
    return Boolean(shelfCode) && shelfCode !== "00" && !shelfCode.startsWith("S");
  });
}

async function loadStocktakeTasks() {
  const items = await request("/stocktake-planner/tasks");
  state.stocktakeTasks = Array.isArray(items) ? items : [];
  state.stocktakeVisibleCount = Math.min(30, state.stocktakeTasks.length);
}

function buildStocktakeTaskStatusText(task) {
  return task?.status === "confirmed" ? "蟾ｲ遑ｮ隶､" : "蠕・｡ｮ隶､";
}

async function generateStocktakeTasks() {
  const items = await request("/stocktake-planner/tasks/generate", {
    method: "POST",
    body: "{}",
  });
  state.stocktakeTasks = Array.isArray(items) ? items : [];
  state.stocktakeVisibleCount = Math.min(Math.max(state.stocktakeVisibleCount || 0, 30), state.stocktakeTasks.length);
}

async function clearFutureStocktakeTasks() {
  const result = await request("/stocktake-planner/tasks/clear-future", {
    method: "POST",
    body: "{}",
  });
  state.stocktakeTasks = Array.isArray(result?.tasks) ? result.tasks : [];
  state.stocktakeVisibleCount = Math.min(Math.max(state.stocktakeVisibleCount || 0, 30), state.stocktakeTasks.length);
  return result;
}

async function confirmStocktakeTask(taskId) {
  const updated = await request(`/stocktake-planner/tasks/${encodeURIComponent(taskId)}/confirm`, {
    method: "POST",
    body: "{}",
  });
  const items = Array.isArray(state.stocktakeTasks) ? [...state.stocktakeTasks] : [];
  const index = items.findIndex((item) => String(item?.id || "") === String(taskId || ""));
  if (index >= 0) {
    items[index] = updated;
  }
  state.stocktakeTasks = items;
  return updated;
}

function renderStocktakePlanner() {
  const body = $("stocktakePlannerBody");
  const summary = $("stocktakePlannerSummary");
  if (!body || !summary) return;
  $("clearFutureStocktakeTasksBtn")?.classList.toggle("hidden", !hasAdminAccess(state.me?.role));

  const tasks = [...(Array.isArray(state.stocktakeTasks) ? state.stocktakeTasks : [])].sort((a, b) =>
    String(b?.plannedDate || "").localeCompare(String(a?.plannedDate || ""), "en", { numeric: true }),
  );
  const visibleTasks = tasks.slice(0, Math.max(state.stocktakeVisibleCount || 0, 30));

  if (!tasks.length) {
    summary.textContent = "轤ｹ蜃ｻ窶懃函謌仙ｺ灘ｭ倡尨轤ｹ莉ｻ蜉｡窶晏錘・御ｼ壽潔譌･譛溷柱雍ｧ譫ｶ鬘ｺ蠎冗函謌千尨轤ｹ莉ｻ蜉｡縲・;
    body.innerHTML = '<tr><td colspan="7" class="muted">證よ裏蠎灘ｭ倡尨轤ｹ莉ｻ蜉｡縲・/td></tr>';
    return;
  }

  const latestDate = formatDateOnly(tasks[0]?.plannedDate);
  const earliestDate = formatDateOnly(tasks[tasks.length - 1]?.plannedDate);
  summary.textContent = `蟾ｲ逕滓・ ${tasks.length} 譚｡蠎灘ｭ倡尨轤ｹ莉ｻ蜉｡・梧律譛溯激蝗ｴ ${earliestDate} - ${latestDate}縲Ａ;
  body.innerHTML = visibleTasks
    .map(
      (task) => `
        <tr>
          <td>${escapeHtml(formatDateOnlyWithWeekday(task?.plannedDate))}</td>
          <td>${escapeHtml(displayText(task?.taskNo))}</td>
          <td>${escapeHtml(displayText(task?.shelfCode))}</td>
          <td>${escapeHtml(buildStocktakeTaskStatusText(task))}</td>
          <td>${escapeHtml(formatDate(task?.confirmedAt))}</td>
          <td>${escapeHtml(displayText(task?.confirmedByName) || "-")}</td>
          <td>
            <div class="action-row">
              <button type="button" class="tiny-btn secondary" data-action="openStocktakeTaskDetail" data-id="${escapeHtml(displayText(task?.id))}">譟･逵・/button>
              ${
                task?.status === "confirmed"
                  ? ""
                  : `<button type="button" class="tiny-btn" data-action="confirmStocktakeTask" data-id="${escapeHtml(displayText(task?.id))}">遑ｮ隶､</button>`
              }
            </div>
          </td>
        </tr>
      `,
    )
    .join("");
}

function loadMoreStocktakeTasksIfNeeded() {
  const panel = $("stocktakePlanner");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.stocktakeVisibleCount >= state.stocktakeTasks.length) return;
  state.stocktakeVisibleCount = Math.min(state.stocktakeTasks.length, state.stocktakeVisibleCount + 30);
  renderStocktakePlanner();
}

function renderStocktakeTaskDetail(task, rows, boxCount = 0) {
  const meta = $("stocktakeTaskDetailMeta");
  const summary = $("stocktakeTaskDetailSummary");
  const body = $("stocktakeTaskDetailBody");
  if (!meta || !summary || !body) return;

  state.selectedStocktakeTask = task || null;
  state.selectedStocktakeTaskRows = Array.isArray(rows) ? rows : [];

  if (!task) {
    meta.innerHTML = "";
    summary.textContent = "隸ｷ騾画叫逶倡せ莉ｻ蜉｡蜷取衍逵九・;
    body.innerHTML = '<tr><td colspan="3" class="muted">隸ｷ騾画叫逶倡せ莉ｻ蜉｡蜷取衍逵九・/td></tr>';
    return;
  }

  meta.innerHTML = `
    <div><strong>莉ｻ蜉｡郛門捷・・/strong>${escapeHtml(displayText(task?.taskNo))}</div>
    <div><strong>莉ｻ蜉｡譌･譛滂ｼ・/strong>${escapeHtml(formatDateOnly(task?.plannedDate))}</div>
    <div><strong>雍ｧ譫ｶ蜿ｷ・・/strong>${escapeHtml(displayText(task?.shelfCode))}</div>
    <div><strong>迥ｶ諤・ｼ・/strong>${escapeHtml(buildStocktakeTaskStatusText(task))}</div>
    <div><strong>遑ｮ隶､譌･譛滂ｼ・/strong>${escapeHtml(formatDate(task?.confirmedAt))}</div>
    <div><strong>遑ｮ隶､莠ｺ・・/strong>${escapeHtml(displayText(task?.confirmedByName) || "-")}</div>
  `;

  if (!boxCount) {
    summary.textContent = `雍ｧ譫ｶ ${displayText(task?.shelfCode)} 蠖灘燕豐｡譛臥ｮｱ蜿ｷ縲Ａ;
    body.innerHTML = `<tr><td colspan="3" class="muted">雍ｧ譫ｶ ${escapeHtml(displayText(task?.shelfCode))} 蠖灘燕豐｡譛臥ｮｱ蜿ｷ縲・/td></tr>`;
    return;
  }

  summary.textContent = `雍ｧ譫ｶ ${displayText(task?.shelfCode)} 蜈ｱ ${boxCount} 荳ｪ邂ｱ蜿ｷ縲Ａ;
  body.innerHTML = state.selectedStocktakeTaskRows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(displayText(row?.boxCode))}</td>
          <td>${escapeHtml(displayText(row?.sku))}</td>
          <td>${escapeHtml(displayText(row?.qty))}</td>
        </tr>
      `,
    )
    .join("");
}

function openStocktakePrintWindow(task, rows) {
  if (!task) {
    throw new Error("譛ｪ謇ｾ蛻ｰ逶倡せ莉ｻ蜉｡");
  }
  const safeRows = Array.isArray(rows) ? rows : [];
  const popup = window.open("", "_blank", "width=960,height=720");
  if (!popup) {
    throw new Error("謇灘魂遯怜哨陲ｫ諡ｦ謌ｪ・瑚ｯｷ蜈∬ｮｸ豬剰ｧ亥勣謇灘ｼ譁ｰ遯怜哨");
  }

  popup.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(displayText(task?.taskNo))}</title>
    <style>
      body { font-family: "Microsoft YaHei", sans-serif; margin: 24px; color: #111; }
      h1 { font-size: 24px; margin: 0 0 12px; }
      .meta { margin-bottom: 16px; display: grid; gap: 6px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #cfdad0; padding: 8px 10px; text-align: left; }
      th { background: #eef5f0; }
      @media print { body { margin: 12mm; } }
    </style>
  </head>
  <body>
    <h1>蠎灘ｭ倡尨轤ｹ譏守ｻ・/h1>
    <div class="meta">
      <div><strong>莉ｻ蜉｡郛門捷・・/strong>${escapeHtml(displayText(task?.taskNo))}</div>
      <div><strong>莉ｻ蜉｡譌･譛滂ｼ・/strong>${escapeHtml(formatDateOnly(task?.plannedDate))}</div>
      <div><strong>雍ｧ譫ｶ蜿ｷ・・/strong>${escapeHtml(displayText(task?.shelfCode))}</div>
      <div><strong>迥ｶ諤・ｼ・/strong>${escapeHtml(buildStocktakeTaskStatusText(task))}</div>
      <div><strong>遑ｮ隶､譌･譛滂ｼ・/strong>${escapeHtml(formatDate(task?.confirmedAt))}</div>
      <div><strong>遑ｮ隶､莠ｺ・・/strong>${escapeHtml(displayText(task?.confirmedByName) || "-")}</div>
    </div>
    <table>
      <thead><tr><th>邂ｱ蜿ｷ</th><th>SKU</th><th>謨ｰ驥・/th></tr></thead>
      <tbody>
        ${
          safeRows.length
            ? safeRows
                .map(
                  (row) => `
          <tr>
            <td>${escapeHtml(displayText(row?.boxCode))}</td>
            <td>${escapeHtml(displayText(row?.sku))}</td>
            <td>${escapeHtml(displayText(row?.qty))}</td>
          </tr>`,
                )
                .join("")
            : `<tr><td colspan="3">蠖灘燕豐｡譛臥尨轤ｹ譏守ｻ・・/td></tr>`
        }
      </tbody>
    </table>
    <script>
      window.addEventListener("load", function () {
        setTimeout(function () { window.focus(); window.print(); }, 120);
      });
      window.addEventListener("afterprint", function () { window.close(); });
    </script>
  </body>
</html>`);
  popup.document.close();
}

async function openStocktakeTaskDetail(taskId) {
  await Promise.all([loadShelves(), loadBoxes()]);
  const task = (Array.isArray(state.stocktakeTasks) ? state.stocktakeTasks : []).find(
    (item) => String(item?.id || "") === String(taskId || ""),
  );
  if (!task) {
    throw new Error("譛ｪ謇ｾ蛻ｰ逶倡せ莉ｻ蜉｡");
  }
  const shelf =
    (Array.isArray(state.shelves) ? state.shelves : []).find(
      (item) => String(item?.id || "") === String(task?.shelfId || ""),
    ) || findShelfByAnyCode(task?.shelfCode);
  if (!shelf) {
    throw new Error("譛ｪ謇ｾ蛻ｰ蟇ｹ蠎碑ｴｧ譫ｶ");
  }
  const { boxCount, rows } = await getShelfBoxQueryRows(shelf);
  renderStocktakeTaskDetail(task, rows, boxCount);
  openModal("stocktakeTaskDetailModal");
}

function renderInventoryLocationRows(rows) {
  if (!rows.length) {
    return '<span class="muted">譌蠎灘ｭ・/span>';
  }

  return rows
    .map((row) => {
      const boxCode = row.box?.boxCode || "-";
      const shelfCode = row.box?.shelf?.shelfCode || "-";
      const qty = Number(row.qty ?? 0);
      return `<div>${escapeHtml(boxCode)} / ${escapeHtml(shelfCode)} / 謨ｰ驥・${escapeHtml(qty)}</div>`;
    })
    .join("");
}

function renderInboundButton(skuId, boxCode = "", label = "譁ｰ蠅槫・蠎・, lockBox = false) {
  const boxAttr = boxCode ? ` data-box-code="${escapeHtml(boxCode)}"` : "";
  const lockAttr = lockBox ? ' data-lock-box="1"' : "";
  return `<button class="tiny-btn" data-action="inventoryInbound" data-sku-id="${skuId}"${boxAttr}${lockAttr}>${escapeHtml(label)}</button>`;
}

function renderEditButton(skuId) {
  return `<button class="tiny-btn" data-action="inventoryEdit" data-sku-id="${skuId}">郛冶ｾ・/button>`;
}

function renderInventoryFbaJumpButton(skuCode) {
  const keyword = String(skuCode || "").trim();
  return `<button class="tiny-btn" data-action="inventoryFbaJump" data-sku-code="${escapeHtml(keyword)}">譟･逵・/button>`;
}

function renderOutboundButton(
  skuId,
  totalQty,
  boxCode = "",
  { label = "FBA陦･雍ｧ", ghost = true, lockBox = false, action = "inventoryOutbound", maxQty = null } = {},
) {
  if (Number(totalQty) <= 0) {
    return "";
  }
  const boxAttr = boxCode ? ` data-box-code="${escapeHtml(boxCode)}"` : "";
  const lockAttr = lockBox ? ' data-lock-box="1"' : "";
  const normalizedMaxQty = Math.floor(Number(maxQty));
  const maxQtyAttr = Number.isInteger(normalizedMaxQty) && normalizedMaxQty > 0
    ? ` data-max-qty="${escapeHtml(normalizedMaxQty)}"`
    : "";
  const className = ghost ? "tiny-btn ghost" : "tiny-btn";
  return `<button class="${className}" data-action="${action}" data-sku-id="${skuId}"${boxAttr}${lockAttr}${maxQtyAttr}>${escapeHtml(label)}</button>`;
}

function getFbaPendingQtyBySku(skuId) {
  return Number(state.fbaPendingBySku[String(skuId)] || 0);
}

function getFbaPendingQtyByBoxSku(boxId, skuId) {
  return Number(state.fbaPendingByBoxSku[`${String(boxId)}-${String(skuId)}`] || 0);
}

function renderQtyWithPending(qty, pendingQty) {
  const safeQty = Number(qty || 0);
  const safePending = Number(pendingQty || 0);
  if (safePending <= 0) {
    return escapeHtml(safeQty);
  }
  return `${escapeHtml(safeQty)}<span class="qty-pending">(-${escapeHtml(safePending)})</span>`;
}

function renderBoxSkuFlatTable(currentSku, rows, boxSkuMap) {
  const currentSkuId = Number(currentSku.id);
  const currentSkuRows = rows
    .filter((row) => Number(row.qty ?? 0) > 0 && row.box?.id)
    .sort((a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0));
  if (!currentSkuRows.length) {
    return "";
  }

  const targetBoxes = currentSkuRows
    .map((row) => ({
      boxId: String(row.box.id),
      boxCode: row.box?.boxCode || "-",
      shelfCode: row.box?.shelf?.shelfCode || "-",
      currentSkuQty: Number(row.qty ?? 0),
    }))
    .sort((a, b) => a.currentSkuQty - b.currentSkuQty);

  const flatRows = targetBoxes.flatMap((box) => {
    const boxRows = (boxSkuMap.get(String(box.boxId)) || [])
      .filter((row) => Number(row.qty ?? 0) > 0)
      .sort((a, b) => {
        const aIsCurrent = Number(a.sku?.id) === currentSkuId;
        const bIsCurrent = Number(b.sku?.id) === currentSkuId;
        if (aIsCurrent !== bIsCurrent) {
          return aIsCurrent ? -1 : 1;
        }
        if (!aIsCurrent && !bIsCurrent) {
          const qtyDiff = Number(b.qty ?? 0) - Number(a.qty ?? 0);
          if (qtyDiff !== 0) {
            return qtyDiff;
          }
        }
        return String(displayText(a.sku?.sku)).localeCompare(String(displayText(b.sku?.sku)), "en", { numeric: true });
      });
    if (!boxRows.length) {
      return [
        {
          boxId: box.boxId,
          boxCode: "",
          shelfCode: "",
          skuId: 0,
          sku: "-",
          qty: 0,
          isCurrentSku: false,
        },
      ];
    }
    return boxRows.map((row) => ({
      boxId: box.boxId,
      boxCode: Number(row.sku?.id) === currentSkuId ? box.boxCode : "",
      shelfCode: Number(row.sku?.id) === currentSkuId ? box.shelfCode : "",
      skuId: Number(row.sku?.id || 0),
      sku: row.sku?.sku || "-",
      qty: Number(row.qty ?? 0),
      isCurrentSku: Number(row.sku?.id) === currentSkuId,
    }));
  });

  if (!flatRows.length) {
    return "";
  }

  return `
    <div class="inventory-box-table-wrap">
      <table class="inventory-box-table">
        <thead>
          <tr><th>邂ｱ蜿ｷ</th><th>雍ｧ譫ｶ蜿ｷ</th><th>SKU</th><th>謨ｰ驥・/th><th></th></tr>
        </thead>
        <tbody>
          ${flatRows
            .map((row) => {
              const inboundButton = renderInboundButton(currentSkuId, row.boxCode, "蜈･蠎・, true);
              const outboundPrimaryButton = renderOutboundButton(currentSkuId, row.qty, row.boxCode, {
                label: "FBA陦･雍ｧ",
                ghost: false,
                lockBox: true,
                action: "inventoryOutbound",
                maxQty: row.qty,
              });
              const outboundOneButton = renderOutboundButton(currentSkuId, row.qty, row.boxCode, {
                label: "蜃ｺ蠎・莉ｶ",
                ghost: false,
                lockBox: true,
                action: "inventoryOutboundOne",
              });
              const actionButtons = row.isCurrentSku
                ? `
                  <div class="action-row">
                    ${inboundButton}
                    ${outboundPrimaryButton}
                    ${outboundOneButton}
                  </div>
                `
                : '<span class="muted">-</span>';
              return `
                <tr class="${row.isCurrentSku ? "inventory-current-sku-row" : ""}">
                  <td>${escapeHtml(row.boxCode)}</td>
                  <td>${escapeHtml(row.shelfCode)}</td>
                  <td>${escapeHtml(row.sku)}</td>
                  <td>${renderQtyWithPending(row.qty, row.isCurrentSku ? getFbaPendingQtyByBoxSku(row.boxId, currentSkuId) : 0)}</td>
                  <td>${actionButtons}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderInventoryTable() {
  const list = state.inventorySortedSkus.slice(0, state.inventoryVisibleCount);
  const html = list
    .map((sku) => {
      const totalQty = Number(state.inventoryTotalsBySku?.[String(sku.id)] ?? 0);
      const pendingQty = getFbaPendingQtyBySku(sku.id);
      return `
      <tr class="inventory-main-row">
        <td>${escapeHtml(displayText(sku.model))}</td>
        <td>${escapeHtml(displayText(sku.remark))}</td>
        <td>${escapeHtml(displayText(sku.shop))}</td>
        <td>${escapeHtml(sku.sku)}</td>
        <td>${renderQtyWithPending(totalQty, pendingQty)}</td>
        <td>
          <div class="action-row">
            ${renderInventoryFbaJumpButton(sku.sku)}
          </div>
        </td>
      </tr>
    `;
    })
    .join("");

  $("inventoryBody").innerHTML = html || '<tr><td colspan="6" class="muted">-</td></tr>';
}

function loadMoreInventoryIfNeeded() {
  if (state.inventorySearchMode) return;
  if (!state.token) return;
  const inventoryPanel = $("inventory");
  if (!inventoryPanel || !inventoryPanel.classList.contains("active")) return;
  if (state.inventoryVisibleCount >= state.inventorySortedSkus.length) return;
  state.inventoryVisibleCount += state.inventoryListPageSize;
  renderInventoryTable();
}

function loadMoreInventorySearchIfNeeded() {
  if (!state.inventorySearchMode) return;
  if (!state.token) return;
  if (!state.inventorySearchHasMore || state.inventorySearchLoading) return;
  const inventoryPanel = $("inventory");
  if (!inventoryPanel || !inventoryPanel.classList.contains("active")) return;
  if (!state.inventorySearchKeyword) return;

  searchInventoryProducts(state.inventorySearchKeyword, { append: true }).catch((error) => {
    showToast(error.message, true);
  });
}

async function loadInventory({ preserveSearch = false } = {}) {
  const [skus, totals] = await Promise.all([
    request("/skus"),
    request("/inventory/sku-totals"),
    loadFbaPendingSummary(),
  ]);
  state.inventorySkus = skus;
  state.inventoryTotalsBySku = totals || {};
  state.inventoryLocations = new Map();
  $("statSkus").textContent = skus.length;
  renderSkuOptionsForSelect("moveProductSkuId", "隸ｷ騾画叫SKU");

  state.inventorySortedSkus = [...skus].sort((a, b) => {
    const qtyA = Number(state.inventoryTotalsBySku?.[String(a.id)] ?? 0);
    const qtyB = Number(state.inventoryTotalsBySku?.[String(b.id)] ?? 0);
    return qtyB - qtyA;
  });
  state.inventoryVisibleCount = state.inventoryListPageSize;
  if (!preserveSearch) {
    resetInventorySearchState();
    setInventoryDisplayMode(false);
    renderInventoryTable();
  }
  await refreshMoveProductOldBoxOptionsBySku();
}

function renderInventorySearchResults(skus, locationMap, boxSkuMap) {
  const container = $("inventorySearchResults");
  if (!skus.length) {
    container.textContent = "譛ｪ謇ｾ蛻ｰ蛹ｹ驟堺ｺｧ蜩・;
    return;
  }

  container.innerHTML = skus
    .map((sku) => {
      const rows = locationMap.get(String(sku.id)) || [];
      const totalQty = rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
      const pendingQty = getFbaPendingQtyBySku(sku.id);
      const leftRows = [
        ["蝙句捷", displayText(sku.model)],
        ["蜩∫煙", displayText(sku.brand)],
        ["邀ｻ蝙・, displayText(sku.type)],
        ["鬚懆牡", displayText(sku.color)],
        ["螟・ｳｨ", displayText(sku.remark)],
        ["蠎鈴銅", displayText(sku.shop)],
      ];
      const rightRows = [
        ["SKU", displayText(sku.sku)],
        ["ASIN", displayText(sku.asin)],
        ["FNSKU", displayText(sku.fnsku)],
        ["FBMSKU", displayText(sku.fbmSku)],
        ["rbSKU", displayText(sku.rbSku)],
        ["蠎灘ｭ俶ｻ謨ｰ驥・, totalQty],
      ];
      const boxTable = totalQty > 0 ? renderBoxSkuFlatTable(sku, rows, boxSkuMap) : "";
      const topActionRow = `
        <div class="action-row">
          ${renderEditButton(sku.id)}
          ${renderInboundButton(sku.id, "", "譁ｰ蠅槫・蠎・)}
        </div>
      `;
      return `
      <div class="inventory-search-item">
        <div class="inventory-search-fields">
          <div class="inventory-search-column">
            ${leftRows
              .map(
                ([name, value]) => `
              <div class="inventory-search-field">
                <span class="inventory-search-field-name">${escapeHtml(name)}・・/span>
                <span class="inventory-search-field-value">${escapeHtml(value)}</span>
              </div>
            `,
              )
              .join("")}
          </div>
          <div class="inventory-search-column">
            ${rightRows
              .map(
                ([name, value]) => `
              <div class="inventory-search-field">
                <span class="inventory-search-field-name">${escapeHtml(name)}・・/span>
                <span class="inventory-search-field-value">${
                  name === "蠎灘ｭ俶ｻ謨ｰ驥・
                    ? renderQtyWithPending(value, pendingQty)
                    : escapeHtml(value)
                }</span>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>
        ${totalQty > 0 ? "" : `<div class="inventory-search-locations">${renderInventoryLocationRows(rows)}</div>`}
        ${topActionRow}
        ${boxTable}
      </div>
    `;
    })
    .join("");
}

async function searchInventoryProducts(keyword, { append = false } = {}) {
  const normalizedKeyword = String(keyword || "").trim();
  if (!normalizedKeyword) {
    resetInventorySearchState();
    setInventoryDisplayMode(false);
    renderInventoryTable();
    focusInventorySearch();
    return;
  }

  if (append && normalizedKeyword !== state.inventorySearchKeyword) {
    return searchInventoryProducts(normalizedKeyword);
  }

  if (append) {
    if (state.inventorySearchLoading || !state.inventorySearchHasMore) {
      return;
    }
  } else {
    state.inventorySearchKeyword = normalizedKeyword;
    state.inventorySearchPage = 0;
    state.inventorySearchHasMore = true;
    state.inventorySearchSkus = [];
    state.inventorySearchLocationMap = new Map();
    state.inventorySearchBoxSkuMap = new Map();
  }

  const nextPage = append ? state.inventorySearchPage + 1 : 1;
  const pageSize = state.inventorySearchPageSize;
  state.inventorySearchLoading = true;

  try {
    const skus = await request(
      `/inventory/search?keyword=${encodeURIComponent(normalizedKeyword)}&page=${nextPage}&pageSize=${pageSize}`,
    );
    const existingSkuIds = new Set(state.inventorySearchSkus.map((sku) => String(sku.id)));
    const nextSkus = append ? [...state.inventorySearchSkus] : [];
    const pageSkus = skus.filter((sku) => {
      const skuId = String(sku?.id || "");
      if (!skuId || existingSkuIds.has(skuId)) {
        return false;
      }
      existingSkuIds.add(skuId);
      return true;
    });
    nextSkus.push(...pageSkus);

    const locationEntries = await Promise.all(
      pageSkus.map(async (sku) => [String(sku.id), await getSkuInventoryRows(sku.id)]),
    );
    const nextLocationMap = append ? new Map(state.inventorySearchLocationMap) : new Map();
    locationEntries.forEach(([skuId, rows]) => {
      nextLocationMap.set(String(skuId), rows);
    });

    const boxIds = Array.from(
      new Set(
        locationEntries
          .flatMap(([, rows]) => rows.map((row) => row.box?.id))
          .filter((boxId) => boxId !== null && boxId !== undefined)
          .map((boxId) => String(boxId)),
      ),
    );
    const boxSkuEntries = await Promise.all(
      boxIds.map(async (boxId) => [String(boxId), await getBoxSkuInventoryRows(boxId)]),
    );
    const nextBoxSkuMap = append ? new Map(state.inventorySearchBoxSkuMap) : new Map();
    boxSkuEntries.forEach(([boxId, rows]) => {
      nextBoxSkuMap.set(String(boxId), rows);
    });

    await loadFbaPendingSummary();
    state.inventorySearchKeyword = normalizedKeyword;
    state.inventorySearchPage = nextPage;
    state.inventorySearchHasMore = skus.length >= pageSize;
    state.inventorySearchSkus = nextSkus;
    state.inventorySearchLocationMap = nextLocationMap;
    state.inventorySearchBoxSkuMap = nextBoxSkuMap;

    setInventoryDisplayMode(true);
    renderInventorySearchResults(
      state.inventorySearchSkus,
      state.inventorySearchLocationMap,
      state.inventorySearchBoxSkuMap,
    );
  } finally {
    state.inventorySearchLoading = false;
  }
}

function findSkuById(skuId) {
  return state.inventorySkus.find((sku) => Number(sku.id) === Number(skuId));
}

function ensureSkuReadyForFbaReplenishment(skuId) {
  const sku = findSkuById(skuId);
  if (!sku) {
    throw new Error("譛ｪ謇ｾ蛻ｰSKU");
  }

  const fnsku = String(sku.fnsku || "").trim();
  if (!fnsku) {
    throw new Error("隸･SKU郛ｺ蟆詮NSKU・梧裏豕募書襍ｷFBA陦･雍ｧ");
  }

  const shop = String(sku.shop || "").trim();
  if (!shop) {
    throw new Error("隸･SKU郛ｺ蟆第園螻槫ｺ鈴銅・梧裏豕募書襍ｷFBA陦･雍ｧ");
  }

  return sku;
}

async function openEditSkuModal(skuId) {
  const sku = findSkuById(skuId);
  if (!sku) {
    throw new Error("譛ｪ謇ｾ蛻ｰ莠ｧ蜩・);
  }
  await Promise.all([loadBrands(), loadSkuTypes(), loadShops()]);

  $("editSkuId").value = String(sku.id);
  $("editModel").value = sku.model || "";
  renderBrandOptionsForSelect("editBrand", "隸ｷ騾画叫蜩∫煙", sku.brand || "");
  renderSkuTypeOptionsForSelect("editType", "隸ｷ騾画叫邀ｻ蝙・, sku.type || "");
  $("editColor").value = sku.color || "";
  renderShopOptionsForSelect("editShop", "隸ｷ騾画叫蠎鈴銅", sku.shop || "");
  $("editRemark").value = sku.remark || "";
  $("editSku").value = sku.sku || "";
  $("editErpSku").value = sku.rbSku || "";
  $("editAsin").value = sku.asin || "";
  $("editFnsku").value = sku.fnsku || "";
  $("editFbmSku").value = sku.fbmSku || "";
  openModal("editSkuModal");
}

async function submitEditSkuForm() {
  const skuId = Number($("editSkuId").value);
  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("隸ｷ騾画叫莠ｧ蜩・);
  }

  const toNullableValue = (id) => {
    const value = String($(id)?.value ?? "").trim();
    return value ? value : null;
  };

  const payload = {
    skuId,
    // SKU is read-only and not submitted for editing.
    model: toNullableValue("editModel"),
    brand: toNullableValue("editBrand"),
    type: toNullableValue("editType"),
    color: toNullableValue("editColor"),
    shop: toNullableValue("editShop"),
    remark: toNullableValue("editRemark"),
    rbSku: toNullableValue("editErpSku"),
    asin: toNullableValue("editAsin"),
    fnsku: toNullableValue("editFnsku"),
    fbmSku: toNullableValue("editFbmSku"),
  };

  await request("/sku-edit-requests", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function renderShelfOptionsForSelect(selectId, placeholder) {
  const select = $(selectId);
  if (!select) return;

  const prev = select.value;
  const options = state.shelves
    .map((shelf) => {
      const isEnabled = Number(shelf.status) === 1;
      const disabledAttr = isEnabled ? "" : " disabled";
      const disabledMark = isEnabled ? "" : "・育ｦ∫畑・・;
      return `<option value="${escapeHtml(shelf.id)}"${disabledAttr}>${escapeHtml(shelf.shelfCode)}${disabledMark}</option>`;
    })
    .join("");

  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev && state.shelves.some((shelf) => String(shelf.id) === prev && Number(shelf.status) === 1)) {
    select.value = prev;
  }
}

function renderBoxOptionsForSelect(selectId, placeholder) {
  const select = $(selectId);
  if (!select) return;

  const prev = select.value;
  const options = getEnabledBoxesSorted()
    .map((box) => {
      const shelfCode = box?.shelf?.shelfCode ? ` / ${box.shelf.shelfCode}` : "";
      return `<option value="${escapeHtml(box.id)}">${escapeHtml(box.boxCode)}${escapeHtml(shelfCode)}</option>`;
    })
    .join("");

  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev && getEnabledBoxesSorted().some((box) => String(box.id) === String(prev))) {
    select.value = prev;
  }
}

function renderSkuOptionsForSelect(selectId, placeholder) {
  const control = $(selectId);
  if (!control) return;

  const rows = [...state.inventorySkus].sort((a, b) =>
    String(a.sku || "").localeCompare(String(b.sku || ""), "en", { numeric: true }),
  );

  if (String(control.tagName || "").toUpperCase() === "SELECT") {
    const prev = control.value;
    const options = rows
      .map((sku) => `<option value="${escapeHtml(sku.id)}">${escapeHtml(sku.sku)}</option>`)
      .join("");
    control.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
    if (prev && state.inventorySkus.some((sku) => String(sku.id) === String(prev))) {
      control.value = prev;
    }
    return;
  }

  const listId = control.getAttribute("list");
  const datalist = listId ? $(listId) : null;
  if (!datalist) return;
  const prev = String(control.value || "").trim();
  datalist.innerHTML = rows
    .map((sku) => `<option value="${escapeHtml(sku.sku)}"></option>`)
    .join("");
  if (prev) {
    const exact = rows.find(
      (sku) => String(sku.sku || "").trim().toUpperCase() === prev.toUpperCase(),
    );
    if (exact?.sku) {
      control.value = exact.sku;
    }
  }
}

function resolveMoveProductSkuId() {
  const control = $("moveProductSkuId");
  if (!control) return 0;
  if (String(control.tagName || "").toUpperCase() === "SELECT") {
    return Number(control.value || 0);
  }
  const rawSku = String(control.value || "").trim().toUpperCase();
  if (!rawSku) return 0;
  const matched = state.inventorySkus.find(
    (item) => String(item?.sku || "").trim().toUpperCase() === rawSku,
  );
  return matched ? Number(matched.id || 0) : 0;
}

function getEnabledBrandsSorted() {
  return state.brands
    .filter((item) => Number(item.status) === 1)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }));
}

function getEnabledSkuTypesSorted() {
  return state.skuTypes
    .filter((item) => Number(item.status) === 1)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }));
}

function getEnabledShopsSorted() {
  return state.shops
    .filter((item) => Number(item.status) === 1)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }));
}

function renderBrandOptionsForSelect(selectId, placeholder, selectedValue = "") {
  const select = $(selectId);
  if (!select) return;

  const prev = selectedValue || select.value;
  const options = getEnabledBrandsSorted()
    .map((brand) => `<option value="${escapeHtml(brand.name)}">${escapeHtml(brand.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev) {
    const exists = Array.from(select.options).some((option) => option.value === prev);
    if (!exists) {
      const extra = document.createElement("option");
      extra.value = prev;
      extra.textContent = `${prev}・亥紙蜿ｲ蛟ｼ・荏;
      select.appendChild(extra);
    }
    select.value = prev;
  }
}

function renderSkuTypeOptionsForSelect(selectId, placeholder, selectedValue = "") {
  const select = $(selectId);
  if (!select) return;

  const prev = selectedValue || select.value;
  const options = getEnabledSkuTypesSorted()
    .map((skuType) => `<option value="${escapeHtml(skuType.name)}">${escapeHtml(skuType.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev) {
    const exists = Array.from(select.options).some((option) => option.value === prev);
    if (!exists) {
      const extra = document.createElement("option");
      extra.value = prev;
      extra.textContent = `${prev}・亥紙蜿ｲ蛟ｼ・荏;
      select.appendChild(extra);
    }
    select.value = prev;
  }
}

function renderShopOptionsForSelect(selectId, placeholder, selectedValue = "") {
  const select = $(selectId);
  if (!select) return;

  const prev = selectedValue || select.value;
  const options = getEnabledShopsSorted()
    .map((shop) => `<option value="${escapeHtml(shop.name)}">${escapeHtml(shop.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev) {
    const exists = Array.from(select.options).some((option) => option.value === prev);
    if (!exists) {
      const extra = document.createElement("option");
      extra.value = prev;
      extra.textContent = `${prev}・亥紙蜿ｲ蛟ｼ・荏;
      select.appendChild(extra);
    }
    select.value = prev;
  }
}

function renderBrandsTable() {
  const body = $("brandsBody");
  if (!body) return;
  const rows = [...state.brands].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }),
  );

  body.innerHTML =
    rows
      .map(
        (item) => {
          const itemId = String(item.id);
          const editing = state.brandEditingIds.has(itemId);
          return `
      <tr>
        <td>
          <input
            id="brandName-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name)}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name)}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editBrand" data-id="${escapeHtml(item.id)}">${editing ? "遑ｮ隶､蜿俶峩" : "蜿俶峩"}</button>
          <button class="tiny-btn danger" data-action="deleteBrand" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">蛻髯､</button>
        </td>
      </tr>
    `;
        },
      )
      .join("") || '<tr><td colspan="2" class="muted">-</td></tr>';
}

function renderSkuTypesTable() {
  const body = $("skuTypesBody");
  if (!body) return;
  const rows = [...state.skuTypes].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }),
  );

  body.innerHTML =
    rows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.skuTypeEditingIds.has(itemId);
        return `
      <tr>
        <td>
          <input
            id="skuTypeName-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name)}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name)}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editSkuType" data-id="${escapeHtml(item.id)}">${editing ? "遑ｮ隶､蜿俶峩" : "蜿俶峩"}</button>
          <button class="tiny-btn danger" data-action="deleteSkuType" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">蛻髯､</button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="2" class="muted">-</td></tr>';
}

function renderShopsTable() {
  const body = $("shopsBody");
  if (!body) return;
  const rows = [...state.shops].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }),
  );

  body.innerHTML =
    rows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.shopEditingIds.has(itemId);
        return `
      <tr>
        <td>
          <input
            id="shopName-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name)}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name)}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editShop" data-id="${escapeHtml(item.id)}">${editing ? "遑ｮ隶､蜿俶峩" : "蜿俶峩"}</button>
          <button class="tiny-btn danger" data-action="deleteShop" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">蛻髯､</button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="2" class="muted">-</td></tr>';
}

function getShelvesSortedForManage() {
  return [...(Array.isArray(state.shelves) ? state.shelves : [])].sort((a, b) =>
    String(a?.shelfCode || "").localeCompare(String(b?.shelfCode || ""), "en", { numeric: true }),
  );
}

function getBoxesSortedForManage() {
  return [...(Array.isArray(state.boxes) ? state.boxes : [])].sort((a, b) =>
    String(a?.boxCode || "").localeCompare(String(b?.boxCode || ""), "en", { numeric: true }),
  );
}

function resetShelfManageVisibleCount() {
  state.shelfManageVisibleCount = state.manageModalInitialPageSize;
}

function resetBoxManageVisibleCount() {
  state.boxManageVisibleCount = state.manageModalInitialPageSize;
}

function loadMoreShelvesManageIfNeeded() {
  const wrap = $("shelfManageTableWrap");
  if (!wrap) return;
  const total = getShelvesSortedForManage().length;
  if (state.shelfManageVisibleCount >= total) return;
  if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 24) return;
  state.shelfManageVisibleCount = Math.min(total, state.shelfManageVisibleCount + state.manageModalLoadStep);
  renderShelvesManageTable();
}

function loadMoreBoxesManageIfNeeded() {
  const wrap = $("boxManageTableWrap");
  if (!wrap) return;
  const total = getBoxesSortedForManage().length;
  if (state.boxManageVisibleCount >= total) return;
  if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 24) return;
  state.boxManageVisibleCount = Math.min(total, state.boxManageVisibleCount + state.manageModalLoadStep);
  renderBoxesManageTable();
}

function buildShelfManageSelectOptions(selectedShelfId) {
  const selected = String(selectedShelfId || "");
  const rows = getShelvesSortedForManage();
  return rows
    .map((shelf) => {
      const shelfId = String(shelf.id || "");
      const selectedAttr = shelfId === selected ? " selected" : "";
      const statusSuffix = Number(shelf?.status) === 1 ? "" : "・育ｦ∫畑・・;
      const nameSuffix = shelf?.name ? ` / ${shelf.name}` : "";
      return `<option value="${escapeHtml(shelfId)}"${selectedAttr}>${escapeHtml(
        `${shelf?.shelfCode || "-"}${nameSuffix}${statusSuffix}`,
      )}</option>`;
    })
    .join("");
}

function renderShelvesManageTable() {
  const body = $("shelfManageBody");
  if (!body) return;
  const rows = getShelvesSortedForManage();
  const visibleCount = Math.min(
    rows.length,
    Math.max(state.shelfManageVisibleCount || 0, state.manageModalInitialPageSize),
  );
  state.shelfManageVisibleCount = visibleCount;
  const visibleRows = rows.slice(0, visibleCount);
  body.innerHTML =
    visibleRows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.shelfEditingIds.has(itemId);
        return `
      <tr>
        <td>
          <input
            id="shelfCodeManage-${escapeHtml(item.id)}"
            value="${escapeHtml(item.shelfCode || "")}"
            maxlength="64"
            ${editing ? "" : "readonly"}
            data-original-code="${escapeHtml(item.shelfCode || "")}"
          />
        </td>
        <td>
          <input
            id="shelfNameManage-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name || "")}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name || "")}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editShelfManage" data-id="${escapeHtml(item.id)}">${editing ? "遑ｮ隶､蜿俶峩" : "蜿俶峩"}</button>
          <button class="tiny-btn danger" data-action="deleteShelfManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.shelfCode || "")}">蛻髯､</button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="3" class="muted">-</td></tr>';
  const tableRows = body.querySelectorAll("tr");
  visibleRows.forEach((item, index) => {
    const actionCell = tableRows[index]?.lastElementChild;
    if (!actionCell) return;
    actionCell.insertAdjacentHTML(
      "afterbegin",
      `<button class="tiny-btn secondary" data-action="queryShelfManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.shelfCode || "")}">譟･隸｢</button>`,
    );
  });
}

function renderBoxesManageTable() {
  const body = $("boxManageBody");
  if (!body) return;
  const rows = getBoxesSortedForManage();
  const visibleCount = Math.min(
    rows.length,
    Math.max(state.boxManageVisibleCount || 0, state.manageModalInitialPageSize),
  );
  state.boxManageVisibleCount = visibleCount;
  const visibleRows = rows.slice(0, visibleCount);
  body.innerHTML =
    visibleRows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.boxEditingIds.has(itemId);
        const shelfOptions = buildShelfManageSelectOptions(item?.shelf?.id);
        const archiveReleaseAction = item?.canArchiveRelease
          ? `<button class="tiny-btn secondary" data-action="archiveReleaseBoxManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.boxCode || "")}">蠖呈｡｣驥頑叛</button>`
          : "";
        const deleteAction = item?.canDelete
          ? `<button class="tiny-btn danger" data-action="deleteBoxManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.boxCode || "")}">蛻髯､</button>`
          : "";
        return `
      <tr>
        <td>
          <input
            id="boxCodeManage-${escapeHtml(item.id)}"
            value="${escapeHtml(item.boxCode || "")}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-code="${escapeHtml(item.boxCode || "")}"
          />
        </td>
        <td>
          <select
            id="boxShelfManage-${escapeHtml(item.id)}"
            ${editing ? "" : "disabled"}
            data-original-shelf-id="${escapeHtml(item?.shelf?.id || "")}"
          >
            ${shelfOptions}
          </select>
        </td>
        <td>
          <button class="tiny-btn secondary" data-action="queryBoxManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.boxCode || "")}">譟･隸｢</button>
          ${archiveReleaseAction}
          <button class="tiny-btn" data-action="editBoxManage" data-id="${escapeHtml(item.id)}">${editing ? "遑ｮ隶､蜿俶峩" : "蜿俶峩"}</button>
          ${deleteAction}
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="3" class="muted">-</td></tr>';
}

function renderEmptyBoxManageBadge() {
  const badge = $("emptyBoxManageBadge");
  if (!badge) return;
  const count = Array.isArray(state.emptyBoxes) ? state.emptyBoxes.length : 0;
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count <= 0);
}

function renderEmptyBoxManageTable() {
  const body = $("emptyBoxManageBody");
  if (!body) return;
  const rows = Array.isArray(state.emptyBoxes) ? state.emptyBoxes : [];
  body.innerHTML =
    rows
      .map((item) => {
        const shelfLabel = formatShelfCodeWithName({
          shelfCode: item?.shelfCode,
          name: item?.shelfName,
        });
        return `
      <tr>
        <td>${escapeHtml(displayText(item?.boxCode))}</td>
        <td>${escapeHtml(displayText(shelfLabel))}</td>
        <td>
          <button
            class="tiny-btn danger"
            data-action="deleteEmptyBox"
            data-id="${escapeHtml(item?.id || "")}"
            data-code="${escapeHtml(item?.boxCode || "")}"
          >
            蠎滄勁
          </button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="3" class="muted">-</td></tr>';
}

function canSelectProductEditRequestForBatchConfirm(item) {
  if (!item || String(item?.status || "") !== "pending") {
    return false;
  }
  const permission = resolveProductEditConfirmPermission(item?.changedFields);
  return permission.allowed;
}

function syncSelectedProductEditRequestIds() {
  const selectableIds = new Set(
    state.skuEditRequests
      .filter((item) => canSelectProductEditRequestForBatchConfirm(item))
      .map((item) => String(item.id)),
  );
  state.selectedProductEditRequestIds = new Set(
    [...state.selectedProductEditRequestIds].filter((id) => selectableIds.has(String(id))),
  );
}

function updateProductEditRequestSelectAll() {
  const selectAll = $("productEditSelectAll");
  if (!selectAll) return;
  const visibleRows = state.skuEditRequests.slice(0, state.skuEditRequestsVisibleCount);
  const selectableRows = visibleRows.filter((item) => canSelectProductEditRequestForBatchConfirm(item));

  if (!selectableRows.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = selectableRows.filter((item) =>
    state.selectedProductEditRequestIds.has(String(item.id)),
  ).length;

  selectAll.checked = selectedCount > 0 && selectedCount === selectableRows.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < selectableRows.length;
}

function renderProductEditRequestTable() {
  const body = $("productEditRequestBody");
  if (!body) return;
  const rows = state.skuEditRequests.slice(0, state.skuEditRequestsVisibleCount);

  body.innerHTML =
    rows
      .map((item) => {
        const requestId = String(item?.id || "");
        const skuText = item?.sku?.sku || "-";
        const statusText = getProductEditRequestStatusText(item?.status);
        const creatorText = item?.creator?.username || "-";
        const canDelete = item?.status === "pending";
        const canBatchConfirm = canSelectProductEditRequestForBatchConfirm(item);
        const checkedAttr = canBatchConfirm && state.selectedProductEditRequestIds.has(requestId) ? " checked" : "";
        return `
      <tr>
        <td><input type="checkbox" data-action="toggleProductEditRequestSelect" data-id="${escapeHtml(requestId)}"${
          canBatchConfirm ? "" : " disabled"
        }${checkedAttr} /></td>
        <td>${escapeHtml(formatDate(item?.createdAt))}</td>
        <td>${escapeHtml(displayText(skuText))}</td>
        <td><span class="edit-request-status">${escapeHtml(statusText)}</span></td>
        <td>${escapeHtml(displayText(creatorText))}</td>
        <td>
          <button class="tiny-btn" data-action="openProductEditRequestDetail" data-id="${escapeHtml(item?.id)}">郛冶ｾ題ｯｦ諠・/button>
          ${
            canDelete
              ? `<button class="tiny-btn danger" data-action="deleteProductEditRequestRow" data-id="${escapeHtml(item?.id)}">蛻髯､</button>`
              : ""
          }
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="6" class="muted">-</td></tr>';
  updateProductEditRequestSelectAll();
}

function loadMoreProductEditRequestsIfNeeded() {
  const panel = $("productManagement");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.skuEditRequestsVisibleCount >= state.skuEditRequests.length) return;
  state.skuEditRequestsVisibleCount += state.inventoryPageSize;
  renderProductEditRequestTable();
}

function renderProductEditRequestDetail(item) {
  const meta = $("productEditRequestMeta");
  const compare = $("productEditRequestCompare");
  const confirmBtn = $("confirmProductEditRequestBtn");
  if (!meta || !compare || !confirmBtn) return;

  if (!item) {
    state.selectedProductEditRequestId = null;
    state.selectedProductEditRequestChangedFields = [];
    meta.innerHTML = "";
    compare.innerHTML = '<div class="muted">證よ裏謨ｰ謐ｮ</div>';
    confirmBtn.classList.add("hidden");
    return;
  }

  state.selectedProductEditRequestId = Number(item.id);
  state.selectedProductEditRequestChangedFields = normalizeProductEditChangedFields(item?.changedFields);
  meta.innerHTML = `
    <div><strong>SKU・・/strong>${escapeHtml(displayText(item?.sku?.sku))}</div>
    <div><strong>逕ｳ隸ｷ莠ｺ・・/strong>${escapeHtml(displayText(item?.creator?.username))}</div>
    <div><strong>逕ｳ隸ｷ譌ｶ髣ｴ・・/strong>${escapeHtml(formatDate(item?.createdAt))}</div>
    <div><strong>迥ｶ諤・ｼ・/strong>${escapeHtml(getProductEditRequestStatusText(item?.status))}</div>
  `;

  const fieldDefs = [
    ["model", "蝙句捷"],
    ["brand", "蜩∫煙"],
    ["type", "邀ｻ蝙・],
    ["color", "鬚懆牡"],
    ["shop", "謇螻樔ｺ夐ｩｬ騾雁ｺ鈴銅"],
    ["remark", "螟・ｳｨ"],
    ["sku", "SKU"],
    ["asin", "ASIN"],
    ["fnsku", "FNSKU"],
    ["fbmSku", "FBMSKU"],
    ["rbSku", "rbSKU"],
  ];
  const changedSet = new Set(Array.isArray(item?.changedFields) ? item.changedFields : []);
  const beforeData = item?.beforeData || {};
  const afterData = item?.afterData || {};

  const renderCol = (title, data, side) => `
    <div class="edit-request-compare-col">
      <h4>${escapeHtml(title)}</h4>
      <div class="edit-request-field-list">
        ${fieldDefs
          .map(([fieldKey, label]) => {
            const changed = changedSet.has(fieldKey);
            const value = displayText(data?.[fieldKey]);
            const changedClass = changed ? " changed" : "";
            return `
              <div class="edit-request-field">
                <span class="edit-request-field-name">${escapeHtml(label)}・・/span>
                <span class="edit-request-field-value${changedClass}" data-side="${escapeHtml(side)}">${escapeHtml(value)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;

  compare.innerHTML = `${renderCol("蜿俶峩蜑・, beforeData, "before")}${renderCol("蜿俶峩蜷・, afterData, "after")}`;
  const canShowConfirmButton = item?.status === "pending";
  confirmBtn.classList.toggle("hidden", !canShowConfirmButton);
}

function renderBoxOptionsForInput(inputId, listId, placeholder, keyword = "") {
  const input = $(inputId);
  const datalist = $(listId);
  if (!input || !datalist) return;

  const prev = input.value;
  input.placeholder = placeholder;
  const matches = filterAdjustBoxes(keyword);
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");

  if (prev) {
    input.value = prev;
  }
}

function getEnabledBoxesSorted() {
  return state.boxes
    .filter((box) => Number(box.status) === 1)
    .sort((a, b) => String(a.boxCode).localeCompare(String(b.boxCode), "en", { numeric: true }));
}

function normalizeBoxCodeInput(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "";
  if (/^\d{1,6}$/.test(value)) {
    return value.padStart(Math.max(3, value.length), "0");
  }
  return value;
}

function resolveEnabledBoxCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return "";
  const found = getEnabledBoxesSorted().find((box) => normalizeBoxCodeInput(box?.boxCode) === normalized);
  return found?.boxCode || "";
}

function findEnabledBoxByCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return null;
  return (
    getEnabledBoxesSorted().find((box) => normalizeBoxCodeInput(box?.boxCode) === normalized) || null
  );
}

function upsertEnabledBox(box) {
  if (!box || !box.id) return;
  const next = Array.isArray(state.boxes) ? [...state.boxes] : [];
  const index = next.findIndex((item) => String(item?.id) === String(box.id));
  if (index >= 0) {
    next[index] = { ...next[index], ...box };
  } else {
    next.push(box);
  }
  state.boxes = next;
}

async function resolveEnabledBoxCodeLive(raw) {
  const local = resolveEnabledBoxCode(raw);
  if (local) return local;

  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return "";

  try {
    const boxes = await request(`/boxes?q=${encodeURIComponent(normalized)}`);
    const matched = (Array.isArray(boxes) ? boxes : []).find(
      (box) => normalizeBoxCodeInput(box?.boxCode) === normalized && Number(box?.status) === 1,
    );
    if (!matched?.boxCode) return "";
    upsertEnabledBox(matched);
    return matched.boxCode;
  } catch {
    return "";
  }
}

function getEnabledShelvesSorted() {
  return state.shelves
    .filter((shelf) => Number(shelf.status) === 1)
    .sort((a, b) => String(a.shelfCode).localeCompare(String(b.shelfCode), "en", { numeric: true }));
}

function formatShelfCodeWithName(shelf) {
  const rawCode = shelf && typeof shelf === "object" ? shelf?.shelfCode : shelf;
  const shelfCode = normalizeShelfCodeInput(rawCode);
  if (!shelfCode) return "";

  let shelfName = "";
  if (shelf && typeof shelf === "object") {
    shelfName = String(shelf?.name || "").trim();
  }
  if (!shelfName) {
    const matched = (Array.isArray(state.shelves) ? state.shelves : []).find(
      (item) => normalizeShelfCodeInput(item?.shelfCode) === shelfCode,
    );
    shelfName = String(matched?.name || "").trim();
  }

  return shelfName ? `${shelfCode}-${shelfName}` : shelfCode;
}

function normalizeShelfCodeInput(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "";
  const labeled = value.match(/^((?:00)|(?:[A-Z][0-9]))\s*[-_/].*$/);
  if (labeled) {
    return labeled[1];
  }
  if (/^(?:00|[A-Z][0-9])$/.test(value)) {
    return value;
  }
  return value;
}

function resolveEnabledShelfCode(raw, excludeShelfId = null) {
  const normalized = normalizeShelfCodeInput(raw);
  if (!normalized) return "";
  const found = getEnabledShelvesSorted().find((shelf) => {
    if (excludeShelfId && String(shelf.id) === String(excludeShelfId)) return false;
    return normalizeShelfCodeInput(shelf?.shelfCode) === normalized;
  });
  return found?.shelfCode || "";
}

function renderMoveShelfBoxOptions(keyword = "") {
  const input = $("moveShelfBoxCode");
  const datalist = $("moveShelfBoxCodeList");
  if (!input || !datalist) return;

  const prev = input.value;
  const raw = String(keyword ?? "").trim().toUpperCase();
  const digits = raw.replace(/\D/g, "");
  const matches = getEnabledBoxesSorted().filter((box) => {
    if (!raw) return true;
    if (digits) return String(box.boxCode).replace(/\D/g, "").includes(digits);
    return String(box.boxCode).toUpperCase().includes(raw);
  });
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");
  if (prev) input.value = prev;
}

function renderMoveShelfTargetOptions(keyword = "") {
  const input = $("moveShelfTargetCode");
  const datalist = $("moveShelfTargetCodeList");
  const currentBox = findEnabledBoxByCode($("moveShelfBoxCode")?.value || "");
  if (!input || !datalist) return;

  const prev = input.value;
  const raw = String(keyword ?? "").trim().toUpperCase();
  const digits = raw.replace(/\D/g, "");
  const matches = getEnabledShelvesSorted().filter((shelf) => {
    if (currentBox && String(shelf.id) === String(currentBox.shelf?.id)) return false;
    if (!raw) return true;
    const shelfCode = String(shelf.shelfCode || "");
    const shelfName = String(shelf.name || "");
    const shelfLabel = formatShelfCodeWithName(shelf);
    if (digits) return shelfCode.replace(/\D/g, "").includes(digits);
    return (
      shelfCode.toUpperCase().includes(raw) ||
      shelfName.toUpperCase().includes(raw) ||
      shelfLabel.toUpperCase().includes(raw)
    );
  });
  datalist.innerHTML = matches
    .map((shelf) => `<option value="${escapeHtml(formatShelfCodeWithName(shelf))}"></option>`)
    .join("");
  if (prev) input.value = prev;
}

function syncMoveShelfCurrentDisplay() {
  const currentInput = $("moveShelfCurrentCode");
  if (!currentInput) return;
  const box = findEnabledBoxByCode($("moveShelfBoxCode")?.value || "");
  currentInput.value = formatShelfCodeWithName(box?.shelf);
}

function renderMoveProductNewBoxOptions(keyword = "") {
  const input = $("moveProductNewBoxCode");
  const datalist = $("moveProductNewBoxCodeList");
  if (!input || !datalist) return;

  const prev = input.value;
  const raw = String(keyword ?? "").trim().toUpperCase();
  const digits = raw.replace(/\D/g, "");
  const matches = getEnabledBoxesSorted().filter((box) => {
    if (!raw) return true;
    if (digits) return String(box.boxCode).replace(/\D/g, "").includes(digits);
    return String(box.boxCode).toUpperCase().includes(raw);
  });
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");
  if (prev) input.value = prev;
}

function syncMoveProductOldShelfDisplay() {
  const shelfInput = $("moveProductOldShelfCode");
  if (!shelfInput) return;
  const selectedBoxCode = resolveEnabledBoxCode($("moveProductOldBoxCode")?.value || "");
  const box = findEnabledBoxByCode(selectedBoxCode);
  shelfInput.value = formatShelfCodeWithName(box?.shelf);
}

function syncMoveProductNewShelfDisplay() {
  const shelfInput = $("moveProductNewShelfCode");
  if (!shelfInput) return;
  const newBoxCode = resolveEnabledBoxCode($("moveProductNewBoxCode")?.value || "");
  const box = findEnabledBoxByCode(newBoxCode);
  shelfInput.value = formatShelfCodeWithName(box?.shelf);
}

async function refreshMoveProductOldBoxOptionsBySku() {
  const skuId = resolveMoveProductSkuId();
  const select = $("moveProductOldBoxCode");
  const hint = $("moveProductOldBoxHint");
  if (!select) return;

  if (!Number.isInteger(skuId) || skuId <= 0) {
    select.innerHTML = '<option value="">隸ｷ蜈磯画叫SKU</option>';
    if (hint) hint.classList.add("hidden");
    syncMoveProductOldShelfDisplay();
    return;
  }

  const rows = (await getSkuInventoryRows(skuId))
    .filter((row) => Number(row?.qty ?? 0) > 0 && row?.box?.boxCode)
    .sort((a, b) => String(a.box.boxCode).localeCompare(String(b.box.boxCode), "en", { numeric: true }));
  const hasMultiple = rows.length > 1;

  const prev = resolveEnabledBoxCode(select.value);
  const options = rows
    .map((row) => `<option value="${escapeHtml(row.box.boxCode)}">${escapeHtml(row.box.boxCode)}</option>`)
    .join("");
  if (rows.length === 1) {
    select.innerHTML = options;
  } else {
    select.innerHTML = `<option value="">隸ｷ騾画叫譌ｧ邂ｱ蜿ｷ</option>${options}`;
  }
  if (hint) {
    hint.classList.toggle("hidden", !hasMultiple);
  }

  if (rows.length === 1) {
    select.value = rows[0].box.boxCode;
  } else if (prev && rows.some((row) => String(row.box.boxCode) === String(prev))) {
    select.value = prev;
  } else {
    select.value = "";
  }

  syncMoveProductOldShelfDisplay();
}

function filterAdjustBoxes(keyword) {
  const boxes = getEnabledBoxesSorted();
  const raw = String(keyword ?? "").trim().toUpperCase();
  if (!raw) return boxes;

  const digits = raw.replace(/\D/g, "");
  if (digits) {
    return boxes.filter((box) => String(box.boxCode).replace(/\D/g, "").includes(digits));
  }

  return boxes.filter((box) => String(box.boxCode).toUpperCase().includes(raw));
}

async function loadProductEditRequests() {
  const rows = await request("/sku-edit-requests");
  state.skuEditRequests = Array.isArray(rows) ? rows : [];
  state.skuEditRequestsVisibleCount = state.inventoryPageSize;
  syncSelectedProductEditRequestIds();
  renderProductEditRequestTable();
}

function hasPendingProductEditRequestBySkuId(skuId) {
  const targetSkuId = Number(skuId);
  if (!Number.isInteger(targetSkuId) || targetSkuId <= 0) {
    return false;
  }
  return state.skuEditRequests.some((item) => {
    const status = String(item?.status || "");
    const itemSkuId = Number(item?.skuId ?? item?.sku?.id ?? 0);
    return status === "pending" && Number.isInteger(itemSkuId) && itemSkuId === targetSkuId;
  });
}

async function loadProductEditRequestDetail(id) {
  return request(`/sku-edit-requests/${id}`);
}

async function confirmProductEditRequest(id) {
  return request(`/sku-edit-requests/${id}/confirm`, {
    method: "POST",
  });
}

async function deleteProductEditRequest(id) {
  return request(`/sku-edit-requests/${id}/delete`, {
    method: "POST",
  });
}

function renderAdjustBoxSuggestions(keyword = "") {
  const datalist = $("adjustBoxCodeList");
  if (!datalist) return;

  const matches = filterAdjustBoxes(keyword);
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");

  const hint = $("adjustBoxHint");
  if (!hint) return;

  const raw = String(keyword ?? "").trim();
  if (!raw) {
    hint.classList.add("hidden");
    return;
  }

  hint.classList.toggle("hidden", matches.length > 0);
}

async function validateAdjustBoxInput(raw, { normalizeInput = false } = {}) {
  const input = $("adjustBoxCode");
  const hint = $("adjustBoxHint");
  if (!input) return "";
  if (input.readOnly) return normalizeBoxCodeInput(input.value);

  const token = ++adjustBoxValidationToken;
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) {
    if (hint) hint.classList.add("hidden");
    return "";
  }

  const resolved = await resolveEnabledBoxCodeLive(normalized);
  if (token !== adjustBoxValidationToken) return "";

  if (resolved) {
    renderAdjustBoxSuggestions(resolved);
    if (normalizeInput) {
      input.value = resolved;
    }
    if (hint) hint.classList.add("hidden");
    return resolved;
  }

  renderAdjustBoxSuggestions(normalized);
  if (normalizeInput) {
    input.value = normalized;
  }
  if (hint) hint.classList.remove("hidden");
  return "";
}

async function loadBrands() {
  const brands = await request("/brands");
  state.brands = brands;
  const latestIds = new Set((Array.isArray(brands) ? brands : []).map((item) => String(item.id)));
  state.brandEditingIds = new Set(
    [...state.brandEditingIds].filter((id) => latestIds.has(String(id))),
  );
  renderBrandOptionsForSelect("modalNewBrand", "隸ｷ騾画叫蜩∫煙");
  renderBrandOptionsForSelect("editBrand", "隸ｷ騾画叫蜩∫煙");
  renderBrandsTable();
}

async function loadSkuTypes() {
  const skuTypes = await request("/sku-types");
  state.skuTypes = skuTypes;
  const latestIds = new Set((Array.isArray(skuTypes) ? skuTypes : []).map((item) => String(item.id)));
  state.skuTypeEditingIds = new Set(
    [...state.skuTypeEditingIds].filter((id) => latestIds.has(String(id))),
  );
  renderSkuTypeOptionsForSelect("modalNewType", "隸ｷ騾画叫邀ｻ蝙・);
  renderSkuTypeOptionsForSelect("editType", "隸ｷ騾画叫邀ｻ蝙・);
  renderSkuTypesTable();
}

async function loadShops() {
  const shops = await request("/shops");
  state.shops = shops;
  const latestIds = new Set((Array.isArray(shops) ? shops : []).map((item) => String(item.id)));
  state.shopEditingIds = new Set(
    [...state.shopEditingIds].filter((id) => latestIds.has(String(id))),
  );
  renderShopOptionsForSelect("modalNewShop", "隸ｷ騾画叫蠎鈴銅");
  renderShopOptionsForSelect("editShop", "隸ｷ騾画叫蠎鈴銅");
  renderShopsTable();
}

async function loadShelves() {
  const shelves = await request("/shelves");
  state.shelves = shelves;
  const latestIds = new Set((Array.isArray(shelves) ? shelves : []).map((item) => String(item.id)));
  state.shelfEditingIds = new Set(
    [...state.shelfEditingIds].filter((id) => latestIds.has(String(id))),
  );
  $("statShelves").textContent = shelves.length;

  renderShelfOptionsForSelect("newBoxShelfId", "隸ｷ騾画叫雍ｧ譫ｶ蜿ｷ");
  renderShelfOptionsForSelect("modalNewBoxShelfId", "隸ｷ騾画叫雍ｧ譫ｶ蜿ｷ");
  renderShelfOptionsForSelect("boxManageShelfId", "隸ｷ騾画叫雍ｧ譫ｶ蜿ｷ");
  renderMoveShelfTargetOptions($("moveShelfTargetCode")?.value || "");
  syncMoveShelfCurrentDisplay();
  syncMoveProductOldShelfDisplay();
  syncMoveProductNewShelfDisplay();
  renderShelvesManageTable();
  renderBoxesManageTable();

  $("shelvesBody").innerHTML = shelves
    .map(
      (shelf) => `
      <tr>
        <td>${escapeHtml(shelf.shelfCode)}</td>
        <td>${escapeHtml(shelf.name)}</td>
        <td>${getStatusText(shelf.status)}</td>
      </tr>
    `,
    )
    .join("");
}

async function loadBoxes() {
  const boxes = await request("/boxes");
  state.boxes = boxes;
  const latestIds = new Set((Array.isArray(boxes) ? boxes : []).map((item) => String(item.id)));
  state.boxEditingIds = new Set(
    [...state.boxEditingIds].filter((id) => latestIds.has(String(id))),
  );
  $("statBoxes").textContent = boxes.length;
  renderBoxOptionsForInput("modalNewSkuBoxCode", "modalNewSkuBoxCodeList", "隸ｷ騾画叫蟾ｲ譛臥ｮｱ蜿ｷ謌冶・眠蠅樒ｮｱ蜿ｷ");
  renderAdjustBoxSuggestions($("adjustBoxCode")?.value || "");
  renderMoveShelfBoxOptions($("moveShelfBoxCode")?.value || "");
  syncMoveShelfCurrentDisplay();
  renderMoveShelfTargetOptions($("moveShelfTargetCode")?.value || "");
  renderMoveProductNewBoxOptions($("moveProductNewBoxCode")?.value || "");
  syncMoveProductOldShelfDisplay();
  syncMoveProductNewShelfDisplay();
  renderBoxesManageTable();
  $("boxesBody").innerHTML = boxes
    .map(
      (box) => `
      <tr>
        <td>${escapeHtml(box.boxCode)}</td>
        <td>${escapeHtml(box.shelf?.shelfCode)}</td>
        <td>${getStatusText(box.status)}</td>
      </tr>
    `,
    )
    .join("");
}

async function loadEmptyBoxes() {
  const rows = await request("/boxes/empty");
  state.emptyBoxes = Array.isArray(rows) ? rows : [];
  renderEmptyBoxManageBadge();
  renderEmptyBoxManageTable();
}

function getBatchInboundStatusText(status, order = null) {
  if (status === "waiting_upload") {
    if (order?.domesticOrderNo && !order?.seaOrderNo) {
      return "蠕・書豬ｷ霑・;
    }
    if (order?.uploadedFileName && !order?.domesticOrderNo) {
      return "蠕・｡ｫ蝗ｽ蜀・黒蜿ｷ";
    }
    return "遲牙ｾ・ｸ贋ｼ謇ｹ驥丞・蠎捺枚譯｣";
  }
  if (status === "waiting_inbound") return "蠕・・蠎・;
  if (status === "confirmed") return "蟾ｲ遑ｮ隶､";
  if (status === "void") return "蟾ｲ菴懷ｺ・;
  return status || "-";
}

function getSeaOrderTrackUrl(seaOrderNo) {
  return `http://jp.uofexp.com/search_order.aspx?trackNumber=${encodeURIComponent(seaOrderNo)}`;
}

function formatBatchRange(order) {
  if (!order?.rangeStart || !order?.rangeEnd || !order?.expectedBoxCount) {
    return "-";
  }
  return `${order.rangeStart} ~ ${order.rangeEnd}・・{order.expectedBoxCount}邂ｱ・荏;
}

function renderBatchInboundUploadOptions() {
  const select = $("batchUploadOrderId");
  if (!select) return;
  const prev = select.value || state.selectedBatchInboundOrderId || "";
  const waitingUploadOrders = state.batchInboundOrders.filter(
    (order) =>
      order.status === "waiting_upload" &&
      !order.uploadedFileName &&
      !order.domesticOrderNo &&
      !order.seaOrderNo,
  );
  const options = waitingUploadOrders
    .map(
      (order) =>
        `<option value="${escapeHtml(order.id)}">${escapeHtml(order.orderNo)}</option>`,
    )
    .join("");
  select.innerHTML = `<option value="">隸ｷ騾画叫蜈･蠎灘黒</option>${options}`;
  if (waitingUploadOrders.some((order) => String(order.id) === String(prev))) {
    select.value = prev;
  }
}

function renderBatchInboundOrders() {
  const tbody = $("batchInboundBody");
  if (!tbody) return;
  const orders = state.batchInboundOrders.slice(0, state.batchInboundVisibleCount);
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">-</td></tr>';
    return;
  }

  tbody.innerHTML = orders
    .map((order) => {
      const actions = [
        `<button class="tiny-btn ghost" data-action="batchInboundSelectOrder" data-order-id="${escapeHtml(
          order.id,
        )}">譟･逵・/button>`,
      ];
      if (order.status === "waiting_inbound") {
        actions.push(
          `<button class="tiny-btn" data-action="batchInboundOpenConfirm" data-order-id="${escapeHtml(
            order.id,
          )}">遑ｮ隶､蜈･蠎・/button>`,
        );
      }
      if (order.status !== "confirmed" && !order.seaOrderNo) {
        actions.push(
          `<button class="tiny-btn danger" data-action="batchInboundDeleteOrder" data-order-id="${escapeHtml(
            order.id,
          )}" data-order-no="${escapeHtml(order.orderNo)}">蛻髯､</button>`,
        );
      }
      return `
        <tr>
          <td>${escapeHtml(order.orderNo)}</td>
          <td>${escapeHtml(getBatchInboundStatusText(order.status, order))}</td>
          <td>${escapeHtml(formatBatchRange(order))}</td>
          <td>
            <div class="batch-no-editor">
              <input
                id="domesticOrderNo-${escapeHtml(order.id)}"
                class="batch-no-input"
                value="${escapeHtml(order.domesticOrderNo || "")}"
                placeholder="隸ｷ霎灘・蝗ｽ蜀・黒蜿ｷ"
              />
              <button
                class="tiny-btn"
                data-action="batchInboundSaveDomesticOrderNo"
                data-order-id="${escapeHtml(order.id)}"
                data-input-id="domesticOrderNo-${escapeHtml(order.id)}"
              >菫晏ｭ・/button>
            </div>
          </td>
          <td>
            <div class="batch-no-editor">
              <input
                id="seaOrderNo-${escapeHtml(order.id)}"
                class="batch-no-input"
                value="${escapeHtml(order.seaOrderNo || "")}"
                placeholder="隸ｷ霎灘・豬ｷ霑仙黒蜿ｷ"
              />
              <button
                class="tiny-btn"
                data-action="batchInboundSaveSeaOrderNo"
                data-order-id="${escapeHtml(order.id)}"
                data-input-id="seaOrderNo-${escapeHtml(order.id)}"
              >菫晏ｭ・/button>
            </div>
            ${
              order.seaOrderNo
                ? `<a class="batch-sea-link" href="${escapeHtml(
                    getSeaOrderTrackUrl(order.seaOrderNo),
                  )}" target="_blank" rel="noopener noreferrer">${escapeHtml(order.seaOrderNo)}</a>`
                : ""
            }
          </td>
          <td>${escapeHtml(order.confirmedCount ?? 0)} / ${escapeHtml(order.itemCount ?? 0)}</td>
          <td><div class="action-row">${actions.join("")}</div></td>
        </tr>
      `;
    })
    .join("");
}

function loadMoreBatchInboundOrdersIfNeeded() {
  const panel = $("batchInbound");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.batchInboundVisibleCount >= state.batchInboundOrders.length) return;
  state.batchInboundVisibleCount += state.inventoryPageSize;
  renderBatchInboundOrders();
}

function renderBatchInboundDetail(detail) {
  const container = $("batchInboundDetail");
  if (!container) return;
  if (!detail) {
    container.className = "batch-detail-empty muted";
    container.textContent = "隸ｷ蜈磯画叫謇ｹ驥丞・蠎灘黒縲・;
    return;
  }

  const grouped = new Map();
  (detail.items || []).forEach((item) => {
    const key = item.boxCode;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });

  const boxCodes = Array.from(grouped.keys()).sort((a, b) => {
    const numA = Number(String(a).replace(/\D/g, ""));
    const numB = Number(String(b).replace(/\D/g, ""));
    return numA - numB;
  });

  const canConfirm = detail.status === "waiting_inbound";
  const headerActions = canConfirm
    ? `<button class="tiny-btn" data-action="batchInboundConfirmAll" data-order-id="${escapeHtml(
        detail.id,
      )}">謨ｴ蜊慕｡ｮ隶､蜈･蠎・/button>`
    : "";

  const boxBlocks = boxCodes
    .map((boxCode) => {
      const items = grouped.get(boxCode) || [];
      const pendingCount = items.filter((item) => item.status === "pending").length;
      const boxAction =
        canConfirm && pendingCount > 0
          ? `<button class="tiny-btn" data-action="batchInboundConfirmBox" data-order-id="${escapeHtml(
              detail.id,
            )}" data-box-code="${escapeHtml(boxCode)}">遑ｮ隶､謨ｴ邂ｱ</button>`
          : `<span class="tag">${pendingCount > 0 ? "蠕・｡ｮ隶､" : "蟾ｲ遑ｮ隶､"}</span>`;

      return `
        <article class="batch-box-card">
          <div class="batch-box-head">
            <h4 class="batch-box-title">邂ｱ蜿ｷ ${escapeHtml(boxCode)}</h4>
            <div class="batch-detail-actions">${boxAction}</div>
          </div>
          <table class="batch-detail-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>謨ｰ驥・/th>
                <th>迥ｶ諤・/th>
                <th>謫堺ｽ・/th>
              </tr>
            </thead>
            <tbody>
              ${items
                .map((item) => {
                  const itemAction =
                    canConfirm && item.status === "pending"
                      ? `<button class="tiny-btn" data-action="batchInboundConfirmItem" data-order-id="${escapeHtml(
                          detail.id,
                        )}" data-item-id="${escapeHtml(item.id)}">遑ｮ隶､SKU</button>`
                      : '<span class="muted">-</span>';
                  return `
                    <tr>
                      <td>${escapeHtml(item.skuCode)}</td>
                      <td>${escapeHtml(item.qty)}</td>
                      <td>${escapeHtml(item.status === "pending" ? "蠕・｡ｮ隶､" : "蟾ｲ遑ｮ隶､")}</td>
                      <td>${itemAction}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </article>
      `;
    })
    .join("");

  container.className = "";
  container.innerHTML = `
    <div class="batch-detail-head">
      <div class="batch-detail-meta">
        <div>蜊募捷・・{escapeHtml(detail.orderNo)}</div>
        <div>迥ｶ諤・ｼ・{escapeHtml(getBatchInboundStatusText(detail.status, detail))}</div>
        <div>驥・寔闌・峩・・{escapeHtml(formatBatchRange(detail))}</div>
        <div>譏守ｻ・ｿ帛ｺｦ・・{escapeHtml(detail.confirmedCount ?? 0)} / ${escapeHtml(
          detail.itemCount ?? 0,
        )}</div>
      </div>
      <div class="batch-detail-actions">${headerActions}</div>
    </div>
    ${boxBlocks || '<div class="muted">證よ裏譏守ｻ・/div>'}
  `;
}

async function loadBatchInboundOrders({ keepSelection = true } = {}) {
  const orders = await request("/batch-inbound/orders");
  state.batchInboundOrders = Array.isArray(orders) ? orders : [];
  state.batchInboundVisibleCount = state.inventoryPageSize;
  $("statInboundDraft").textContent = state.batchInboundOrders.filter(
    (order) => order.status === "waiting_upload" || order.status === "waiting_inbound",
  ).length;
  renderBatchInboundOrders();
  renderBatchInboundUploadOptions();

  if (!keepSelection) {
    state.selectedBatchInboundOrderId = "";
    state.selectedBatchInboundOrderDetail = null;
    renderBatchInboundDetail(null);
    return;
  }

  if (!state.selectedBatchInboundOrderId) {
    renderBatchInboundDetail(null);
    return;
  }

  const exists = state.batchInboundOrders.some(
    (order) => String(order.id) === String(state.selectedBatchInboundOrderId),
  );
  if (!exists) {
    state.selectedBatchInboundOrderId = "";
    state.selectedBatchInboundOrderDetail = null;
    renderBatchInboundDetail(null);
    return;
  }

  await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
}

async function loadBatchInboundOrderDetail(orderId, { silent = false } = {}) {
  const detail = await request(`/batch-inbound/orders/${orderId}`);
  state.selectedBatchInboundOrderId = String(orderId);
  state.selectedBatchInboundOrderDetail = detail;
  renderBatchInboundDetail(detail);
  if (!silent) {
    $("batchUploadOrderId").value = String(orderId);
  }
}

async function submitCollectBatchInboundForm() {
  const batchNoRaw = String($("batchCollectBatchNo").value || "").trim();
  const boxCount = Number($("batchCollectBoxCount").value);
  if (!batchNoRaw) {
    throw new Error("謇ｹ蜿ｷ荳崎・荳ｺ遨ｺ");
  }
  if (!/^[1-9]\d*$/.test(batchNoRaw)) {
    throw new Error("謇ｹ蜿ｷ蜿ｪ閭ｽ霎灘・螟ｧ莠・逧・焚蟄・);
  }
  if (!Number.isInteger(boxCount) || boxCount <= 0) {
    throw new Error("驥・寔邂ｱ謨ｰ蠢・｡ｻ譏ｯ螟ｧ莠・逧・紛謨ｰ");
  }

  const created = await request("/batch-inbound/orders/collect", {
    method: "POST",
    body: JSON.stringify({
      batchNo: batchNoRaw,
      boxCount,
    }),
  });

  const hint = $("batchCollectHint");
  if (hint && created) {
    hint.textContent = `隸ｷ菴ｿ逕ｨ莉取焚蟄・${created.rangeStart} ~ ${created.rangeEnd} 逧・${created.expectedBoxCount} 荳ｪ邂ｱ蜿ｷ縲Ａ;
  }
  state.selectedBatchInboundOrderId = String(created.id);
}

async function submitUploadBatchInboundForm() {
  const orderId = $("batchUploadOrderId").value;
  const file = $("batchInboundFile").files?.[0];
  if (!orderId) {
    throw new Error("隸ｷ蜈磯画叫謇ｹ驥丞・蠎灘黒");
  }
  if (!file) {
    throw new Error("隸ｷ荳贋ｼ謇ｹ驥丞・蠎捺枚譯｣");
  }

  const formData = new FormData();
  formData.append("file", file);
  await request(`/batch-inbound/orders/${orderId}/upload`, {
    method: "POST",
    body: formData,
  });

  $("batchInboundFile").value = "";
  state.selectedBatchInboundOrderId = String(orderId);
}

async function saveBatchInboundDomesticOrderNo(orderId, domesticOrderNo) {
  return request(`/batch-inbound/orders/${orderId}/domestic-order-no`, {
    method: "POST",
    body: JSON.stringify({ domesticOrderNo }),
  });
}

async function saveBatchInboundSeaOrderNo(orderId, seaOrderNo) {
  return request(`/batch-inbound/orders/${orderId}/sea-order-no`, {
    method: "POST",
    body: JSON.stringify({ seaOrderNo }),
  });
}

async function confirmBatchInboundAction(action, orderId, payload = {}) {
  if (!orderId) {
    throw new Error("郛ｺ蟆第音驥丞・蠎灘黒ID");
  }
  let path = `/batch-inbound/orders/${orderId}/confirm-all`;
  if (action === "item") {
    path = `/batch-inbound/orders/${orderId}/items/${payload.itemId}/confirm`;
  } else if (action === "box") {
    path = `/batch-inbound/orders/${orderId}/boxes/${encodeURIComponent(payload.boxCode)}/confirm`;
  }
  await request(path, {
    method: "POST",
    body: "{}",
  });
}

async function deleteBatchInboundOrder(orderId) {
  await request(`/batch-inbound/orders/${orderId}`, {
    method: "DELETE",
  });
}

function toAuditRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

async function refreshAuditFbaRequestNoMap() {
  const map = {};
  const sourceRows = Array.isArray(state.fbaReplenishments) && state.fbaReplenishments.length
    ? state.fbaReplenishments
    : await request("/inventory/fba-replenishments");

  (Array.isArray(sourceRows) ? sourceRows : []).forEach((item) => {
    const id = String(item?.id || "").trim();
    const requestNo = String(item?.requestNo || "").trim();
    if (id && requestNo) {
      map[id] = requestNo;
    }
  });

  state.auditFbaRequestNoById = map;
}

function pickAuditEntityName(item, entityType) {
  const after = toAuditRecord(item?.afterData);
  const before = toAuditRecord(item?.beforeData);
  const pick = (...keys) => {
    for (const key of keys) {
      const afterValue = String(after?.[key] ?? "").trim();
      if (afterValue) return afterValue;
      const beforeValue = String(before?.[key] ?? "").trim();
      if (beforeValue) return beforeValue;
    }
    return "";
  };

  if (entityType === "sku") return pick("sku", "model");
  if (entityType === "box") return pick("boxCode", "box_code");
  if (entityType === "shelf") return pick("shelfCode", "shelf_code", "name");
  if (entityType === "user") return pick("username");
  if (entityType === "brand") return pick("name", "brand");
  if (entityType === "sku_type") return pick("name", "type");
  if (entityType === "shop") return pick("name", "shop");
  if (entityType === "inbound_order" || entityType === "outbound_order") return pick("orderNo", "order_no");
  if (entityType === "stocktake_task") return pick("taskNo", "task_no");
  if (entityType === "inventory_adjust_order") return pick("adjustNo", "adjust_no");
  if (entityType === "fba_replenishment") {
    const requestNo = pick("requestNo", "request_no");
    if (requestNo) return requestNo;
    const id = String(item?.entityId ?? "").trim();
    return String(state.auditFbaRequestNoById?.[id] || "").trim();
  }
  if (entityType === "product_edit_request") return pick("sku", "skuCode", "requestNo");

  return pick("name", "code", "no", "sku");
}

function formatAuditEntity(item) {
  const entityType = String(item?.entityType || "").trim();
  const entityText = AUDIT_ENTITY_TEXT_MAP[entityType] || entityType || "螳樔ｽ・;
  const entityName = pickAuditEntityName(item, entityType);
  if (!entityName) {
    return entityText;
  }
  return `${entityText}・・{entityName}`;
}

function getAuditEventText(eventType) {
  const code = String(eventType || "").trim();
  if (!code) return "-";
  return AUDIT_EVENT_TEXT_MAP[code] || code;
}

function renderAuditTable() {
  const body = $("auditBody");
  if (!body) return;
  const items = state.auditLogs.slice(0, state.auditVisibleCount);
  body.innerHTML =
    items
      .map(
        (item) => `
      <tr>
        <td>${formatDate(item.createdAt)}</td>
        <td>${escapeHtml(formatAuditEntity(item))}</td>
        <td>${escapeHtml(getAuditEventText(item.eventType))}</td>
        <td>${escapeHtml(item.operator?.username)}</td>
      </tr>
    `,
      )
      .join("") || '<tr><td colspan="4" class="muted">-</td></tr>';
}

function loadMoreAuditIfNeeded() {
  const panel = $("audit");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.auditVisibleCount >= state.auditLogs.length) return;
  state.auditVisibleCount += state.inventoryPageSize;
  renderAuditTable();
}

async function loadAudit() {
  await refreshAuditFbaRequestNoMap();
  const result = await request("/audit-logs?page=1&pageSize=2000");
  state.auditLogs = Array.isArray(result.items) ? result.items : [];
  state.auditVisibleCount = state.inventoryPageSize;
  renderAuditTable();
}

function renderMyAuditTable() {
  const body = $("myAuditBody");
  if (!body) return;
  const items = state.myAuditLogs.slice(0, state.myAuditVisibleCount);
  body.innerHTML =
    items
      .map(
        (item) => `
      <tr>
        <td>${formatDate(item.createdAt)}</td>
        <td>${escapeHtml(formatAuditEntity(item))}</td>
        <td>${escapeHtml(getAuditEventText(item.eventType))}</td>
      </tr>
    `,
      )
      .join("") || '<tr><td colspan="3" class="muted">-</td></tr>';
}

function loadMoreMyAuditIfNeeded() {
  const modal = $("myAuditModal");
  if (!modal || modal.classList.contains("hidden")) return;
  const card = modal.querySelector(".modal-card");
  if (!card) return;
  const threshold = 80;
  const nearBottom = card.scrollTop + card.clientHeight >= card.scrollHeight - threshold;
  if (!nearBottom) return;
  if (state.myAuditVisibleCount >= state.myAuditLogs.length) return;
  state.myAuditVisibleCount += state.inventoryPageSize;
  renderMyAuditTable();
}

async function loadMyAudit() {
  if (!state.me?.id) {
    state.myAuditLogs = [];
    state.myAuditVisibleCount = 0;
    renderMyAuditTable();
    return;
  }
  await refreshAuditFbaRequestNoMap();
  const result = await request(`/audit-logs?page=1&pageSize=2000&operatorId=${state.me.id}`);
  state.myAuditLogs = Array.isArray(result.items) ? result.items : [];
  state.myAuditVisibleCount = state.inventoryPageSize;
  renderMyAuditTable();
}

function renderFbaPendingBadge() {
  const badge = $("fbaPendingBadge");
  if (!badge) return;
  const count = Number(state.fbaPendingCount || 0);
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count <= 0);
}

async function loadFbaPendingSummary() {
  if (!state.token) {
    state.fbaPendingCount = 0;
    state.fbaPendingBySku = {};
    state.fbaPendingByBoxSku = {};
    renderFbaPendingBadge();
    return;
  }

  const summary = await request("/inventory/fba-replenishments/pending-summary");
  state.fbaPendingCount = Number(summary?.pendingConfirmCount || 0);
  state.fbaPendingBySku = summary?.pendingBySku || {};
  state.fbaPendingByBoxSku = summary?.pendingByBoxSku || {};
  renderFbaPendingBadge();
}

function renderProductEditPendingBadge() {
  const badge = $("productEditPendingBadge");
  if (!badge) return;
  const count = Number(state.productEditPendingCount || 0);
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count <= 0);
}

async function loadProductEditPendingSummary() {
  if (!state.token) {
    state.productEditPendingCount = 0;
    renderProductEditPendingBadge();
    return;
  }

  const summary = await request("/sku-edit-requests/pending-summary");
  state.productEditPendingCount = Number(summary?.pendingCount || 0);
  renderProductEditPendingBadge();
}

function renderFbaReplenishmentList() {
  const tbody = $("fbaReplenishmentBody");
  if (!tbody) return;
  syncSelectedFbaIds();
  const list = state.fbaReplenishments.slice(0, state.fbaReplenishmentsVisibleCount);

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">-</td></tr>';
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
    return;
  }

  tbody.innerHTML = list
    .map(
      (item) => `
      <tr>
        <td>
          ${
            item.status === "pending_outbound"
              ? `<input type="checkbox" data-action="fbaToggleRow" data-id="${escapeHtml(item.id)}" ${
                  state.selectedFbaIds.has(String(item.id)) ? "checked" : ""
                } />`
              : "-"
          }
        </td>
        <td>${escapeHtml(item.requestNo)}</td>
        <td>${escapeHtml(getFbaStatusText(item.status))}</td>
        <td>${escapeHtml(displayText(item.sku?.sku))}</td>
        <td>${escapeHtml(displayText(item.sku?.model))}</td>
        <td>${escapeHtml(displayText(item.box?.boxCode))}</td>
        <td>${escapeHtml(displayText(item.box?.shelfCode))}</td>
        <td>${escapeHtml(displayText(item.requestedQty))}</td>
        <td>
          ${
            item.status === "pending_confirm"
              ? `<input id="fbaActualQty-${escapeHtml(item.id)}" class="tiny-input" type="number" min="1" step="1" value="${escapeHtml(item.actualQty ?? item.requestedQty)}" />`
              : escapeHtml(displayText(item.actualQty ?? item.requestedQty))
          }
        </td>
        <td>
          <div class="action-row">
            ${
              item.status === "pending_confirm"
                ? `<button class="tiny-btn" data-action="fbaConfirmRow" data-id="${escapeHtml(item.id)}" data-input-id="fbaActualQty-${escapeHtml(item.id)}">遑ｮ隶､</button>`
                : ""
            }
            ${
              item.status === "pending_outbound"
                ? `<button class="tiny-btn" data-action="fbaReopenRow" data-id="${escapeHtml(item.id)}">蜿俶峩</button>`
                : ""
            }
            ${
              item.status === "pending_confirm"
                ? `<button class="tiny-btn danger" data-action="fbaDeleteRow" data-id="${escapeHtml(item.id)}" data-request-no="${escapeHtml(item.requestNo)}">蛻髯､</button>`
                : ""
            }
            ${
              item.status === "outbound"
                ? `<span class="muted">${escapeHtml(item.expressNo ? `蠢ｫ騾貞捷・・{item.expressNo}` : "-")}</span>`
                : ""
            }
            ${item.status === "deleted" ? '<span class="muted">-</span>' : ""}
          </div>
        </td>
      </tr>
    `,
    )
    .join("");

  updateFbaSelectAll();
  updateFbaOutboundButtonState();
}

function loadMoreFbaReplenishmentsIfNeeded() {
  const panel = $("fbaReplenishment");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.fbaReplenishmentsVisibleCount >= state.fbaReplenishments.length) return;
  state.fbaReplenishmentsVisibleCount += state.inventoryPageSize;
  renderFbaReplenishmentList();
}

async function loadFbaReplenishments() {
  if (!state.token) {
    state.fbaReplenishments = [];
    state.fbaReplenishmentsVisibleCount = 0;
    state.selectedFbaIds = new Set();
    renderFbaReplenishmentList();
    return;
  }

  const list = await request("/inventory/fba-replenishments");
  state.fbaReplenishments = Array.isArray(list) ? list : [];
  state.fbaReplenishmentsVisibleCount = state.inventoryPageSize;
  renderFbaReplenishmentList();
}

async function createFbaReplenishmentRequest({ skuId, boxCode, qty, remark }) {
  return request("/inventory/fba-replenishments", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      boxCode,
      qty,
      remark,
    }),
  });
}

async function confirmFbaReplenishmentRequest(id, actualQty) {
  return request(`/inventory/fba-replenishments/${id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ actualQty }),
  });
}

async function outboundFbaReplenishmentRequests(ids, expressNo) {
  return request("/inventory/fba-replenishments/outbound", {
    method: "POST",
    body: JSON.stringify({ ids, expressNo }),
  });
}

async function deleteFbaReplenishmentRequest(id) {
  return request(`/inventory/fba-replenishments/${id}/delete`, {
    method: "POST",
  });
}

async function reopenFbaReplenishmentRequest(id) {
  return request(`/inventory/fba-replenishments/${id}/reopen`, {
    method: "POST",
  });
}

async function moveProductBetweenBoxes({ skuId, oldBoxCode, newBoxCode }) {
  return request("/inventory/move-product-between-boxes", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      fromBoxCode: oldBoxCode,
      toBoxCode: newBoxCode,
    }),
  });
}

function syncSelectedFbaIds() {
  const selectableIds = new Set(
    state.fbaReplenishments
      .filter((item) => item.status === "pending_outbound")
      .map((item) => String(item.id)),
  );
  state.selectedFbaIds = new Set(
    Array.from(state.selectedFbaIds).filter((id) => selectableIds.has(String(id))),
  );
}

function updateFbaSelectAll() {
  const selectAll = $("fbaSelectAll");
  if (!selectAll) return;
  const selectable = state.fbaReplenishments.filter((item) => item.status === "pending_outbound");
  if (!selectable.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = selectable.filter((item) => state.selectedFbaIds.has(String(item.id))).length;
  selectAll.checked = selectedCount > 0 && selectedCount === selectable.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
}

function updateFbaOutboundButtonState() {
  const button = $("fbaBatchOutboundBtn");
  if (!button) return;
  const count = state.selectedFbaIds.size;
  button.disabled = count <= 0;
  button.textContent = count > 0 ? `蜃ｺ蠎難ｼ・{count}・荏 : "蜃ｺ蠎・;
}

function openFbaOutboundModal() {
  if (!state.selectedFbaIds.size) {
    throw new Error("隸ｷ蜈磯画叫蠕・・蠎鍋筏隸ｷ蜊・);
  }
  $("fbaOutboundExpressNo").value = "";
  openModal("fbaOutboundModal");
}

function openAdjustModal(direction, skuId, presetBoxCode = "", maxQty = null) {
  const normalizedPresetBoxCode = normalizeBoxCodeInput(presetBoxCode);
  $("adjustSkuId").value = String(skuId);
  $("adjustDirection").value = direction;
  const lockBox = Boolean(normalizedPresetBoxCode);
  const boxInput = $("adjustBoxCode");
  const addBoxBtn = $("openCreateBoxFromAdjust");
  const boxHint = $("adjustBoxHint");
  boxInput.value = normalizedPresetBoxCode;
  if (lockBox) {
    boxInput.readOnly = true;
    boxInput.removeAttribute("list");
    addBoxBtn.classList.add("hidden");
    if (boxHint) boxHint.classList.add("hidden");
  } else {
    boxInput.readOnly = false;
    boxInput.setAttribute("list", "adjustBoxCodeList");
    addBoxBtn.classList.remove("hidden");
    renderAdjustBoxSuggestions(normalizedPresetBoxCode);
  }
  const qtyInput = $("adjustQty");
  qtyInput.min = "1";
  qtyInput.step = "1";
  qtyInput.value = "1";
  const normalizedMaxQty = Number(maxQty);
  if (direction === "outbound" && Number.isInteger(normalizedMaxQty) && normalizedMaxQty > 0) {
    qtyInput.dataset.maxQty = String(normalizedMaxQty);
  } else {
    qtyInput.dataset.maxQty = "";
  }
  $("adjustReason").value = direction === "inbound" ? "騾雍ｧ蜈･蠎・ : "FBA陦･雍ｧ";
  $("adjustModalTitle").textContent = direction === "inbound" ? "蠎灘ｭ伜・蠎・ : "FBA陦･雍ｧ";
  $("adjustSubmitBtn").textContent = direction === "inbound" ? "遑ｮ隶､蜈･蠎・ : "逕滓・FBA陦･雍ｧ逕ｳ隸ｷ蜊・;
  openModal("adjustModal");
}

async function quickOutboundOne(skuId, boxCode) {
  const normalizedBoxCode = normalizeBoxCodeInput(boxCode);
  if (!Number.isInteger(Number(skuId)) || Number(skuId) <= 0) {
    throw new Error("隸ｷ騾画叫莠ｧ蜩・);
  }
  if (!normalizedBoxCode) {
    throw new Error("隸ｷ騾画叫邂ｱ蜿ｷ");
  }

  await loadFbaPendingSummary();
  const rows = await getSkuInventoryRows(skuId);
  const matched = rows.find(
    (row) => String(row?.box?.boxCode || "").toUpperCase() === normalizedBoxCode,
  );
  const currentQty = Math.max(0, Number(matched?.qty ?? 0));
  const boxId = Number(matched?.box?.id ?? 0);
  const pendingQty = boxId > 0 ? getFbaPendingQtyByBoxSku(boxId, skuId) : 0;
  if (currentQty <= pendingQty) {
    throw new Error("謨ｰ驥丈ｸ崎ｶｳ・瑚ｯｷ蟇ｹFBA蜃ｺ雍ｧ蜊戊ｿ幄｡御ｿｮ謾ｹ");
  }

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId: Number(skuId),
      boxCode: normalizedBoxCode,
      qtyDelta: -1,
      reason: "蠢ｫ騾溷・蠎・莉ｶ",
    }),
  });
}

async function submitAdjustForm() {
  const skuId = Number($("adjustSkuId").value);
  const direction = $("adjustDirection").value;
  const rawBoxCode = $("adjustBoxCode").value;
  let boxCode = normalizeBoxCodeInput(rawBoxCode);
  const qty = Math.abs(Number($("adjustQty").value));
  const reason = $("adjustReason").value.trim() || undefined;

  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("隸ｷ騾画叫莠ｧ蜩・);
  }
  if (!boxCode) {
    throw new Error("隸ｷ騾画叫邂ｱ蜿ｷ");
  }
  if (direction === "inbound") {
    boxCode = await validateAdjustBoxInput(rawBoxCode, { normalizeInput: true });
    if (!boxCode) {
      throw new Error("邂ｱ蜿ｷ荳榊ｭ伜惠・瑚ｯｷ騾画叫蟾ｲ譛臥ｮｱ蜿ｷ謌冶・・譁ｰ蠅樒ｮｱ蜿ｷ");
    }
  }
  $("adjustBoxCode").value = boxCode;
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
    throw new Error("謨ｰ驥丞ｿ・｡ｻ荳ｺ豁｣謨ｴ謨ｰ");
  }
  if (direction === "outbound") {
    const latestQty = await getCurrentBoxSkuQty(skuId, boxCode);
    $("adjustQty").dataset.maxQty = String(latestQty);

    if (latestQty <= 0) {
      throw new Error("\u5f53\u524d\u7bb1\u53f7\u8be5SKU\u53ef\u7528\u5e93\u5b58\u4e3a0\uff0c\u4e0d\u80fd\u751f\u6210FBA\u8865\u8d27\u7533\u8bf7\u5355");
    }
    if (qty > latestQty) {
      throw new Error(`FBA\u8865\u8d27\u6570\u91cf\u4e0d\u80fd\u5927\u4e8e\u5f53\u524d\u7bb1\u53f7\u8be5SKU\u53ef\u7528\u6570\u91cf\uff08${latestQty}\uff09`);
    }
  }
  if (reason && reason.length > 10) {
    throw new Error("螟・ｳｨ譛螟・10 荳ｪ蟄・);
  }

  if (direction === "outbound") {
    await createFbaReplenishmentRequest({
      skuId,
      boxCode,
      qty,
      remark: reason || "FBA陦･雍ｧ",
    });
    return;
  }

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      boxCode,
      qtyDelta: qty,
      reason,
    }),
  });
}

async function createSkuFromModal() {
  const model = $("modalNewModel").value.trim() || undefined;
  const brand = $("modalNewBrand").value.trim() || undefined;
  const type = $("modalNewType").value.trim() || undefined;
  const color = $("modalNewColor").value.trim() || undefined;
  const shop = $("modalNewShop").value.trim() || undefined;
  const remark = $("modalNewRemark").value.trim() || undefined;
  const sku = $("modalNewSku").value.trim();
  const rbSku = $("modalNewErpSku").value.trim() || undefined;
  const asin = $("modalNewAsin").value.trim() || undefined;
  const fnsku = $("modalNewFnsku").value.trim() || undefined;
  const fbmSku = $("modalNewFbmSku").value.trim() || undefined;
  const rawBoxCode = $("modalNewSkuBoxCode").value;
  const boxCode = resolveEnabledBoxCode(rawBoxCode);
  const qty = Math.abs(Number($("modalNewSkuQty").value));
  const reason = "譁ｰ蟒ｺ莠ｧ蜩∝・蟋句・蠎・;

  if (!sku) throw new Error("SKU 荳崎・荳ｺ遨ｺ");
  if (!boxCode) throw new Error("邂ｱ蜿ｷ荳榊ｭ伜惠・瑚ｯｷ騾画叫蟾ｲ譛臥ｮｱ蜿ｷ謌冶・・譁ｰ蠅樒ｮｱ蜿ｷ");
  $("modalNewSkuBoxCode").value = boxCode;
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("謨ｰ驥丞ｿ・｡ｻ螟ｧ莠・0");

  const possibleDuplicate = await request(`/skus?q=${encodeURIComponent(sku)}`);
  if (possibleDuplicate.some((item) => item.sku === sku)) {
    throw new Error("SKU 蟾ｲ蟄伜惠");
  }

  const createdSku = await request("/skus", {
    method: "POST",
    body: JSON.stringify({ model, brand, type, color, shop, remark, sku, rbSku, asin, fnsku, fbmSku }),
  });

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId: createdSku.id,
      boxCode,
      qtyDelta: qty,
      reason,
    }),
  });
}

async function importSkusFromExcel(file) {
  if (!file) {
    throw new Error("隸ｷ蜈磯画叫Excel譁・ｻｶ");
  }
  const formData = new FormData();
  formData.append("file", file);
  return request("/skus/import-excel", {
    method: "POST",
    body: formData,
  });
}

async function importBulkInventoryUpdateFromExcel(file) {
  if (!file) {
    throw new Error("隸ｷ蜈磯画叫Excel譁・ｻｶ");
  }
  const formData = new FormData();
  formData.append("file", file);
  return request("/inventory/bulk-update-excel", {
    method: "POST",
    body: formData,
  });
}

async function createBoxFromSkuModal() {
  const boxCode = buildBoxCode($("modalNewBoxCodeDigits").value);
  const shelfId = Number($("modalNewBoxShelfId").value);

  if (!Number.isInteger(shelfId) || shelfId <= 0) throw new Error("隸ｷ騾画叫雍ｧ譫ｶ蜿ｷ");

  await request("/boxes", {
    method: "POST",
    body: JSON.stringify({ boxCode, shelfId }),
  });
  return boxCode;
}

async function createShelfFromInventoryModal() {
  const shelfCode = buildStrictShelfCode($("modalNewShelfCodeDigits").value);
  const name = $("modalNewShelfName").value.trim() || undefined;

  await request("/shelves", {
    method: "POST",
    body: JSON.stringify({ shelfCode, name }),
  });
}

async function submitMoveBoxShelfForm() {
  const sourceBox = findEnabledBoxByCode($("moveShelfBoxCode").value);
  const sourceBoxId = Number(sourceBox?.id || 0);
  if (!Number.isInteger(sourceBoxId) || sourceBoxId <= 0) {
    throw new Error("隸ｷ騾画叫邂ｱ蜿ｷ");
  }

  const targetShelfCode = resolveEnabledShelfCode(
    $("moveShelfTargetCode").value,
    sourceBox?.shelf?.id ?? null,
  );
  if (!targetShelfCode) {
    throw new Error("隸ｷ騾画叫逶ｮ譬・ｴｧ譫ｶ蜿ｷ");
  }
  const targetShelf = getEnabledShelvesSorted().find(
    (item) => String(item.shelfCode).toUpperCase() === String(targetShelfCode).toUpperCase(),
  );
  $("moveShelfTargetCode").value = formatShelfCodeWithName(
    targetShelf || { shelfCode: targetShelfCode },
  );
  const targetShelfId = Number(targetShelf?.id || 0);
  if (!Number.isInteger(targetShelfId) || targetShelfId <= 0) {
    throw new Error("隸ｷ騾画叫逶ｮ譬・ｴｧ譫ｶ蜿ｷ");
  }
  if (String(targetShelfId) === String(sourceBox?.shelf?.id)) {
    throw new Error("譁ｰ雍ｧ譫ｶ蜿ｷ荳崎・荳取立雍ｧ譫ｶ蜿ｷ逶ｸ蜷・);
  }

  await request(`/boxes/${sourceBoxId}`, {
    method: "PUT",
    body: JSON.stringify({ shelfId: targetShelfId }),
  });
}

async function submitMoveBoxCodeForm() {
  const skuId = resolveMoveProductSkuId();
  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("隸ｷ騾画叫SKU");
  }

  const rows = (await getSkuInventoryRows(skuId)).filter(
    (row) => Number(row?.qty ?? 0) > 0 && row?.box?.boxCode,
  );
  if (!rows.length) {
    throw new Error("隸･SKU蠖灘燕豐｡譛牙庄遘ｻ蜉ｨ蠎灘ｭ・);
  }

  const oldBoxCode = resolveEnabledBoxCode($("moveProductOldBoxCode").value);
  if (!oldBoxCode) {
    throw new Error("隸ｷ騾画叫譌ｧ邂ｱ蜿ｷ");
  }
  const oldRow = rows.find(
    (row) => String(row.box.boxCode).toUpperCase() === String(oldBoxCode).toUpperCase(),
  );
  if (!oldRow) {
    if (rows.length > 1) {
      throw new Error("隸･SKU蟄伜惠螟壻ｸｪ邂ｱ蜿ｷ・瑚ｯｷ謇句勘謖・ｮ壽立邂ｱ蜿ｷ");
    }
    throw new Error("譌ｧ邂ｱ蜿ｷ荳惨KU荳榊源驟・);
  }

  const newBoxCode = resolveEnabledBoxCode($("moveProductNewBoxCode").value);
  if (!newBoxCode) {
    throw new Error("隸ｷ騾画叫譁ｰ邂ｱ蜿ｷ");
  }
  if (String(newBoxCode).toUpperCase() === String(oldRow.box.boxCode).toUpperCase()) {
    throw new Error("譁ｰ邂ｱ蜿ｷ荳崎・荳取立邂ｱ蜿ｷ逶ｸ蜷・);
  }

  const qty = Number(oldRow.qty ?? 0);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("譌ｧ邂ｱ蜿ｷ荳玖ｯ･SKU蠎灘ｭ倅ｸ崎ｶｳ");
  }

  return moveProductBetweenBoxes({
    skuId,
    oldBoxCode: oldRow.box.boxCode,
    newBoxCode,
  });
}

async function initOverseasWarehousePage() {
  await Promise.all([loadShelves(), loadBoxes(), loadInventory()]);
  $("moveBoxShelfForm")?.reset();
  $("moveShelfCurrentCode").value = "";
  $("moveShelfTargetCode").value = "";
  renderMoveShelfBoxOptions("");
  renderMoveShelfTargetOptions("");
  syncMoveShelfCurrentDisplay();

  $("moveBoxCodeForm")?.reset();
  $("moveProductOldBoxCode").innerHTML = '<option value="">隸ｷ蜈磯画叫SKU</option>';
  $("moveProductOldShelfCode").value = "";
  $("moveProductNewShelfCode").value = "";
  const hint = $("moveProductOldBoxHint");
  if (hint) hint.classList.add("hidden");
  renderMoveProductNewBoxOptions("");
}

async function reloadAll() {
  await loadMe();
  if (!state.token) {
    clearStats();
    clearOverviewDashboard();
    $("usersBody").innerHTML = "";
    $("auditBody").innerHTML = "";
    $("myAuditBody").innerHTML = "";
    $("inventoryBody").innerHTML = "";
    $("batchInboundBody").innerHTML = "";
    $("fbaReplenishmentBody").innerHTML = "";
    renderBatchInboundDetail(null);
    $("inventorySearchResults").textContent = "-";
    $("brandsBody").innerHTML = "";
    $("skuTypesBody").innerHTML = "";
    $("shopsBody").innerHTML = "";
    $("shelfManageBody").innerHTML = "";
    $("boxManageBody").innerHTML = "";
    if ($("emptyBoxManageBody")) $("emptyBoxManageBody").innerHTML = "";
    $("dataBackupBody").innerHTML = "";
    $("productEditRequestBody").innerHTML = "";
    $("departmentOptionsBody").innerHTML = "";
    if ($("roleOptionsBody")) $("roleOptionsBody").innerHTML = "";
    renderProductEditRequestDetail(null);
    state.brands = [];
    state.skuTypes = [];
    state.shops = [];
    state.shelfEditingIds = new Set();
    state.boxEditingIds = new Set();
    state.departmentOptions = [];
    state.roleOptions = [];
    state.users = [];
    state.usersById = new Map();
    state.auditLogs = [];
    state.myAuditLogs = [];
    state.skuEditRequests = [];
    state.inventorySkus = [];
    state.emptyBoxes = [];
    state.inventorySortedSkus = [];
    state.inventoryLocations = new Map();
    state.inventoryTotalsBySku = {};
    state.dataBackups = [];
    state.inventoryVisibleCount = 0;
    state.usersVisibleCount = 0;
    state.auditVisibleCount = 0;
    state.myAuditVisibleCount = 0;
    state.skuEditRequestsVisibleCount = 0;
    state.batchInboundVisibleCount = 0;
    state.fbaReplenishmentsVisibleCount = 0;
    state.fbaPendingCount = 0;
    state.productEditPendingCount = 0;
    state.fbaPendingBySku = {};
    state.fbaPendingByBoxSku = {};
    state.selectedFbaIds = new Set();
    state.selectedProductEditRequestId = null;
    state.selectedProductEditRequestChangedFields = [];
    state.selectedProductEditRequestIds = new Set();
    const productEditSelectAll = $("productEditSelectAll");
    if (productEditSelectAll) {
      productEditSelectAll.checked = false;
      productEditSelectAll.indeterminate = false;
    }
    state.brandEditingIds = new Set();
    state.skuTypeEditingIds = new Set();
    state.shopEditingIds = new Set();
    state.departmentOptionEditingCodes = new Set();
    state.roleOptionEditingCodes = new Set();
    state.overviewDashboard = null;
    renderUserSelectOptions();
    renderUserOptionsTable();
    renderFbaPendingBadge();
    renderProductEditPendingBadge();
    renderEmptyBoxManageBadge();
    renderEmptyBoxManageTable();
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
    resetInventorySearchState();
    setInventoryDisplayMode(false);
    return;
  }

  const isAdmin = hasAdminAccess(state.me?.role);
  const tasks = [
    loadInventory(),
    loadProductEditPendingSummary(),
  ];
  if (!isAdmin) {
    state.departmentOptions = [];
    state.roleOptions = [];
    state.departmentOptionEditingCodes = new Set();
    state.roleOptionEditingCodes = new Set();
    state.users = [];
    state.usersById = new Map();
    state.auditLogs = [];
    state.usersVisibleCount = 0;
    state.auditVisibleCount = 0;
    $("usersBody").innerHTML = "";
    $("departmentOptionsBody").innerHTML = "";
    if ($("roleOptionsBody")) $("roleOptionsBody").innerHTML = "";
    $("auditBody").innerHTML = "";
    $("statUsers").textContent = "-";
    renderUserSelectOptions();
    renderUserOptionsTable();
  }

  const results = await Promise.allSettled(tasks);
  const firstError = results.find((item) => item.status === "rejected");
  if (firstError && firstError.status === "rejected") {
    throw firstError.reason;
  }
  resetInventorySearchState();
  setInventoryDisplayMode(false);
  focusInventorySearch();
}

function bindForms() {
  $("loginGateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "逋ｻ蠖穂ｸｭ...", async () => {
        const data = await request("/auth/login", {
          method: "POST",
          body: JSON.stringify({
            username: $("gateUsername").value.trim(),
            password: $("gatePassword").value,
          }),
        });
        state.token = data.accessToken;
        localStorage.setItem("wms_token", state.token);
        showToast("逋ｻ蠖墓・蜉・);
        await reloadAll();
        switchPanel("inventory");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const handleLogout = async () => {
    state.token = "";
    state.me = null;
    suppressAuthErrorToastUntil = Date.now() + 3000;
    localStorage.removeItem("wms_token");
    document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden"));
    showToast("蟾ｲ騾蜃ｺ逋ｻ蠖・);
    await reloadAll();
    switchPanel("overview");
  };

  $("logoutBtn")?.addEventListener("click", handleLogout);
  $("topLogoutBtn")?.addEventListener("click", handleLogout);

  $("openCreateUserModal")?.addEventListener("click", async () => {
    try {
      await loadUserOptions();
      $("createUserForm").reset();
      renderUserSelectOptions();
      openModal("createUserModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "謠蝉ｺ､荳ｭ...", async () => {
        const username = $("newUsername").value.trim();
        await request("/users", {
          method: "POST",
          body: JSON.stringify({
            username,
            department: $("newDepartment").value,
            role: $("newRole").value,
          }),
        });
        event.target.reset();
        closeModal("createUserModal");
        showToast("逕ｨ謌ｷ蟾ｲ譁ｰ蠅橸ｼ檎憾諤∽ｸｺ遖∫畑・瑚ｯｷ豼豢ｻ逕ｨ謌ｷ蜷守匳蠖・);
        await Promise.all([loadUsers(), loadAudit()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "菫晏ｭ倅ｸｭ...", async () => {
        const userId = String($("editUserId").value || "").trim();
        if (!userId) {
          throw new Error("譛ｪ騾画叫逕ｨ謌ｷ");
        }

        const username = $("editUsername").value.trim();
        const role = $("editUserRole").value;
        const department = $("editUserDepartment").value;
        if (!username) {
          throw new Error("隸ｷ霎灘・逕ｨ謌ｷ蜷・);
        }

        const payload = {
          username,
          department,
          role,
        };

        await request(`/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });

        closeModal("editUserModal");
        state.selectedEditUserId = null;
        showToast("逕ｨ謌ｷ菫｡諱ｯ蟾ｲ譖ｴ譁ｰ");
        await Promise.all([loadUsers(), loadAudit(), loadMe()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editUserToggleBtn").addEventListener("click", async () => {
    try {
      const userId = String($("editUserId").value || "").trim();
      if (!userId) {
        throw new Error("譛ｪ騾画叫逕ｨ謌ｷ");
      }
      const user = findUserById(userId);
      if (!user) {
        throw new Error("逕ｨ謌ｷ荳榊ｭ伜惠");
      }
      const nextStatus = Number(user.status) === 1 ? 0 : 1;
      const changed = await toggleUserStatus(userId, String(user.username || ""), nextStatus);
      if (!changed) return;
      const latest = findUserById(userId);
      if (!latest) {
        closeModal("editUserModal");
        state.selectedEditUserId = null;
        return;
      }
      syncEditUserActionButtons(userId, latest.status, latest.username);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editUserDeleteBtn").addEventListener("click", async () => {
    try {
      const userId = String($("editUserId").value || "").trim();
      if (!userId) {
        throw new Error("譛ｪ騾画叫逕ｨ謌ｷ");
      }
      const user = findUserById(userId);
      if (!user) {
        throw new Error("逕ｨ謌ｷ荳榊ｭ伜惠");
      }
      const deleted = await removeUser(userId, String(user.username || ""));
      if (!deleted) return;
      closeModal("editUserModal");
      state.selectedEditUserId = null;
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("resetUserPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "謠蝉ｺ､荳ｭ...", async () => {
        const userId = String($("resetPasswordUserId").value || "").trim();
        if (!userId) {
          throw new Error("譛ｪ騾画叫逕ｨ謌ｷ");
        }
        const mode = String($("resetPasswordMode").value || "reset");
        const password = String($("resetPasswordNewPassword").value || "").trim();
        if (password.length < 6 || password.length > 64) {
          throw new Error("蟇・・柄蠎ｦ髴荳ｺ6蛻ｰ64菴・);
        }

        await request(`/users/${encodeURIComponent(userId)}/reset-password`, {
          method: "POST",
          body: JSON.stringify({ password }),
        });

        closeModal("resetUserPasswordModal");
        state.selectedResetPasswordUserId = null;
        showToast(mode === "activate" ? "逕ｨ謌ｷ蟾ｲ豼豢ｻ蟷ｶ隶ｾ鄂ｮ譁ｰ蟇・・ : "蟇・∝ｷｲ驥咲ｽｮ");
        await Promise.all([loadUsers(), loadAudit()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createShelfForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "蛻帛ｻｺ荳ｭ...", async () => {
        const shelfCode = buildStrictShelfCode($("newShelfCodeDigits").value);
        await request("/shelves", {
          method: "POST",
          body: JSON.stringify({
            shelfCode,
            name: $("newShelfName").value.trim() || undefined,
          }),
        });
        event.target.reset();
        showToast("雍ｧ譫ｶ蟾ｲ蛻帛ｻｺ");
        await loadShelves();
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createBoxForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "蛻帛ｻｺ荳ｭ...", async () => {
        const boxCode = buildBoxCode($("newBoxCodeDigits").value);
        const shelfId = Number($("newBoxShelfId").value);
        if (!Number.isInteger(shelfId) || shelfId <= 0) {
          throw new Error("隸ｷ騾画叫雍ｧ譫ｶ蜿ｷ");
        }

        await request("/boxes", {
          method: "POST",
          body: JSON.stringify({
            boxCode,
            shelfId,
          }),
        });

        event.target.reset();
        showToast("邂ｱ蜿ｷ蟾ｲ蛻帛ｻｺ");
        await loadShelves();
        await loadBoxes();
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("collectBatchInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "驥・寔荳ｭ...", async () => {
        await submitCollectBatchInboundForm();
        showToast("邂ｱ蜿ｷ驥・寔螳梧・・悟ｷｲ蛻帛ｻｺ謇ｹ驥丞・蠎灘黒");
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId);
        }
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("uploadBatchInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "荳贋ｼ荳ｭ...", async () => {
        await submitUploadBatchInboundForm();
        showToast("譁・｡｣荳贋ｼ謌仙粥");
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId);
        }
        await loadInventory();
        await loadBoxes();
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadBatchInboundTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "荳玖ｽｽ荳ｭ...", async () => {
        await downloadBatchInboundTemplate();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadSkuUploadTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "荳玖ｽｽ荳ｭ...", async () => {
        await downloadSkuUploadTemplate();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadInventoryUpdateTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "荳玖ｽｽ荳ｭ...", async () => {
        await downloadInventoryUpdateTemplate();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventorySearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "譽邏｢荳ｭ...", async () => {
        await searchInventoryProducts($("inventoryKeyword").value.trim());
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadStockAdjustmentCsvBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "逕滓・荳ｭ...", async () => {
        await downloadStockAdjustmentCsv();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openBatchInboundModal").addEventListener("click", async () => {
    try {
      switchPanel("batchInbound");
      await loadBatchInboundOrders();
      if (state.selectedBatchInboundOrderId) {
        await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
      } else {
        renderBatchInboundDetail(null);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openDataBackupPanel").addEventListener("click", async () => {
    try {
      switchPanel("dataBackup");
      await loadDataBackups();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openSystemDashboardPanel").addEventListener("click", async () => {
    try {
      switchPanel("overview");
      await loadOverviewDashboard();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openFbaReplenishmentPanel").addEventListener("click", async () => {
    try {
      switchPanel("fbaReplenishment");
      await loadFbaReplenishments();
      await loadFbaPendingSummary();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadFbaOutboundExcelBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "荳玖ｽｽ荳ｭ...", async () => {
        await downloadFbaOutboundExcel();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaBatchOutboundBtn").addEventListener("click", () => {
    try {
      openFbaOutboundModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaSelectAll").addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const selectableIds = state.fbaReplenishments
      .filter((item) => item.status === "pending_outbound")
      .map((item) => String(item.id));
    state.selectedFbaIds = checked ? new Set(selectableIds) : new Set();
    renderFbaReplenishmentList();
  });

  $("fbaOutboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "螟・炊荳ｭ...", async () => {
        const expressNo = String($("fbaOutboundExpressNo").value || "").trim();
        if (!expressNo) {
          throw new Error("隸ｷ霎灘・蠢ｫ騾貞捷");
        }
        const ids = Array.from(state.selectedFbaIds)
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) {
          throw new Error("隸ｷ蜈磯画叫蠕・・蠎鍋筏隸ｷ蜊・);
        }
        const selectedRows = state.fbaReplenishments.filter((item) =>
          ids.includes(Number(item?.id)),
        );
        const blockedRow = selectedRows.find((item) =>
          hasPendingProductEditRequestBySkuId(Number(item?.sku?.id)),
        );
        if (blockedRow) {
          throw new Error(SKU_EDIT_PENDING_BLOCK_MESSAGE);
        }

        await outboundFbaReplenishmentRequests(ids, expressNo);
        closeModal("fbaOutboundModal");
        state.selectedFbaIds = new Set();
        showToast("蜃ｺ蠎灘ｮ梧・");
        const keyword = $("inventoryKeyword").value.trim();
        const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
        await loadFbaReplenishments();
        await loadFbaPendingSummary();
        await loadInventory({ preserveSearch: shouldRefreshSearch });
        await loadBoxes();
        if (shouldRefreshSearch) {
          await searchInventoryProducts(keyword);
        }
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openInventoryHome").addEventListener("click", async () => {
    try {
      await openInventoryHomeDefault();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openOverseasWarehousePanel").addEventListener("click", async () => {
    try {
      switchPanel("overseasWarehouse");
      await Promise.all([loadShelves(), loadBoxes(), loadInventory()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openProductManagementPanel").addEventListener("click", async () => {
    try {
      switchPanel("productManagement");
      await Promise.all([
        loadShelves(),
        loadBoxes(),
        loadInventory(),
        loadBrands(),
        loadSkuTypes(),
        loadShops(),
        loadProductEditRequests(),
        loadProductEditPendingSummary(),
      ]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openBrandManageModal").addEventListener("click", async () => {
    try {
      state.brandEditingIds = new Set();
      await loadBrands();
      openModal("brandManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openSkuTypeManageModal").addEventListener("click", async () => {
    try {
      state.skuTypeEditingIds = new Set();
      await loadSkuTypes();
      openModal("skuTypeManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openShopManageModal").addEventListener("click", async () => {
    try {
      state.shopEditingIds = new Set();
      await loadShops();
      openModal("shopManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openShelfManageModal").addEventListener("click", async () => {
    try {
      state.shelfEditingIds = new Set();
      resetShelfManageVisibleCount();
      await Promise.all([loadShelves(), loadBoxes()]);
      const wrap = $("shelfManageTableWrap");
      if (wrap) {
        wrap.scrollTop = 0;
      }
      openModal("shelfManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openStocktakePlannerPanel").addEventListener("click", async () => {
    try {
      await Promise.all([loadShelves(), loadBoxes(), loadStocktakeTasks()]);
      state.stocktakeVisibleCount = Math.min(30, state.stocktakeTasks.length);
      renderStocktakePlanner();
      switchPanel("stocktakePlanner");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("backToOverseasWarehouseBtn").addEventListener("click", () => {
    switchPanel("overseasWarehouse");
  });

  $("regenerateStocktakeTasksBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "逕滓・荳ｭ...", async () => {
        await generateStocktakeTasks();
        renderStocktakePlanner();
        showToast("已生成 1 条库存盘点任务");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("clearFutureStocktakeTasksBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      const ok = await openActionConfirmModal("遑ｮ隶､貂・炊莉雁､ｩ荵句錘逧・園譛牙ｺ灘ｭ倡尨轤ｹ莉ｻ蜉｡・・, "遑ｮ隶､貂・炊", "貂・炊");
      if (!ok) return;
      await withBusyButton(button, "貂・炊荳ｭ...", async () => {
        const result = await clearFutureStocktakeTasks();
        renderStocktakePlanner();
        showToast(
          Number(result?.deletedCount || 0) > 0
            ? `蟾ｲ貂・炊 ${Number(result.deletedCount)} 譚｡譛ｪ譚･逶倡せ莉ｻ蜉｡`
            : "豐｡譛牙庄貂・炊逧・悴譚･逶倡せ莉ｻ蜉｡",
        );
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("printStocktakeTaskDetailBtn").addEventListener("click", () => {
    try {
      openStocktakePrintWindow(state.selectedStocktakeTask, state.selectedStocktakeTaskRows);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openBoxManageModal").addEventListener("click", async () => {
    try {
      state.boxEditingIds = new Set();
      resetBoxManageVisibleCount();
      await Promise.all([loadShelves(), loadBoxes()]);
      const wrap = $("boxManageTableWrap");
      if (wrap) {
        wrap.scrollTop = 0;
      }
      openModal("boxManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openBoxContentQueryModal").addEventListener("click", async () => {
    try {
      await Promise.all([loadShelves(), loadBoxes()]);
      setQueryModalDirectResultMode("box", false);
      $("boxContentQueryForm")?.reset();
      resetBoxContentQueryResult();
      openModal("boxContentQueryModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openShelfBoxQueryModal").addEventListener("click", async () => {
    try {
      await Promise.all([loadShelves(), loadBoxes()]);
      setQueryModalDirectResultMode("shelf", false);
      $("shelfBoxQueryForm")?.reset();
      resetShelfBoxQueryResult();
      openModal("shelfBoxQueryModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openDepartmentManageModal").addEventListener("click", async () => {
    try {
      state.departmentOptionEditingCodes = new Set();
      await loadUserOptions();
      $("departmentOptionCreateForm")?.reset();
      renderDepartmentOptionCreateForm();
      openModal("departmentManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openCreateSkuModal").addEventListener("click", async () => {
    await Promise.all([loadShelves(), loadBoxes(), loadBrands(), loadSkuTypes(), loadShops()]).catch((error) =>
      showToast(error.message, true),
    );
    $("createSkuModalForm").reset();
    renderBrandOptionsForSelect("modalNewBrand", "隸ｷ騾画叫蜩∫煙");
    renderSkuTypeOptionsForSelect("modalNewType", "隸ｷ騾画叫邀ｻ蝙・);
    renderShopOptionsForSelect("modalNewShop", "隸ｷ騾画叫蠎鈴銅");
    $("modalNewSkuQty").value = "1";
    openModal("createSkuModal");
  });

  $("openBulkSkuUploadModal").addEventListener("click", () => {
    $("bulkSkuUploadForm").reset();
    openModal("bulkSkuUploadModal");
  });

  $("openBulkInventoryUpdateModal").addEventListener("click", () => {
    $("bulkInventoryUpdateForm").reset();
    openModal("bulkInventoryUpdateModal");
  });

  $("openEmptyBoxManageModal")?.addEventListener("click", async () => {
    try {
      await loadEmptyBoxes();
      const wrap = $("emptyBoxManageTableWrap");
      if (wrap) {
        wrap.scrollTop = 0;
      }
      openModal("emptyBoxManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const openCreateBoxModal = async (prefill = null) => {
    if (!state.shelves.length) {
      await loadShelves().catch((error) => showToast(error.message, true));
    }
    $("createBoxFromSkuForm").reset();
    const prefillBoxCode = String(prefill?.boxCode || "").trim();
    const prefillShelfId = Number(prefill?.shelfId);
    if (prefillBoxCode) {
      $("modalNewBoxCodeDigits").value = prefillBoxCode.replace(/\D/g, "").slice(-3);
    }
    if (Number.isInteger(prefillShelfId) && prefillShelfId > 0) {
      $("modalNewBoxShelfId").value = String(prefillShelfId);
    }
    openModal("createBoxFromSkuModal");
  };

  const openCreateShelfModal = async (prefill = null) => {
    $("createShelfFromInventoryForm").reset();
    const prefillShelfCode = String(prefill?.shelfCode || "").trim();
    const prefillShelfName = String(prefill?.name || "").trim();
    if (prefillShelfCode) {
      $("modalNewShelfCodeDigits").value = prefillShelfCode;
    }
    if (prefillShelfName) {
      $("modalNewShelfName").value = prefillShelfName;
    }
    openModal("createShelfFromInventoryModal");
  };

  $("openCreateBoxFromSkuModal").addEventListener("click", openCreateBoxModal);
  $("openCreateBoxFromAdjust").addEventListener("click", openCreateBoxModal);
  $("openCreateBoxFromManage").addEventListener("click", async () => {
    try {
      await openCreateBoxModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("openCreateShelfFromManage").addEventListener("click", async () => {
    try {
      await openCreateShelfModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("modalNewSkuBoxCode").addEventListener("input", (event) => {
    renderBoxOptionsForInput(
      "modalNewSkuBoxCode",
      "modalNewSkuBoxCodeList",
      "隸ｷ騾画叫蟾ｲ譛臥ｮｱ蜿ｷ謌冶・眠蠅樒ｮｱ蜿ｷ",
      event.target.value,
    );
  });
  $("modalNewSkuBoxCode").addEventListener("focus", (event) => {
    renderBoxOptionsForInput(
      "modalNewSkuBoxCode",
      "modalNewSkuBoxCodeList",
      "隸ｷ騾画叫蟾ｲ譛臥ｮｱ蜿ｷ謌冶・眠蠅樒ｮｱ蜿ｷ",
      event.target.value,
    );
  });
  $("modalNewSkuBoxCode").addEventListener("blur", (event) => {
    const resolved = resolveEnabledBoxCode(event.target.value);
    if (resolved) {
      event.target.value = resolved;
    }
  });
  $("moveShelfBoxCode").addEventListener("input", (event) => {
    renderMoveShelfBoxOptions(event.target.value);
    syncMoveShelfCurrentDisplay();
    $("moveShelfTargetCode").value = "";
    renderMoveShelfTargetOptions("");
  });
  $("moveShelfBoxCode").addEventListener("focus", (event) => {
    renderMoveShelfBoxOptions(event.target.value);
  });
  $("moveShelfBoxCode").addEventListener("blur", (event) => {
    const resolved = resolveEnabledBoxCode(event.target.value);
    if (resolved) {
      event.target.value = resolved;
    }
    syncMoveShelfCurrentDisplay();
    renderMoveShelfTargetOptions($("moveShelfTargetCode").value || "");
  });
  $("moveShelfTargetCode").addEventListener("input", (event) => {
    renderMoveShelfTargetOptions(event.target.value);
  });
  $("moveShelfTargetCode").addEventListener("focus", (event) => {
    renderMoveShelfTargetOptions(event.target.value);
  });
  $("moveShelfTargetCode").addEventListener("blur", (event) => {
    const currentBox = findEnabledBoxByCode($("moveShelfBoxCode")?.value || "");
    const resolved = resolveEnabledShelfCode(event.target.value, currentBox?.shelf?.id ?? null);
    if (resolved) {
      const matched = getEnabledShelvesSorted().find(
        (item) => normalizeShelfCodeInput(item?.shelfCode) === normalizeShelfCodeInput(resolved),
      );
      event.target.value = formatShelfCodeWithName(matched || { shelfCode: resolved });
    }
  });
  const moveProductSkuControl = $("moveProductSkuId");
  moveProductSkuControl.addEventListener("change", async () => {
    try {
      await refreshMoveProductOldBoxOptionsBySku();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  if (String(moveProductSkuControl.tagName || "").toUpperCase() !== "SELECT") {
    moveProductSkuControl.addEventListener("input", async () => {
      try {
        await refreshMoveProductOldBoxOptionsBySku();
      } catch (error) {
        showToast(error.message, true);
      }
    });
    moveProductSkuControl.addEventListener("blur", async (event) => {
      const raw = String(event.target?.value || "").trim();
      if (raw) {
        const matched = state.inventorySkus.find(
          (item) => String(item?.sku || "").trim().toUpperCase() === raw.toUpperCase(),
        );
        if (matched?.sku) {
          event.target.value = matched.sku;
        }
      }
      try {
        await refreshMoveProductOldBoxOptionsBySku();
      } catch (error) {
        showToast(error.message, true);
      }
    });
  }
  $("moveProductOldBoxCode").addEventListener("change", () => {
    syncMoveProductOldShelfDisplay();
  });
  $("moveProductNewBoxCode").addEventListener("input", (event) => {
    renderMoveProductNewBoxOptions(event.target.value);
    syncMoveProductNewShelfDisplay();
  });
  $("moveProductNewBoxCode").addEventListener("focus", (event) => {
    renderMoveProductNewBoxOptions(event.target.value);
  });
  $("moveProductNewBoxCode").addEventListener("blur", (event) => {
    const resolved = resolveEnabledBoxCode(event.target.value);
    if (resolved) {
      event.target.value = resolved;
    }
    syncMoveProductNewShelfDisplay();
  });
  $("adjustBoxCode").addEventListener("input", (event) => {
    renderAdjustBoxSuggestions(event.target.value);
    clearTimeout(adjustBoxValidationTimer);
    adjustBoxValidationTimer = setTimeout(() => {
      validateAdjustBoxInput(event.target.value).catch(() => {});
    }, 250);
  });
  $("adjustBoxCode").addEventListener("focus", (event) => {
    renderAdjustBoxSuggestions(event.target.value);
  });
  $("adjustBoxCode").addEventListener("blur", (event) => {
    clearTimeout(adjustBoxValidationTimer);
    validateAdjustBoxInput(event.target.value, { normalizeInput: true }).catch(() => {});
  });
  $("adjustQty").addEventListener("input", (event) => {
    const input = event.target;
    let digits = String(input.value || "").replace(/\D/g, "").replace(/^0+/, "");
    if (!digits) {
      input.value = "";
      return;
    }

    let value = Number(digits);
    if (!Number.isInteger(value) || value <= 0) {
      input.value = "";
      return;
    }

    input.value = String(value);
  });
  $("adjustQty").addEventListener("blur", (event) => {
    const input = event.target;
    if (!String(input.value || "").trim()) {
      input.value = "1";
    }
  });

  $("createSkuModalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "謠蝉ｺ､荳ｭ...", async () => {
        await createSkuFromModal();
        closeModal("createSkuModal");
        showToast("莠ｧ蜩∝ｷｲ蛻帛ｻｺ蟷ｶ蜈･蠎・);
        await loadShelves();
        await loadBoxes();
        await loadInventory();
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("bulkSkuUploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "荳贋ｼ荳ｭ...", async () => {
        const file = $("bulkSkuUploadFile").files?.[0];
        const result = await importSkusFromExcel(file);
        closeModal("bulkSkuUploadModal");
        showToast(
          `荳贋ｼ螳梧・・壼・${result.totalRows}陦鯉ｼ梧眠蠅・{result.createdCount}譚｡・檎函謌千ｼ冶ｾ醍筏隸ｷ${result.editRequestCount}譚｡`,
        );
        await Promise.all([
          loadInventory(),
          loadProductEditRequests(),
          loadProductEditPendingSummary(),
          loadAudit(),
        ]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("bulkInventoryUpdateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "荳贋ｼ荳ｭ...", async () => {
        const file = $("bulkInventoryUpdateFile").files?.[0];
        const result = await importBulkInventoryUpdateFromExcel(file);
        closeModal("bulkInventoryUpdateModal");
        showToast(
          `荳贋ｼ螳梧・・壼・${result.totalRows}陦鯉ｼ瑚ｰ・紛SKU${result.changedSkuCount}荳ｪ・悟ｺ灘ｭ伜序譖ｴ譏守ｻ・{result.changedItemCount}譚｡`,
        );
        await Promise.all([loadInventory(), loadAudit(), loadOverviewDashboard()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createBoxFromSkuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "蛻帛ｻｺ荳ｭ...", async () => {
        const createdBoxCode = await createBoxFromSkuModal();
        closeModal("createBoxFromSkuModal");
        showToast("邂ｱ蜿ｷ蟾ｲ蛻帛ｻｺ");
        await loadShelves();
        await loadBoxes();
        const createSkuModal = $("createSkuModal");
        if (createSkuModal && !createSkuModal.classList.contains("hidden")) {
          $("modalNewSkuBoxCode").value = createdBoxCode;
          renderBoxOptionsForInput(
            "modalNewSkuBoxCode",
            "modalNewSkuBoxCodeList",
            "隸ｷ騾画叫蟾ｲ譛臥ｮｱ蜿ｷ謌冶・眠蠅樒ｮｱ蜿ｷ",
            createdBoxCode,
          );
        }
        const adjustModal = $("adjustModal");
        if (adjustModal && !adjustModal.classList.contains("hidden")) {
          $("adjustBoxCode").value = createdBoxCode;
          renderAdjustBoxSuggestions(createdBoxCode);
        }
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createShelfFromInventoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "蛻帛ｻｺ荳ｭ...", async () => {
        await createShelfFromInventoryModal();
        closeModal("createShelfFromInventoryModal");
        showToast("雍ｧ譫ｶ蟾ｲ蛻帛ｻｺ");
        await loadShelves();
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openMyAuditLog").addEventListener("click", async () => {
    try {
      await loadMyAudit();
      openModal("myAuditModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("refreshMyAudit").addEventListener("click", async () => {
    try {
      await loadMyAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openProfileModal").addEventListener("click", () => {
    $("profileUsername").value = state.me?.username || "";
    $("profileRole").value = state.me?.role || "";
    $("profileCurrentPassword").value = "";
    $("profileNewPassword").value = "";
    openModal("profileModal");
  });

  $("profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "菫晏ｭ倅ｸｭ...", async () => {
        const currentPassword = $("profileCurrentPassword").value;
        const newPassword = $("profileNewPassword").value;
        await request("/auth/me/password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        closeModal("profileModal");
        showToast("蟇・∝ｷｲ譖ｴ譁ｰ");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editSkuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "謠蝉ｺ､荳ｭ...", async () => {
        await submitEditSkuForm();
        closeModal("editSkuModal");
        showToast("郛冶ｾ醍筏隸ｷ蟾ｲ謠蝉ｺ､");
        await Promise.all([loadProductEditRequests(), loadProductEditPendingSummary()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("adjustForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "螟・炊荳ｭ...", async () => {
        const keyword = $("inventoryKeyword").value.trim();
        const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
        const direction = $("adjustDirection").value;
        await submitAdjustForm();
        closeModal("adjustModal");
        showToast(direction === "outbound" ? "FBA陦･雍ｧ逕ｳ隸ｷ蜊募ｷｲ逕滓・" : "蜈･蠎捺・蜉・);
        await loadInventory({ preserveSearch: shouldRefreshSearch });
        await loadBoxes();
        await loadFbaReplenishments();
        await loadAudit();
        if (shouldRefreshSearch) {
          await searchInventoryProducts(keyword);
        }
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("boxContentQueryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "譟･隸｢荳ｭ...", async () => {
        await Promise.all([loadShelves(), loadBoxes()]);
        const rawBoxCode = $("boxContentQueryBoxCode").value;
        const normalizedBoxCode = normalizeBoxCodeInput(rawBoxCode);
        const box = findBoxByAnyCode(rawBoxCode);
        if (!box) {
          renderBoxContentQueryNotFound(normalizedBoxCode || String(rawBoxCode || "").trim());
          return;
        }
        const rows = await getBoxSkuInventoryRows(box.id);
        renderBoxContentQueryResult(box, rows);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("shelfBoxQueryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "譟･隸｢荳ｭ...", async () => {
        await Promise.all([loadShelves(), loadBoxes()]);
        const rawShelfCode = $("shelfBoxQueryShelfCode").value;
        const normalizedShelfCode = normalizeShelfCodeInput(rawShelfCode);
        const shelf = findShelfByAnyCode(rawShelfCode);
        if (!shelf) {
          renderShelfBoxQueryNotFound(normalizedShelfCode || String(rawShelfCode || "").trim());
          return;
        }
        const { boxCount, rows } = await getShelfBoxQueryRows(shelf);
        renderShelfBoxQueryResult(shelf, rows, boxCount);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function bindDelegates() {
  $("stocktakePlannerBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    try {
      if (button.dataset.action === "openStocktakeTaskDetail") {
        await openStocktakeTaskDetail(button.dataset.id || "");
        return;
      }
      if (button.dataset.action === "confirmStocktakeTask") {
        const ok = await openActionConfirmModal("遑ｮ隶､蟆・ｯ･逶倡せ莉ｻ蜉｡譬・ｮｰ荳ｺ蟾ｲ遑ｮ隶､・・, "遑ｮ隶､謫堺ｽ・, "遑ｮ隶､");
        if (!ok) return;
        await confirmStocktakeTask(button.dataset.id || "");
        renderStocktakePlanner();
        showToast("逶倡せ莉ｻ蜉｡蟾ｲ遑ｮ隶､");
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("brandsBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "editBrand") {
        const input = $(`brandName-${id}`);
        if (!input) return;
        const isEditing = state.brandEditingIds.has(String(id));
        if (!isEditing) {
          state.brandEditingIds.add(String(id));
          renderBrandsTable();
          const nextInput = $(`brandName-${id}`);
          if (nextInput) {
            nextInput.focus();
            nextInput.select();
          }
          return;
        }

        const name = String(input.value || "").trim();
        if (!name) {
          throw new Error("蜩∫煙蜷咲ｧｰ荳崎・荳ｺ遨ｺ");
        }
        const originalName = String(input.dataset.originalName || "").trim();
        if (!originalName) {
          throw new Error("蜩∫煙蜴溷ｧ句ｼ荳榊ｭ伜惠");
        }
        if (name === originalName) {
          state.brandEditingIds.delete(String(id));
          renderBrandsTable();
          return;
        }

        await request(`/brands/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        state.brandEditingIds.delete(String(id));
        showToast("蜩∫煙蟾ｲ譖ｴ譁ｰ・悟・閨・SKU 蜩∫煙蟾ｲ蜷梧ｭ･");
        await Promise.all([loadBrands(), loadInventory(), loadAudit()]);
      } else if (action === "deleteBrand") {
        const brandName = button.dataset.name || id;
        const ok = await openActionConfirmModal(`遑ｮ隶､蛻髯､蜩∫煙 ${brandName}・歔, "遑ｮ隶､謫堺ｽ・, "遑ｮ隶､蛻髯､");
        if (!ok) return;
        await request(`/brands/${id}`, { method: "DELETE" });
        state.brandEditingIds.delete(String(id));
        showToast("蜩∫煙蟾ｲ蛻髯､");
        await Promise.all([loadBrands(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("skuTypesBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "editSkuType") {
        const input = $(`skuTypeName-${id}`);
        if (!input) return;
        const isEditing = state.skuTypeEditingIds.has(String(id));
        if (!isEditing) {
          state.skuTypeEditingIds.add(String(id));
          renderSkuTypesTable();
          const focusInput = $(`skuTypeName-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const name = String(input?.value || "").trim();
        if (!name) {
          throw new Error("邀ｻ蝙句錐遘ｰ荳崎・荳ｺ遨ｺ");
        }
        const originalName = String(input.getAttribute("data-original-name") || "").trim();
        if (name === originalName) {
          state.skuTypeEditingIds.delete(String(id));
          renderSkuTypesTable();
          return;
        }
        await request(`/sku-types/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        state.skuTypeEditingIds.delete(String(id));
        showToast("邀ｻ蝙句ｷｲ譖ｴ譁ｰ");
        await Promise.all([loadSkuTypes(), loadInventory(), loadAudit()]);
      } else if (action === "deleteSkuType") {
        const skuTypeName = button.dataset.name || id;
        const ok = await openActionConfirmModal(`遑ｮ隶､蛻髯､邀ｻ蝙・${skuTypeName}・歔, "遑ｮ隶､謫堺ｽ・, "遑ｮ隶､蛻髯､");
        if (!ok) return;
        await request(`/sku-types/${id}`, { method: "DELETE" });
        state.skuTypeEditingIds.delete(String(id));
        showToast("邀ｻ蝙句ｷｲ蛻髯､");
        await Promise.all([loadSkuTypes(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("batchInboundBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const orderId = button.dataset.orderId;
    if (!orderId) return;

    try {
      if (action === "batchInboundSelectOrder" || action === "batchInboundOpenConfirm") {
        await loadBatchInboundOrderDetail(orderId, { silent: true });
        openModal("batchInboundDetailModal");
      } else if (action === "batchInboundSaveDomesticOrderNo") {
        const input = $(button.dataset.inputId || "");
        const domesticOrderNo = String(input?.value || "").trim();
        if (!domesticOrderNo) {
          throw new Error("隸ｷ霎灘・蝗ｽ蜀・黒蜿ｷ");
        }
        await saveBatchInboundDomesticOrderNo(orderId, domesticOrderNo);
        showToast("蝗ｽ蜀・黒蜿ｷ蟾ｲ菫晏ｭ・);
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
        }
      } else if (action === "batchInboundSaveSeaOrderNo") {
        const input = $(button.dataset.inputId || "");
        const seaOrderNo = String(input?.value || "").trim();
        if (!seaOrderNo) {
          throw new Error("隸ｷ霎灘・豬ｷ霑仙黒蜿ｷ");
        }
        await saveBatchInboundSeaOrderNo(orderId, seaOrderNo);
        showToast("豬ｷ霑仙黒蜿ｷ蟾ｲ菫晏ｭ・);
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
        }
      } else if (action === "batchInboundDeleteOrder") {
        const orderNo = button.dataset.orderNo || orderId;
        const ok = await openDeleteConfirmModal(
          `遑ｮ隶､蛻髯､謇ｹ驥丞・蠎灘黒 ${orderNo} ・溷唖髯､蜷惹ｼ夐㈱謾ｾ隸･蜊暮煤螳夂噪邂ｱ蜿ｷ縲Ａ,
        );
        if (!ok) return;
        await deleteBatchInboundOrder(orderId);
        showToast("蛻髯､謌仙粥・悟ｷｲ驥頑叛髞∝ｮ夂ｮｱ蜿ｷ");
        if (String(state.selectedBatchInboundOrderId) === String(orderId)) {
          state.selectedBatchInboundOrderId = "";
          state.selectedBatchInboundOrderDetail = null;
          renderBatchInboundDetail(null);
        }
        await loadBatchInboundOrders();
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("brandForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("brandNameInput").value || "").trim();
      if (!name) {
        throw new Error("隸ｷ霎灘・蜩∫煙蜷咲ｧｰ");
      }
      await request("/brands", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      $("brandNameInput").value = "";
      showToast("蜩∫煙蟾ｲ譁ｰ蠅・);
      await Promise.all([loadBrands(), loadInventory(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("skuTypeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("skuTypeNameInput").value || "").trim();
      if (!name) {
        throw new Error("隸ｷ霎灘・邀ｻ蝙句錐遘ｰ");
      }
      await request("/sku-types", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      $("skuTypeNameInput").value = "";
      showToast("邀ｻ蝙句ｷｲ譁ｰ蠅・);
      await Promise.all([loadSkuTypes(), loadInventory(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("shopsBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "editShop") {
        const input = $(`shopName-${id}`);
        if (!input) return;
        const isEditing = state.shopEditingIds.has(String(id));
        if (!isEditing) {
          state.shopEditingIds.add(String(id));
          renderShopsTable();
          const focusInput = $(`shopName-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const name = String(input?.value || "").trim();
        if (!name) {
          throw new Error("隸ｷ霎灘・蠎鈴銅蜷咲ｧｰ");
        }
        const originalName = String(input.getAttribute("data-original-name") || "").trim();
        if (name === originalName) {
          state.shopEditingIds.delete(String(id));
          renderShopsTable();
          return;
        }
        await request(`/shops/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        state.shopEditingIds.delete(String(id));
        showToast("蠎鈴銅蟾ｲ蜿俶峩");
        await Promise.all([loadShops(), loadInventory(), loadAudit()]);
      } else if (action === "deleteShop") {
        const shopName = button.dataset.name || id;
        const ok = await openActionConfirmModal(`遑ｮ隶､蛻髯､蠎鈴銅 ${shopName} ・歔, "遑ｮ隶､謫堺ｽ・, "遑ｮ隶､蛻髯､");
        if (!ok) return;
        await request(`/shops/${id}`, { method: "DELETE" });
        state.shopEditingIds.delete(String(id));
        showToast("蠎鈴銅蟾ｲ蛻髯､");
        await Promise.all([loadShops(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("shopForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("shopNameInput").value || "").trim();
      if (!name) {
        throw new Error("隸ｷ霎灘・蠎鈴銅蜷咲ｧｰ");
      }
      await request("/shops", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      $("shopNameInput").value = "";
      showToast("蠎鈴銅蟾ｲ譁ｰ蠅・);
      await Promise.all([loadShops(), loadInventory(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("departmentOptionCreateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("departmentOptionCreateName")?.value || "").trim();
      if (!name) {
        throw new Error("\u8bf7\u8f93\u5165\u90e8\u95e8\u540d\u79f0");
      }
      const payload = { name };

      await request("/user-options/departments", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      $("departmentOptionCreateForm")?.reset();
      showToast("部门已新增");
      await Promise.all([loadUserOptions(), loadUsers(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("shelfManageBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "queryShelfManage") {
        await openShelfBoxQueryModalForShelfCode(button.dataset.code || id, id);
      } else if (action === "editShelfManage") {
        const codeInput = $(`shelfCodeManage-${id}`);
        const nameInput = $(`shelfNameManage-${id}`);
        if (!codeInput || !nameInput) return;
        const isEditing = state.shelfEditingIds.has(String(id));
        if (!isEditing) {
          state.shelfEditingIds.add(String(id));
          renderShelvesManageTable();
          const focusInput = $(`shelfCodeManage-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const originalCode = String(codeInput.getAttribute("data-original-code") || "").trim();
        const originalName = String(nameInput.getAttribute("data-original-name") || "").trim();
        const rawCode = String(codeInput.value || "").trim();
        if (!rawCode) {
          throw new Error("隸ｷ霎灘・雍ｧ譫ｶ蜿ｷ");
        }
        const normalizedCode = normalizeShelfCodeInput(rawCode);
        if (!normalizedCode) {
          throw new Error("雍ｧ譫ｶ蜿ｷ譬ｼ蠑乗裏謨・);
        }
        const codeChanged = normalizedCode !== originalCode;
        if (codeChanged && !/^(?:00|[A-Z][0-9])$/.test(normalizedCode)) {
          throw new Error("雍ｧ譫ｶ蜿ｷ蠢・｡ｻ譏ｯ00謌泡0譬ｼ蠑・);
        }

        const name = String(nameInput.value || "").trim();
        const nameChanged = name !== originalName;
        if (nameChanged && !name && originalName) {
          throw new Error("雍ｧ譫ｶ蜷咲ｧｰ荳崎・荳ｺ遨ｺ");
        }
        if (!codeChanged && !nameChanged) {
          state.shelfEditingIds.delete(String(id));
          renderShelvesManageTable();
          return;
        }

        const payload = {};
        if (codeChanged) payload.shelfCode = normalizedCode;
        if (nameChanged && name) payload.name = name;

        await request(`/shelves/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        state.shelfEditingIds.delete(String(id));
        showToast("雍ｧ譫ｶ蟾ｲ蜿俶峩");
        await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
      } else if (action === "deleteShelfManage") {
        const shelfCode = button.dataset.code || id;
        const deleteCheck = await request(`/shelves/${id}/delete-check`);
        if (!deleteCheck?.canDelete) {
          showToast(buildDeleteBlockedMessage("雍ｧ譫ｶ", deleteCheck?.reasons), true);
          return;
        }
        const ok = await openActionConfirmModal(
          `遑ｮ隶､蛻髯､雍ｧ譫ｶ ${shelfCode} ・歔,
          "遑ｮ隶､謫堺ｽ・,
          "遑ｮ隶､蛻髯､",
        );
        if (!ok) return;
        await request(`/shelves/${id}`, { method: "DELETE" });
        state.shelfEditingIds.delete(String(id));
        showToast("雍ｧ譫ｶ蟾ｲ蛻髯､");
        await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("boxManageBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "queryBoxManage") {
        await openBoxContentQueryModalForBoxCode(button.dataset.code || id, id);
      } else if (action === "archiveReleaseBoxManage") {
        const boxCode = button.dataset.code || id;
        const ok = await openActionConfirmModal(
          `遑ｮ隶､蠖呈｡｣譌ｧ邂ｱ蟷ｶ驥頑叛邂ｱ蜿ｷ ${boxCode} ・歔,
          "譌ｧ邂ｱ莨壻ｿ晉蕗蜴・彰螳｡隶｡蟷ｶ髫占酪・悟次邂ｱ蜿ｷ蟆・㍾譁ｰ蜿ｯ逕ｨ縲・,
          "蠖呈｡｣驥頑叛",
        );
        if (!ok) return;
        const result = await request(`/boxes/${id}/archive-release`, { method: "POST" });
        state.boxEditingIds.delete(String(id));
        showToast(
          `邂ｱ蜿ｷ ${result?.releasedBoxCode || boxCode} 蟾ｲ驥頑叛・梧立邂ｱ蟾ｲ蠖呈｡｣荳ｺ ${result?.archivedBoxCode || "-"}`,
        );
        await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
      } else if (action === "editBoxManage") {
        const codeInput = $(`boxCodeManage-${id}`);
        const shelfSelect = $(`boxShelfManage-${id}`);
        if (!codeInput || !shelfSelect) return;
        const isEditing = state.boxEditingIds.has(String(id));
        if (!isEditing) {
          state.boxEditingIds.add(String(id));
          renderBoxesManageTable();
          const focusInput = $(`boxCodeManage-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const originalCode = String(codeInput.getAttribute("data-original-code") || "").trim();
        const rawCode = String(codeInput.value || "").trim();
        if (!rawCode) {
          throw new Error("隸ｷ霎灘・邂ｱ蜿ｷ");
        }
        const normalizedCode = normalizeBoxCodeInput(rawCode);
        if (!normalizedCode) {
          throw new Error("邂ｱ蜿ｷ譬ｼ蠑乗裏謨・);
        }
        const codeChanged = normalizedCode !== originalCode;
        if (codeChanged && !/^\d{3}$/.test(normalizedCode)) {
          throw new Error("邂ｱ蜿ｷ蠢・｡ｻ譏ｯ3菴肴焚蟄・);
        }

        const shelfId = Number(shelfSelect.value);
        if (!Number.isInteger(shelfId) || shelfId <= 0) {
          throw new Error("隸ｷ騾画叫雍ｧ譫ｶ蜿ｷ");
        }
        const originalShelfId = Number(String(shelfSelect.getAttribute("data-original-shelf-id") || "0"));
        const shelfChanged = shelfId !== originalShelfId;
        if (!codeChanged && !shelfChanged) {
          state.boxEditingIds.delete(String(id));
          renderBoxesManageTable();
          return;
        }

        const payload = {};
        if (codeChanged) payload.boxCode = normalizedCode;
        if (shelfChanged) payload.shelfId = shelfId;

        await request(`/boxes/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        state.boxEditingIds.delete(String(id));
        showToast("邂ｱ蜿ｷ蟾ｲ蜿俶峩");
        await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
      } else if (action === "deleteBoxManage") {
        const boxCode = button.dataset.code || id;
        const deleteCheck = await request(`/boxes/${id}/delete-check`);
        if (!deleteCheck?.canDelete) {
          showToast(buildDeleteBlockedMessage("邂ｱ蜿ｷ", deleteCheck?.reasons), true);
          return;
        }
        const ok = await openActionConfirmModal(
          `遑ｮ隶､蛻髯､邂ｱ蜿ｷ ${boxCode} ・歔,
          "遑ｮ隶､謫堺ｽ・,
          "遑ｮ隶､蛻髯､",
        );
        if (!ok) return;
        await request(`/boxes/${id}`, { method: "DELETE" });
        state.boxEditingIds.delete(String(id));
        showToast("邂ｱ蜿ｷ蟾ｲ蛻髯､");
        await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("emptyBoxManageBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='deleteEmptyBox']");
    if (!button) return;
    const id = button.dataset.id;
    if (!id) return;
    const boxCode = button.dataset.code || id;
    try {
      const ok = await openActionConfirmModal(
        `遑ｮ隶､蠎滄勁遨ｺ邂ｱ ${boxCode} 蜷暦ｼ歔,
        "遑ｮ隶､謫堺ｽ・,
        "遑ｮ隶､蠎滄勁",
      );
      if (!ok) return;
      await request(`/boxes/${id}`, { method: "DELETE" });
      showToast("遨ｺ邂ｱ蟾ｲ蠎滄勁");
      await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("moveBoxShelfForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const confirmed = await openActionConfirmModal(
        "遑ｮ隶､謇ｧ陦娯懃ｧｻ蜉ｨ邂ｱ蟄仙芦譁ｰ雍ｧ譫ｶ窶晢ｼ・,
        "遑ｮ隶､謫堺ｽ・,
        "遑ｮ隶､",
      );
      if (!confirmed) return;
      await submitMoveBoxShelfForm();
      showToast("邂ｱ蜿ｷ蟾ｲ遘ｻ蜉ｨ閾ｳ譁ｰ雍ｧ譫ｶ");
      await initOverseasWarehousePage();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("moveBoxCodeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const confirmed = await openActionConfirmModal(
        "遑ｮ隶､謇ｧ陦娯懃ｧｻ蜉ｨ莠ｧ蜩∝芦譁ｰ邂ｱ蟄絶晢ｼ・,
        "遑ｮ隶､謫堺ｽ・,
        "遑ｮ隶､",
      );
      if (!confirmed) return;
      const result = await submitMoveBoxCodeForm();
      showToast(`蟾ｲ蟆・{result.qty}莉ｶ莠ｧ蜩∽ｻ・${result.oldBoxCode} 遘ｻ蜉ｨ蛻ｰ ${result.newBoxCode}`);
      await initOverseasWarehousePage();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("batchInboundDetail").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const orderId = button.dataset.orderId;
    if (!orderId) return;

    try {
      if (action === "batchInboundConfirmAll") {
        await confirmBatchInboundAction("all", orderId);
        showToast("謨ｴ蜊慕｡ｮ隶､蜈･蠎捺・蜉・);
      } else if (action === "batchInboundConfirmBox") {
        const boxCode = button.dataset.boxCode;
        await confirmBatchInboundAction("box", orderId, { boxCode });
        showToast("謨ｴ邂ｱ遑ｮ隶､蜈･蠎捺・蜉・);
      } else if (action === "batchInboundConfirmItem") {
        const itemId = button.dataset.itemId;
        await confirmBatchInboundAction("item", orderId, { itemId });
        showToast("SKU遑ｮ隶､蜈･蠎捺・蜉・);
      } else {
        return;
      }

      await loadBatchInboundOrders();
      await loadBatchInboundOrderDetail(orderId, { silent: true });
      await loadInventory();
      await loadBoxes();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaReplenishmentBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    try {
      const action = button.dataset.action;
      const id = Number(button.dataset.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("逕ｳ隸ｷ蜊肘D譌謨・);
      }

      if (action === "fbaConfirmRow") {
        const row = state.fbaReplenishments.find((item) => Number(item?.id) === id);
        if (row && hasPendingProductEditRequestBySkuId(Number(row?.sku?.id))) {
          throw new Error(SKU_EDIT_PENDING_BLOCK_MESSAGE);
        }
        const inputId = button.dataset.inputId || "";
        const input = $(inputId);
        const actualQty = Number(String(input?.value || "").trim());
        if (!Number.isInteger(actualQty) || actualQty <= 0) {
          throw new Error("螳樣刔謨ｰ驥丞ｿ・｡ｻ譏ｯ螟ｧ莠・逧・紛謨ｰ");
        }
        await confirmFbaReplenishmentRequest(id, actualQty);
        showToast("蟾ｲ霓ｬ荳ｺ蠕・・蠎・, false, {
          labelData: {
            fnsku: row?.sku?.fnsku || "",
            qty: actualQty,
            sku: row?.sku?.sku || "",
          },
        });
      } else if (action === "fbaReopenRow") {
        await reopenFbaReplenishmentRequest(id);
        showToast("蟾ｲ蝗樣蛻ｰ蠕・｡ｮ隶､・悟庄驥肴眠菫ｮ謾ｹ螳樣刔謨ｰ驥・);
      } else if (action === "fbaDeleteRow") {
        const requestNo = button.dataset.requestNo || `#${id}`;
        const ok = await openDeleteConfirmModal(`遑ｮ隶､蛻髯､FBA陦･雍ｧ逕ｳ隸ｷ蜊・${requestNo} ・歔);
        if (!ok) return;
        await deleteFbaReplenishmentRequest(id);
        showToast("逕ｳ隸ｷ蜊募ｷｲ蛻髯､");
      } else {
        return;
      }

      const keyword = $("inventoryKeyword").value.trim();
      const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
      state.selectedFbaIds.delete(String(id));
      await loadFbaReplenishments();
      await loadFbaPendingSummary();
      await loadInventory({ preserveSearch: shouldRefreshSearch });
      await loadBoxes();
      if (shouldRefreshSearch) {
        await searchInventoryProducts(keyword);
      }
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaReplenishmentBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='fbaToggleRow']");
    if (!checkbox) return;

    const id = String(checkbox.dataset.id || "");
    if (!id) return;
    if (checkbox.checked) {
      state.selectedFbaIds.add(id);
    } else {
      state.selectedFbaIds.delete(id);
    }
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
  });

  const openAdjustByAction = async (event) => {
    const button = event.target.closest(
      "button[data-action='inventoryInbound'], button[data-action='inventoryOutbound'], button[data-action='inventoryOutboundOne']",
    );
    if (!button) return;

    const skuId = Number(button.dataset.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) return;

    try {
      const action = button.dataset.action;
      const boxCode = button.dataset.boxCode || "";
      if (action === "inventoryOutboundOne") {
        const keyword = $("inventoryKeyword").value.trim();
        const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
        await quickOutboundOne(skuId, boxCode);
        const confirmed = await openActionConfirmModal("蜃ｺ蠎・莉ｶ謌仙粥", "謠千､ｺ", "遑ｮ隶､", { showCancel: false });
        if (!confirmed) return;
        await loadInventory({ preserveSearch: shouldRefreshSearch });
        await loadBoxes();
        await loadAudit();
        if (shouldRefreshSearch) {
          await searchInventoryProducts(keyword);
        }
        return;
      }

      const direction = action === "inventoryOutbound" ? "outbound" : "inbound";
      if (direction === "outbound") {
        ensureSkuReadyForFbaReplenishment(skuId);
      }
      const maxQty = Number(button.dataset.maxQty || 0);
      openAdjustModal(
        direction,
        skuId,
        boxCode,
        Number.isInteger(maxQty) && maxQty > 0 ? maxQty : null,
      );
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("inventoryBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    try {
      const action = String(button.dataset.action || "");
      if (action === "inventoryEdit") {
        const skuId = Number(button.dataset.skuId);
        if (!Number.isInteger(skuId) || skuId <= 0) return;
        await openEditSkuModal(skuId);
        return;
      }

      if (action === "inventoryFbaJump") {
        const skuCode = String(button.dataset.skuCode || "").trim();
        if (!skuCode) return;
        const keywordInput = $("inventoryKeyword");
        if (keywordInput) {
          keywordInput.value = skuCode;
        }
        await searchInventoryProducts(skuCode);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventorySearchResults").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='inventoryEdit']");
    if (!button) return;
    const skuId = Number(button.dataset.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) return;
    try {
      await openEditSkuModal(skuId);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("usersBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const userId = String(button.dataset.id || "").trim();
    const username = String(button.dataset.username || "").trim();
    if (!userId) return;

    try {
      if (button.dataset.action === "editUser") {
        const role = String(button.dataset.role || "employee");
        const department = String(button.dataset.department || "china_warehouse");
        const status = Number(button.dataset.status ?? 1);
        openEditUserModal(userId, username, role, department, status);
        return;
      }

      if (button.dataset.action === "resetUserPassword") {
        const passwordInitialized = String(button.dataset.passwordInitialized || "0") === "1";
        openResetUserPasswordModal(userId, username, passwordInitialized);
        return;
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const handleUserOptionClick = async (event, kind) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = String(button.dataset.action || "");
    const isDepartment = kind === "departments";
    const editAction = isDepartment ? "editDepartmentOption" : "editRoleOption";
    const deleteAction = isDepartment ? "deleteDepartmentOption" : "deleteRoleOption";
    if (![editAction, deleteAction].includes(action)) return;

    const row = button.closest("tr[data-user-option-code]");
    if (!row) return;
    const code = String(row.dataset.userOptionCode || "").trim();
    const endpointKind = kind === "roles" ? "roles" : "departments";
    if (!code) return;
    const editingSet = isDepartment ? state.departmentOptionEditingCodes : state.roleOptionEditingCodes;

    try {
      if (action === editAction) {
        const nameInput = row.querySelector("input[data-field='name']");
        if (!nameInput) return;

        const isEditing = editingSet.has(code);
        if (!isEditing) {
          editingSet.add(code);
          renderUserOptionsTable();
          const focusInput = isDepartment ? $(`departmentOptionName-${code}`) : $(`roleOptionName-${code}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const name = String(nameInput.value || "").trim();
        if (!name) {
          throw new Error("蜷咲ｧｰ荳崎・荳ｺ遨ｺ");
        }
        const originalName = String(nameInput.getAttribute("data-original-name") || "").trim();
        if (name === originalName) {
          editingSet.delete(code);
          renderUserOptionsTable();
          return;
        }

        await request(`/user-options/${endpointKind}/${encodeURIComponent(code)}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        editingSet.delete(code);
        showToast("蜿俶峩謌仙粥");
      } else if (action === deleteAction) {
        const nameInput = row.querySelector("input[data-field='name']");
        const optionName = String(nameInput?.value || code).trim() || code;
        const ok = await openActionConfirmModal(
          `遑ｮ隶､蛻髯､${isDepartment ? "驛ｨ髣ｨ" : "隗定牡"} ${optionName} 蜷暦ｼ歔,
          "遑ｮ隶､謫堺ｽ・,
          "遑ｮ隶､蛻髯､",
        );
        if (!ok) return;
        await request(`/user-options/${endpointKind}/${encodeURIComponent(code)}`, {
          method: "PUT",
          body: JSON.stringify({ status: 0 }),
        });
        editingSet.delete(code);
        showToast("蛻髯､謌仙粥");
      }

      await Promise.all([loadUserOptions(), loadUsers(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  };
  $("departmentOptionsBody").addEventListener("click", (event) => {
    handleUserOptionClick(event, "departments");
  });

  $("productEditRequestBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='toggleProductEditRequestSelect']");
    if (!checkbox) return;
    const requestId = String(checkbox.dataset.id || "").trim();
    if (!requestId) return;
    if (checkbox.checked) {
      state.selectedProductEditRequestIds.add(requestId);
    } else {
      state.selectedProductEditRequestIds.delete(requestId);
    }
    updateProductEditRequestSelectAll();
  });

  $("productEditRequestBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const requestId = Number(button.dataset.id || 0);
    if (!Number.isInteger(requestId) || requestId <= 0) return;

    try {
      if (button.dataset.action === "openProductEditRequestDetail") {
        const detail = await loadProductEditRequestDetail(requestId);
        renderProductEditRequestDetail(detail);
        openModal("productEditRequestDetailModal");
        return;
      }

      if (button.dataset.action === "deleteProductEditRequestRow") {
        const ok = await openDeleteConfirmModal("遑ｮ隶､蛻髯､隸･郛冶ｾ醍筏隸ｷ・・);
        if (!ok) return;
        await deleteProductEditRequest(requestId);
        showToast("郛冶ｾ醍筏隸ｷ蟾ｲ蛻髯､");
        await Promise.all([loadProductEditRequests(), loadProductEditPendingSummary()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("productEditSelectAll").addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const visibleRows = state.skuEditRequests
      .slice(0, state.skuEditRequestsVisibleCount)
      .filter((item) => canSelectProductEditRequestForBatchConfirm(item))
      .map((item) => String(item.id));
    if (checked) {
      visibleRows.forEach((id) => state.selectedProductEditRequestIds.add(id));
    } else {
      visibleRows.forEach((id) => state.selectedProductEditRequestIds.delete(id));
    }
    renderProductEditRequestTable();
  });

  $("batchConfirmProductEditRequestBtn").addEventListener("click", async () => {
    try {
      const ids = [...state.selectedProductEditRequestIds]
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (!ids.length) {
        throw new Error("隸ｷ騾画叫髴隕∵音驥冗｡ｮ隶､逧・筏隸ｷ");
      }

      const ok = await openActionConfirmModal(
        `遑ｮ隶､謇ｹ驥冗｡ｮ隶､ ${ids.length} 譚｡郛冶ｾ台ｺｧ蜩∫筏隸ｷ・歔,
        "謇ｹ驥冗｡ｮ隶､郛冶ｾ台ｺｧ蜩∫筏隸ｷ",
        "謇ｹ驥冗｡ｮ隶､",
      );
      if (!ok) return;

      let successCount = 0;
      const failedMessages = [];
      for (const id of ids) {
        try {
          await confirmProductEditRequest(id);
          successCount += 1;
        } catch (error) {
          const message = String(error?.message || "遑ｮ隶､螟ｱ雍･");
          failedMessages.push(`#${id}: ${message}`);
        }
      }

      state.selectedProductEditRequestIds = new Set();
      await Promise.all([
        loadProductEditRequests(),
        loadProductEditPendingSummary(),
        loadInventory(),
        loadAudit(),
      ]);

      if (state.selectedProductEditRequestId) {
        try {
          const detail = await loadProductEditRequestDetail(state.selectedProductEditRequestId);
          renderProductEditRequestDetail(detail);
        } catch {
          renderProductEditRequestDetail(null);
        }
      }

      if (!failedMessages.length) {
        showToast(`謇ｹ驥冗｡ｮ隶､螳梧・・悟・ ${successCount} 譚｡`);
      } else {
        const firstError = failedMessages[0];
        showToast(
          `謇ｹ驥冗｡ｮ隶､螳梧・・壽・蜉・${successCount} 譚｡・悟､ｱ雍･ ${failedMessages.length} 譚｡縲・{firstError}`,
          true,
        );
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("confirmProductEditRequestBtn").addEventListener("click", async () => {
    try {
      const permission = resolveProductEditConfirmPermission(
        state.selectedProductEditRequestChangedFields,
      );
      if (!permission.allowed) {
        throw new Error(permission.contactMessage || permission.message);
      }
      const id = Number(state.selectedProductEditRequestId || 0);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("隸ｷ蜈磯画叫郛冶ｾ醍筏隸ｷ");
      }
      const ok = await openActionConfirmModal(
        "遑ｮ隶､蜷惹ｼ壽ｭ｣蠑乗峩譁ｰ莠ｧ蜩∵焚謐ｮ・梧弍蜷ｦ扈ｧ扈ｭ・・,
        "遑ｮ隶､郛冶ｾ醍筏隸ｷ",
        "遑ｮ隶､",
      );
      if (!ok) return;
      await confirmProductEditRequest(id);
      showToast("郛冶ｾ醍筏隸ｷ蟾ｲ遑ｮ隶､蟷ｶ譖ｴ譁ｰ謨ｰ謐ｮ蠎・);
      const detail = await loadProductEditRequestDetail(id);
      renderProductEditRequestDetail(detail);
      await Promise.all([
        loadProductEditRequests(),
        loadProductEditPendingSummary(),
        loadInventory(),
        loadAudit(),
      ]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("dataBackupBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='downloadDataBackup']");
    if (!button) return;
    const fileName = String(button.dataset.fileName || "").trim();
    if (!fileName) return;
    try {
      await downloadDataBackup(fileName);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventorySearchResults").addEventListener("click", openAdjustByAction);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='closeCreateSkuModal']");
    if (button) {
      closeModal("createSkuModal");
      return;
    }
    const bulkSkuUploadClose = event.target.closest("button[data-action='closeBulkSkuUploadModal']");
    if (bulkSkuUploadClose) {
      closeModal("bulkSkuUploadModal");
      return;
    }
    const bulkInventoryUpdateClose = event.target.closest(
      "button[data-action='closeBulkInventoryUpdateModal']",
    );
    if (bulkInventoryUpdateClose) {
      closeModal("bulkInventoryUpdateModal");
      return;
    }
    const boxClose = event.target.closest("button[data-action='closeCreateBoxFromSkuModal']");
    if (boxClose) {
      closeModal("createBoxFromSkuModal");
      return;
    }
    const shelfClose = event.target.closest("button[data-action='closeCreateShelfFromInventoryModal']");
    if (shelfClose) {
      closeModal("createShelfFromInventoryModal");
      return;
    }
    const adjustClose = event.target.closest("button[data-action='closeAdjustModal']");
    if (adjustClose) {
      closeModal("adjustModal");
      return;
    }
    const myAuditClose = event.target.closest("button[data-action='closeMyAuditModal']");
    if (myAuditClose) {
      closeModal("myAuditModal");
      return;
    }
    const profileClose = event.target.closest("button[data-action='closeProfileModal']");
    if (profileClose) {
      closeModal("profileModal");
      return;
    }
    const createUserClose = event.target.closest("button[data-action='closeCreateUserModal']");
    if (createUserClose) {
      closeModal("createUserModal");
      return;
    }
    const editUserClose = event.target.closest("button[data-action='closeEditUserModal']");
    if (editUserClose) {
      closeModal("editUserModal");
      state.selectedEditUserId = null;
      return;
    }
    const resetUserPasswordClose = event.target.closest("button[data-action='closeResetUserPasswordModal']");
    if (resetUserPasswordClose) {
      closeModal("resetUserPasswordModal");
      state.selectedResetPasswordUserId = null;
      return;
    }
    const editClose = event.target.closest("button[data-action='closeEditSkuModal']");
    if (editClose) {
      closeModal("editSkuModal");
      return;
    }
    const brandManageClose = event.target.closest("button[data-action='closeBrandManageModal']");
    if (brandManageClose) {
      closeModal("brandManageModal");
      return;
    }
    const skuTypeManageClose = event.target.closest("button[data-action='closeSkuTypeManageModal']");
    if (skuTypeManageClose) {
      closeModal("skuTypeManageModal");
      return;
    }
    const shopManageClose = event.target.closest("button[data-action='closeShopManageModal']");
    if (shopManageClose) {
      closeModal("shopManageModal");
      return;
    }
    const shelfManageClose = event.target.closest("button[data-action='closeShelfManageModal']");
    if (shelfManageClose) {
      closeModal("shelfManageModal");
      return;
    }
    const boxManageClose = event.target.closest("button[data-action='closeBoxManageModal']");
    if (boxManageClose) {
      closeModal("boxManageModal");
      return;
    }
    const emptyBoxManageClose = event.target.closest("button[data-action='closeEmptyBoxManageModal']");
    if (emptyBoxManageClose) {
      closeModal("emptyBoxManageModal");
      return;
    }
    const boxContentQueryClose = event.target.closest("button[data-action='closeBoxContentQueryModal']");
    if (boxContentQueryClose) {
      closeModal("boxContentQueryModal");
      return;
    }
    const shelfBoxQueryClose = event.target.closest("button[data-action='closeShelfBoxQueryModal']");
    if (shelfBoxQueryClose) {
      closeModal("shelfBoxQueryModal");
      return;
    }
    const stocktakeTaskDetailClose = event.target.closest("button[data-action='closeStocktakeTaskDetailModal']");
    if (stocktakeTaskDetailClose) {
      closeModal("stocktakeTaskDetailModal");
      return;
    }

    const departmentManageClose = event.target.closest("button[data-action='closeDepartmentManageModal']");
    if (departmentManageClose) {
      closeModal("departmentManageModal");
      return;
    }
    const productEditRequestDetailClose = event.target.closest(
      "button[data-action='closeProductEditRequestDetailModal']",
    );
    if (productEditRequestDetailClose) {
      closeModal("productEditRequestDetailModal");
      return;
    }
    const deleteConfirmClose = event.target.closest("button[data-action='closeDeleteConfirmModal']");
    if (deleteConfirmClose) {
      resolveDeleteConfirm(false);
      return;
    }
    const actionConfirmClose = event.target.closest("button[data-action='closeActionConfirmModal']");
    if (actionConfirmClose) {
      resolveActionConfirm(false);
      return;
    }
    const errorModalClose = event.target.closest("button[data-action='closeErrorModal']");
    if (errorModalClose) {
      closeErrorModal();
      return;
    }
    const batchInboundDetailModalClose = event.target.closest(
      "button[data-action='closeBatchInboundDetailModal']",
    );
    if (batchInboundDetailModalClose) {
      closeModal("batchInboundDetailModal");
      return;
    }
    const fbaOutboundModalClose = event.target.closest(
      "button[data-action='closeFbaOutboundModal']",
    );
    if (fbaOutboundModalClose) {
      closeModal("fbaOutboundModal");
    }
  });

  $("createSkuModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createSkuModal");
    }
  });

  $("bulkSkuUploadModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("bulkSkuUploadModal");
    }
  });

  $("bulkInventoryUpdateModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("bulkInventoryUpdateModal");
    }
  });

  $("adjustModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("adjustModal");
    }
  });

  $("createBoxFromSkuModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createBoxFromSkuModal");
    }
  });

  $("createShelfFromInventoryModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createShelfFromInventoryModal");
    }
  });

  $("myAuditModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("myAuditModal");
    }
  });

  $("profileModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("profileModal");
    }
  });

  $("createUserModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createUserModal");
    }
  });

  $("editUserModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("editUserModal");
      state.selectedEditUserId = null;
    }
  });

  $("resetUserPasswordModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("resetUserPasswordModal");
      state.selectedResetPasswordUserId = null;
    }
  });

  $("editSkuModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("editSkuModal");
    }
  });

  $("brandManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("brandManageModal");
    }
  });

  $("skuTypeManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("skuTypeManageModal");
    }
  });

  $("shopManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("shopManageModal");
    }
  });

  $("shelfManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("shelfManageModal");
    }
  });

  $("boxManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("boxManageModal");
    }
  });

  $("emptyBoxManageModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("emptyBoxManageModal");
    }
  });

  $("boxContentQueryModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("boxContentQueryModal");
    }
  });

  $("shelfBoxQueryModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("shelfBoxQueryModal");
    }
  });

  $("departmentManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("departmentManageModal");
    }
  });

  $("productEditRequestDetailModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("productEditRequestDetailModal");
    }
  });

  $("batchInboundDetailModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("batchInboundDetailModal");
    }
  });

  $("fbaOutboundModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("fbaOutboundModal");
    }
  });

  $("deleteConfirmOkBtn").addEventListener("click", () => {
    resolveDeleteConfirm(true);
  });

  $("deleteConfirmCancelBtn").addEventListener("click", () => {
    resolveDeleteConfirm(false);
  });

  $("deleteConfirmModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      resolveDeleteConfirm(false);
    }
  });

  $("actionConfirmOkBtn").addEventListener("click", () => {
    resolveActionConfirm(true);
  });

  $("actionConfirmCancelBtn").addEventListener("click", () => {
    resolveActionConfirm(false);
  });

  $("actionConfirmModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      resolveActionConfirm(false);
    }
  });

  $("errorModalCloseBtn").addEventListener("click", () => {
    closeErrorModal();
  });

  $("errorModalPrintLabelBtn").addEventListener("click", () => {
    try {
      printPendingLabelFromErrorModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("errorModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeErrorModal();
    }
  });
}

function bindScrollLoad() {
  window.addEventListener("scroll", () => {
    const threshold = 120;
    const nearBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - threshold;
    if (!nearBottom) return;
    loadMoreInventoryIfNeeded();
    loadMoreInventorySearchIfNeeded();
    loadMoreProductEditRequestsIfNeeded();
    loadMoreBatchInboundOrdersIfNeeded();
    loadMoreFbaReplenishmentsIfNeeded();
    loadMoreUsersIfNeeded();
    loadMoreAuditIfNeeded();
    loadMoreStocktakeTasksIfNeeded();
  });

  const myAuditCard = document.querySelector("#myAuditModal .modal-card");
  if (myAuditCard) {
    myAuditCard.addEventListener("scroll", () => {
      loadMoreMyAuditIfNeeded();
    });
  }

  const shelfManageTableWrap = $("shelfManageTableWrap");
  if (shelfManageTableWrap) {
    shelfManageTableWrap.addEventListener("scroll", () => {
      loadMoreShelvesManageIfNeeded();
    });
  }

  const boxManageTableWrap = $("boxManageTableWrap");
  if (boxManageTableWrap) {
    boxManageTableWrap.addEventListener("scroll", () => {
      loadMoreBoxesManageIfNeeded();
    });
  }
}

function bindRefresh() {
  $("refreshOverviewDashboard").addEventListener("click", () =>
    loadOverviewDashboard().catch((error) => showToast(error.message, true)),
  );
  $("runDataBackupBtn").addEventListener("click", async (event) => {
    try {
      await runDataBackupNow(event.currentTarget);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("refreshDataBackup").addEventListener("click", () =>
    loadDataBackups().catch((error) => showToast(error.message, true)),
  );
  $("downloadInventorySkuSummaryBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "荳玖ｽｽ荳ｭ...", async () => {
        await downloadInventorySkuSummaryCsv();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("refreshInventory").addEventListener("click", () => loadInventory().catch((error) => showToast(error.message, true)));
  $("refreshOverseasWarehouse").addEventListener("click", () =>
    Promise.all([loadShelves(), loadBoxes()]).catch((error) => showToast(error.message, true)),
  );
  $("refreshProductManagement").addEventListener("click", () =>
    Promise.all([
      loadShelves(),
      loadBoxes(),
      loadInventory(),
      loadBrands(),
      loadSkuTypes(),
      loadShops(),
      loadProductEditRequests(),
      loadProductEditPendingSummary(),
    ]).catch((error) =>
      showToast(error.message, true),
    ),
  );
  $("refreshUsers").addEventListener("click", () =>
    Promise.all([loadUsers(), loadUserOptions()]).catch((error) => showToast(error.message, true)),
  );
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((error) => showToast(error.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((error) => showToast(error.message, true)));
  $("refreshBatchInbound").addEventListener("click", () =>
    loadBatchInboundOrders().catch((error) => showToast(error.message, true)),
  );
  $("refreshFbaReplenishment").addEventListener("click", () =>
    Promise.all([loadFbaReplenishments(), loadFbaPendingSummary()]).catch((error) =>
      showToast(error.message, true),
    ),
  );
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => showToast(error.message, true)));
}

ensureBrandingUi();
ensureInventoryPanelUi();
ensureOverseasWarehouseQueryUi();
renderStocktakePlanner();
bindTabs();
bindInputRules();
bindForms();
bindDelegates();
bindScrollLoad();
bindRefresh();
updateFbaOutboundButtonState();
updateFbaSelectAll();
switchPanel("inventory");
reloadAll().catch((error) => showToast(error.message, true));

