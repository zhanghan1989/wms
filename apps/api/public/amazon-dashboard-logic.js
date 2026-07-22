(function exposeAmazonDashboardLogic(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AmazonDashboardLogic = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAmazonDashboardLogic() {
  const FBA_TARGET_DAYS = 45;

  function text(value) {
    return String(value ?? "").trim();
  }

  function normalizeKey(value) {
    return text(value).toLowerCase();
  }

  function parseNumericValue(value) {
    const normalized = text(value)
      .replace(/[,\s]/g, "")
      .replace(/[￥¥$%]/g, "")
      .replace(/^JP/i, "");
    if (!normalized || normalized === "-" || normalized === "--") return 0;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }

  function parseCsvText(value) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const source = String(value || "").replace(/^\uFEFF/, "");

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (inQuotes) {
        if (char === '"' && next === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char !== "\r") {
        field += char;
      }
    }
    row.push(field);
    if (row.some((item) => text(item))) rows.push(row);

    const headers = (rows.shift() || []).map((header) => text(header).replace(/^\uFEFF/, ""));
    return rows
      .filter((item) => item.some((cell) => text(cell)))
      .map((values) =>
        headers.reduce((record, header, index) => {
          record[header || `column_${index + 1}`] = values[index] ?? "";
          return record;
        }, {}),
      );
  }

  function pickRecordValue(record, candidates) {
    for (const key of candidates) {
      if (Object.prototype.hasOwnProperty.call(record || {}, key)) return record[key];
    }
    const normalizedMap = new Map(
      Object.keys(record || {}).map((key) => [String(key).toLowerCase().replace(/[\s_-]/g, ""), key]),
    );
    for (const key of candidates) {
      const matched = normalizedMap.get(String(key).toLowerCase().replace(/[\s_-]/g, ""));
      if (matched) return record[matched];
    }
    return "";
  }

  function hasRecordHeader(records, candidates) {
    const firstRecord = (records || []).find((record) => record && Object.keys(record).length) || {};
    const headers = new Set(
      Object.keys(firstRecord).map((key) => String(key).toLowerCase().replace(/[\s_-]/g, "")),
    );
    return candidates.some((candidate) =>
      headers.has(String(candidate).toLowerCase().replace(/[\s_-]/g, "")),
    );
  }

  function validateUploadReportColumns(inventoryRecords, businessRecords) {
    const businessRequirements = [
      { label: "（子）ASIN", candidates: ["（子）ASIN", "(子)ASIN", "子ASIN", "Child ASIN"] },
      { label: "会话数 - 总计", candidates: ["会话数 - 总计", "会话数-总计", "Sessions - Total"] },
      {
        label: "页面浏览量 - 总计",
        candidates: ["页面浏览量 - 总计 ", "页面浏览量 - 总计", "页面浏览量-总计", "Page Views - Total"],
      },
      { label: "已订购商品数量", candidates: ["已订购商品数量", "Units Ordered"] },
    ];
    const inventoryRequirements = [
      { label: "SKU", candidates: ["sku", "SKU"] },
      { label: "FNSKU", candidates: ["FNSKU", "fnsku"] },
      { label: "ASIN", candidates: ["asin", "ASIN"] },
      { label: "可售库存", candidates: ["available", "可售库存", "可售"] },
      {
        label: "过去90天配送数量",
        candidates: ["配送商品数量（过去 90 天）", "过去 90 天内配送的售出商品"],
      },
    ];
    return {
      businessMissing: businessRequirements
        .filter((requirement) => !hasRecordHeader(businessRecords, requirement.candidates))
        .map((requirement) => requirement.label),
      inventoryMissing: inventoryRequirements
        .filter((requirement) => !hasRecordHeader(inventoryRecords, requirement.candidates))
        .map((requirement) => requirement.label),
    };
  }

  function hasNumericValue(value) {
    const normalized = text(value);
    return Boolean(normalized && normalized !== "-" && normalized !== "--");
  }

  function selectTotalOrParts(record, totalFields, partFields) {
    const totalValue = pickRecordValue(record, totalFields);
    if (hasNumericValue(totalValue)) return parseNumericValue(totalValue);
    return partFields.reduce((sum, fields) => sum + parseNumericValue(pickRecordValue(record, fields)), 0);
  }

  function normalizeInventoryRow(record) {
    const sales7 = parseNumericValue(
      pickRecordValue(record, ["配送商品数量（过去 7 天）", "过去 7 天内配送的售出商品"]),
    );
    const sales30 = parseNumericValue(
      pickRecordValue(record, ["配送商品数量（过去 30 天）", "过去 30 天内配送的售出商品"]),
    );
    const sales60 = parseNumericValue(
      pickRecordValue(record, ["配送商品数量（过去 60 天）", "过去 60 天内配送的售出商品"]),
    );
    const sales90 = parseNumericValue(
      pickRecordValue(record, ["配送商品数量（过去 90 天）", "过去 90 天内配送的售出商品"]),
    );
    const available = parseNumericValue(pickRecordValue(record, ["available", "可售库存", "可售"]));
    const inbound = selectTotalOrParts(record, ["入库数量"], [
      ["入库-处理中"],
      ["入库-已发出"],
      ["入库-已接收"],
    ]);
    const reserved = selectTotalOrParts(record, ["预留总数量"], [
      ["Reserved FC Transfer", "亚马逊运营中心转运"],
      ["Reserved FC Processing"],
      ["Reserved Customer Order"],
      ["Reserved Staging"],
    ]);
    const reportedSupplyValue = pickRecordValue(record, ["亚马逊物流库存供应", "FBA库存供应"]);
    const fbaSupplyQty = hasNumericValue(reportedSupplyValue)
      ? parseNumericValue(reportedSupplyValue)
      : Math.max(0, available + inbound);
    const age181To270 = parseNumericValue(pickRecordValue(record, ["库龄 181-270 天"]));
    const age271To365Value = pickRecordValue(record, ["库龄 271-365 天"]);
    const age271To365 = hasNumericValue(age271To365Value)
      ? parseNumericValue(age271To365Value)
      : parseNumericValue(pickRecordValue(record, ["库龄 331-365 天"])) +
        parseNumericValue(pickRecordValue(record, ["quantity-to-be-charged-ais-271-300-days"])) +
        parseNumericValue(pickRecordValue(record, ["quantity-to-be-charged-ais-301-330-days"]));
    const age365 = parseNumericValue(
      pickRecordValue(record, ["库龄 365 天以上", "quantity-to-be-charged-ais-365-plus-days"]),
    );
    const age270Plus = age271To365 + age365;
    const suggestedRemovalQty = parseNumericValue(pickRecordValue(record, ["建议移除数量"]));
    const removalSuggestedQty = Math.max(suggestedRemovalQty, age181To270 + age270Plus);
    const daily90 = sales90 > 0 ? sales90 / 90 : sales30 > 0 ? sales30 / 30 : sales7 > 0 ? sales7 / 7 : 0;
    const daily30 = sales30 > 0 ? sales30 / 30 : daily90;
    const coverageDays = daily30 > 0 ? available / daily30 : available > 0 ? 999 : 0;
    const suggestedShipQty = parseNumericValue(pickRecordValue(record, ["建议发货数量"]));
    const restockScore =
      suggestedShipQty > 0 ? 3 : daily30 > 0 && coverageDays <= 14 ? 2 : daily30 > 0 && coverageDays <= 30 ? 1 : 0;

    return {
      sku: text(pickRecordValue(record, ["sku", "SKU"])),
      fnsku: text(pickRecordValue(record, ["FNSKU", "fnsku"])),
      asin: text(pickRecordValue(record, ["asin", "ASIN"])),
      productName: text(pickRecordValue(record, ["商品名称", "product-name", "productName"])),
      snapshotDate: text(pickRecordValue(record, ["快照日期", "库龄快照日期"])),
      hasInventoryData: true,
      available,
      inbound,
      reserved,
      fbaSupplyQty,
      unsellable: parseNumericValue(pickRecordValue(record, ["不可售数量"])),
      age181To270,
      age270Plus,
      age365,
      age181Plus: age181To270 + age270Plus,
      suggestedRemovalQty,
      removalSuggestedQty,
      sales7,
      sales30,
      sales60,
      sales90,
      daily90,
      daily30,
      coverageDays,
      daysOfSupply: parseNumericValue(
        pickRecordValue(record, ["供货天数", "historical-days-of-supply", "总供货天数（包括未完成货件中的商品）"]),
      ),
      suggestedShipQty,
      suggestedShipDate: text(pickRecordValue(record, ["建议发货日期"])),
      sellThrough: parseNumericValue(pickRecordValue(record, ["售出率"])),
      price: parseNumericValue(pickRecordValue(record, ["您的价格", "推荐报价的价格"])),
      action: text(pickRecordValue(record, ["建议操作"])),
      restockScore,
      fbaTargetDays: FBA_TARGET_DAYS,
      fbaTargetQty: 0,
      fbaGapQty: 0,
      overseasStockQty: 0,
      overseasReplenishmentQty: 0,
      replenishmentPriority: "",
      businessSessions: 0,
      businessPageViews: 0,
      businessOrderedUnits: 0,
      businessOrderItems: 0,
      businessSalesAmount: 0,
      businessConversionPercent: 0,
      hasBusinessData: false,
      matchStatus: "unmatched",
      matchMode: "",
      matchedProductId: "",
      matchedProductName: "",
    };
  }

  function normalizeBusinessRow(record) {
    const asin = text(pickRecordValue(record, ["（子）ASIN", "(子)ASIN", "子ASIN", "Child ASIN"]));
    return {
      asin,
      parentAsin: text(pickRecordValue(record, ["（父）ASIN", "(父)ASIN", "父ASIN", "Parent ASIN"])),
      productName: text(pickRecordValue(record, ["标题", "商品名称", "Title"])),
      sessions: parseNumericValue(pickRecordValue(record, ["会话数 - 总计", "会话数-总计", "Sessions - Total"])),
      pageViews: parseNumericValue(
        pickRecordValue(record, ["页面浏览量 - 总计 ", "页面浏览量 - 总计", "页面浏览量-总计", "Page Views - Total"]),
      ),
      orderedUnits: parseNumericValue(pickRecordValue(record, ["已订购商品数量", "Units Ordered"])),
      orderItems: parseNumericValue(pickRecordValue(record, ["订单商品总数", "Total Order Items"])),
      salesAmount: parseNumericValue(pickRecordValue(record, ["已订购商品销售额", "Ordered Product Sales"])),
    };
  }

  function aggregateBusinessRows(records) {
    const map = new Map();
    for (const record of records || []) {
      const row = normalizeBusinessRow(record);
      const hasMetrics = row.sessions > 0 || row.pageViews > 0 || row.orderedUnits > 0 || row.salesAmount > 0;
      if (!row.asin || (!row.productName && !hasMetrics)) continue;
      const key = normalizeKey(row.asin);
      const current = map.get(key) || {
        asin: row.asin,
        parentAsins: [],
        productName: "",
        sessions: 0,
        pageViews: 0,
        orderedUnits: 0,
        orderItems: 0,
        salesAmount: 0,
        sourceRowCount: 0,
      };
      if (row.parentAsin && !current.parentAsins.includes(row.parentAsin)) current.parentAsins.push(row.parentAsin);
      if (!current.productName && row.productName) current.productName = row.productName;
      current.sessions += row.sessions;
      current.pageViews += row.pageViews;
      current.orderedUnits += row.orderedUnits;
      current.orderItems += row.orderItems;
      current.salesAmount += row.salesAmount;
      current.sourceRowCount += 1;
      map.set(key, current);
    }
    return [...map.values()].map((row) => ({
      ...row,
      conversionPercent: row.sessions > 0 ? (row.orderedUnits / row.sessions) * 100 : 0,
    }));
  }

  function emptyInventoryRowFromBusiness(row) {
    return {
      ...normalizeInventoryRow({ asin: row.asin, "商品名称": row.productName }),
      hasInventoryData: false,
    };
  }

  function attachBusinessData(row, business) {
    if (!business) return row;
    row.hasBusinessData = true;
    row.businessSessions = business.sessions;
    row.businessPageViews = business.pageViews;
    row.businessOrderedUnits = business.orderedUnits;
    row.businessOrderItems = business.orderItems;
    row.businessSalesAmount = business.salesAmount;
    row.businessConversionPercent = business.conversionPercent;
    row.businessSourceRowCount = business.sourceRowCount;
    row.parentAsins = business.parentAsins;
    if (!row.productName) row.productName = business.productName;
    return row;
  }

  function buildSystemIndexes(systemSkus) {
    const indexes = { sku: new Map(), fnsku: new Map(), asin: new Map() };
    for (const item of systemSkus || []) {
      for (const field of Object.keys(indexes)) {
        const key = normalizeKey(item?.[field]);
        if (!key) continue;
        if (!indexes[field].has(key)) indexes[field].set(key, []);
        indexes[field].get(key).push(item);
      }
    }
    return indexes;
  }

  function resolveSystemMatch(row, indexes) {
    const attempts = [
      ["sku", row.sku],
      ["fnsku", row.fnsku],
      ["asin", row.asin],
    ];
    for (const [mode, rawValue] of attempts) {
      const key = normalizeKey(rawValue);
      const candidates = key ? indexes[mode].get(key) || [] : [];
      if (!candidates.length) continue;
      const productIds = [...new Set(candidates.map((item) => text(item?.productId)).filter(Boolean))];
      if (productIds.length !== 1) {
        return { status: "ambiguous", mode, candidates, productId: "", productName: "" };
      }
      const matched = candidates.find((item) => text(item?.productId) === productIds[0]) || candidates[0];
      return {
        status: "matched",
        mode,
        candidates,
        productId: productIds[0],
        productName: text(matched?.productName),
        systemSku: text(matched?.sku),
        skuId: text(matched?.id),
      };
    }
    return { status: "unmatched", mode: "", candidates: [], productId: "", productName: "" };
  }

  function applySystemMatches(rows, systemSkus) {
    const indexes = buildSystemIndexes(systemSkus);
    for (const row of rows || []) {
      const match = resolveSystemMatch(row, indexes);
      row.matchStatus = match.status;
      row.matchMode = match.mode;
      row.matchCandidateCount = match.candidates.length;
      row.matchedProductId = match.productId;
      row.matchedProductName = match.productName;
      row.matchedSkuId = match.skuId || "";
      if (!row.sku && match.systemSku) row.sku = match.systemSku;
    }
    return rows;
  }

  function calculateOverseasReplenishment(
    row,
    overseasStockQty,
    pendingFbaQty = 0,
    reservedOverseasStockQty = pendingFbaQty,
  ) {
    const dailyDemand = Math.max(0, Number(row?.daily90 || 0));
    const amazonSupply = Math.max(0, Number(row?.fbaSupplyQty || 0));
    const targetQty = Math.ceil(dailyDemand * FBA_TARGET_DAYS);
    const calculatedGap = dailyDemand > 0 ? Math.max(0, targetQty - amazonSupply) : 0;
    const grossFbaGapQty = Math.ceil(Math.max(Number(row?.suggestedShipQty || 0), calculatedGap));
    const totalOverseasStock = Math.max(0, Number(overseasStockQty || 0));
    const activePendingFbaQty = Math.max(0, Number(pendingFbaQty || 0));
    const reservedStockQty = Math.max(0, Number(reservedOverseasStockQty || 0));
    const availableOverseasStock = Math.max(0, totalOverseasStock - reservedStockQty);
    const fbaGapQty = Math.max(0, grossFbaGapQty - activePendingFbaQty);
    const overseasReplenishmentQty = Math.min(fbaGapQty, availableOverseasStock);
    const overseasShortageQty = Math.max(0, fbaGapQty - overseasReplenishmentQty);
    const coverageDays = Number(row?.coverageDays || 0);
    let replenishmentPriority = "无需补货";
    if (overseasShortageQty > 0) {
      replenishmentPriority = "海外仓库存不足";
    } else if (fbaGapQty > 0 && coverageDays <= 14) {
      replenishmentPriority = "立即补货";
    } else if (fbaGapQty > 0) {
      replenishmentPriority = "计划补货";
    } else if (coverageDays <= FBA_TARGET_DAYS && dailyDemand > 0) {
      replenishmentPriority = "观察";
    }
    return {
      fbaSupplyQty: amazonSupply,
      fbaTargetQty: targetQty,
      grossFbaGapQty,
      fbaGapQty,
      overseasStockQty: totalOverseasStock,
      pendingFbaQty: activePendingFbaQty,
      overseasAvailableStockQty: availableOverseasStock,
      overseasReplenishmentQty,
      overseasShortageQty,
      replenishmentPriority,
    };
  }

  function recalculateAnalysis(analysis) {
    const rows = analysis?.rows || [];
    const inventoryRows = rows.filter((row) => row.hasInventoryData);
    const businessRows = rows.filter((row) => row.hasBusinessData);
    const totals = inventoryRows.reduce(
      (acc, row) => {
        acc.available += row.available;
        acc.inbound += row.inbound;
        acc.reserved += row.reserved;
        acc.unsellable += row.unsellable;
        acc.sales7 += row.sales7;
        acc.sales30 += row.sales30;
        acc.sales90 += row.sales90;
        acc.age365 += row.age365;
        acc.age181To270 += row.age181To270;
        acc.age270Plus += row.age270Plus;
        acc.removalQty += row.removalSuggestedQty;
        acc.restockQty += row.suggestedShipQty;
        if (row.available <= 0) acc.outOfStock += 1;
        if (row.age365 > 0) acc.agedSku += 1;
        if (row.age181To270 > 0 || row.age270Plus > 0 || row.removalSuggestedQty > 0) acc.removalSku += 1;
        if (row.restockScore > 0) acc.restockSku += 1;
        return acc;
      },
      {
        available: 0,
        inbound: 0,
        reserved: 0,
        unsellable: 0,
        sales7: 0,
        sales30: 0,
        sales90: 0,
        age365: 0,
        age181To270: 0,
        age270Plus: 0,
        removalQty: 0,
        restockQty: 0,
        outOfStock: 0,
        agedSku: 0,
        removalSku: 0,
        restockSku: 0,
      },
    );
    totals.businessAsinCount = businessRows.length;
    totals.businessSessions = businessRows.reduce((sum, row) => sum + row.businessSessions, 0);
    totals.businessPageViews = businessRows.reduce((sum, row) => sum + row.businessPageViews, 0);
    totals.businessOrderedUnits = businessRows.reduce((sum, row) => sum + row.businessOrderedUnits, 0);
    totals.businessOrderItems = businessRows.reduce((sum, row) => sum + row.businessOrderItems, 0);
    totals.businessSalesAmount = businessRows.reduce((sum, row) => sum + row.businessSalesAmount, 0);
    totals.businessConversionPercent =
      totals.businessSessions > 0 ? (totals.businessOrderedUnits / totals.businessSessions) * 100 : 0;
    totals.matchedRows = rows.filter((row) => row.matchStatus === "matched").length;
    totals.ambiguousRows = rows.filter((row) => row.matchStatus === "ambiguous").length;
    totals.unmatchedRows = rows.filter((row) => row.matchStatus === "unmatched").length;
    totals.inventorySkuCount = inventoryRows.length;

    analysis.totals = totals;
    analysis.salesRows = [...rows]
      .filter((row) => row.hasBusinessData || row.sales90 > 0 || row.sales30 > 0 || row.sales7 > 0)
      .sort(
        (a, b) =>
          b.businessOrderedUnits - a.businessOrderedUnits ||
          b.businessSalesAmount - a.businessSalesAmount ||
          b.sales90 - a.sales90,
      )
      .slice(0, 30);
    analysis.inventoryRows = [...inventoryRows]
      .sort((a, b) => b.available - a.available || b.inbound - a.inbound)
      .slice(0, 30);
    analysis.replenishmentRows = [...inventoryRows]
      .filter((row) => row.restockScore > 0 || row.suggestedShipQty > 0)
      .sort((a, b) => b.restockScore - a.restockScore || b.suggestedShipQty - a.suggestedShipQty || b.daily30 - a.daily30)
      .slice(0, 30);
    analysis.removalRows = [...inventoryRows]
      .filter((row) => row.age181To270 > 0 || row.age270Plus > 0 || row.removalSuggestedQty > 0)
      .sort(
        (a, b) =>
          b.age270Plus - a.age270Plus ||
          b.removalSuggestedQty - a.removalSuggestedQty ||
          b.age181To270 - a.age181To270 ||
          b.age365 - a.age365,
      )
      .slice(0, 30);
    return analysis;
  }

  function buildAnalysis(inventoryRecords, businessRecords, systemSkus) {
    const businessRows = aggregateBusinessRows(businessRecords);
    const businessByAsin = new Map(businessRows.map((row) => [normalizeKey(row.asin), row]));
    const usedBusinessAsins = new Set();
    const rows = (inventoryRecords || [])
      .map(normalizeInventoryRow)
      .filter((row) => row.sku || row.asin || row.productName)
      .map((row) => {
        const key = normalizeKey(row.asin);
        const business = key && !usedBusinessAsins.has(key) ? businessByAsin.get(key) : null;
        if (business) usedBusinessAsins.add(key);
        return attachBusinessData(row, business);
      });

    for (const business of businessRows) {
      const key = normalizeKey(business.asin);
      if (usedBusinessAsins.has(key)) continue;
      rows.push(attachBusinessData(emptyInventoryRowFromBusiness(business), business));
    }

    applySystemMatches(rows, systemSkus);
    return recalculateAnalysis({
      rows,
      totals: {},
      snapshotDate: rows.find((row) => row.snapshotDate)?.snapshotDate || "",
      source: {
        inventoryRowCount: (inventoryRecords || []).length,
        businessSourceRowCount: (businessRecords || []).length,
        businessAsinCount: businessRows.length,
        joinedAsinCount: usedBusinessAsins.size,
      },
    });
  }

  return {
    FBA_TARGET_DAYS,
    aggregateBusinessRows,
    applySystemMatches,
    buildAnalysis,
    calculateOverseasReplenishment,
    normalizeInventoryRow,
    parseCsvText,
    parseNumericValue,
    recalculateAnalysis,
    validateUploadReportColumns,
  };
});
