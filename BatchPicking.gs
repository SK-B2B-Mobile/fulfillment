/******************************************************
 * BatchPicking.gs — 총량피킹 신규 모듈
 * ------------------------------------------------------
 * 기존 Code.gs(doGet/doPost, Jobs/Settings 시트)는
 * 전혀 건드리지 않습니다. 이 파일은 완전히 새로 추가되는
 * 독립 모듈이며, 같은 스프레드시트(SS_ID)에 새 시트 5개를
 * 만들어서 사용합니다.
 *
 * doGet / doPost 에 아래 op들을 연결하려면
 * 이 파일 맨 아래 "연동 방법" 안내를 참고하세요.
 *
 * 새 op 목록:
 *   createBatch, getBatch, assignSlots,
 *   logScan, undoScan, completeBatch, getBatchKPI,
 *   logPickTiming, getSlotProgress,
 *   getScanState (★ 2026-07-09 신규 — 기기간 실시간 동기화용)
 ******************************************************/

const BATCHES_SHEET  = 'Batches';
const BCUST_SHEET    = 'BatchCustomers';
const BITEMS_SHEET   = 'BatchItems';
const SCANLOG_SHEET  = 'ScanLog';
const PICKTIME_SHEET = 'PickTiming';

function batchTz_() { return Session.getScriptTimeZone(); }
function batchNow_() { return Utilities.formatDate(new Date(), batchTz_(), 'yyyy-MM-dd HH:mm:ss'); }

function ensureBatchSheet_(name, headers) {
  const ss = ss_(); // 기존 Code.gs 의 ss_() 재사용 (SS_ID 스프레드시트)
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function batchesSheet_()  { return ensureBatchSheet_(BATCHES_SHEET,  ['BatchId','Date','Status','TotalSku','TotalQty','CreatedAt','CompletedAt']); }
function bcustSheet_()    { return ensureBatchSheet_(BCUST_SHEET,    ['BatchId','Invoice','Customer','ShipDate','ShipVia','TotalQty','TotalSku','SlotNum','SlotSize']); }
function bitemsSheet_()   { return ensureBatchSheet_(BITEMS_SHEET,   ['BatchId','Invoice','SKU','Name','Barcode','ReqQty','Rack']); }
function scanlogSheet_()  { return ensureBatchSheet_(SCANLOG_SHEET,  ['BatchId','ScanId','Timestamp','Worker','Barcode','SKU','Slot','Customer','Invoice','Result','Status']); }
function picktimeSheet_() { return ensureBatchSheet_(PICKTIME_SHEET, ['BatchId','Worker','PageRange','PickStart','PickEnd','DurationMinutes']); }

function generateBatchId_() {
  const datePart = Utilities.formatDate(new Date(), batchTz_(), 'yyyyMMdd');
  return 'B' + datePart + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
}

function _findBatchRow_(batchId) {
  const sh = batchesSheet_();
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(batchId)) return i + 2;
  }
  return 0;
}

/* ===================== ① createBatch =====================
 * 입력: { sumItems:[{sku,name,barcode,req_qty,rack}],
 *         customers:[{ meta:{invoice_no,customer,ship_date,ship_via}, items:[...] }] }
 * ============================================================ */
function createBatch(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const today = Utilities.formatDate(new Date(), batchTz_(), 'yyyy-MM-dd');
    const batchId = generateBatchId_();

    const sumItems = Array.isArray(data.sumItems) ? data.sumItems : [];
    const customers = Array.isArray(data.customers) ? data.customers : [];

    const totalSku = sumItems.length;
    const totalQty = sumItems.reduce((a, it) => a + (Number(it.req_qty) || 0), 0);

    const bSh = batchesSheet_();
    bSh.appendRow([batchId, today, 'active', totalSku, totalQty, batchNow_(), '']);
    bSh.getRange(bSh.getLastRow(), 2).setNumberFormat('@'); // Date 컬럼 텍스트 고정 (자동 날짜변환 방지)

    const bi = bitemsSheet_();
    if (sumItems.length) {
      const startRow = bi.getLastRow() + 1;
      const rows = sumItems.map(it => [batchId, '', it.sku||'', it.name||'', it.barcode||'', Number(it.req_qty)||0, it.rack||'']);
      bi.getRange(startRow, 5, rows.length, 1).setNumberFormat('@'); // ★ Barcode 컬럼(E) 텍스트 고정 — 자동 숫자변환 방지
      bi.getRange(startRow, 1, rows.length, 7).setValues(rows);
    }

    const bc = bcustSheet_();
    const custRows = [];
    const itemRows = [];
    customers.forEach(c => {
      const meta = c.meta || {};
      const items = Array.isArray(c.items) ? c.items : [];
      const cQty = items.reduce((a, it) => a + (Number(it.req_qty)||0), 0);
      custRows.push([batchId, meta.invoice_no||'', meta.customer||'', meta.ship_date||'', meta.ship_via||'', cQty, items.length, '', '']);
      items.forEach(it => {
        itemRows.push([batchId, meta.invoice_no||'', it.sku||'', it.name||'', it.barcode||'', Number(it.req_qty)||0, it.rack||'']);
      });
    });
    if (custRows.length) bc.getRange(bc.getLastRow()+1, 1, custRows.length, 9).setValues(custRows);
    if (itemRows.length) {
      const itemsSh = bitemsSheet_();
      const itemStartRow = itemsSh.getLastRow() + 1;
      itemsSh.getRange(itemStartRow, 5, itemRows.length, 1).setNumberFormat('@'); // ★ 여기도 동일하게 텍스트 고정
      itemsSh.getRange(itemStartRow, 1, itemRows.length, 7).setValues(itemRows);
    }

    bumpVersion_(); // 기존 Code.gs 함수 재사용
    return { ok: true, batchId: batchId, totalSku: totalSku, totalQty: totalQty };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ② getBatch =====================
 * batchId 없이 호출하면 → 오늘자 진행중(active) 배치 자동 탐색
 * (새로고침해도 이어서 작업 가능하게 하는 핵심 op)
 * ============================================================ */
function getBatch(batchId) {
  try {
    const bSh = batchesSheet_();
    let row = 0, resolvedId = batchId;

    if (!batchId) {
      const today = Utilities.formatDate(new Date(), batchTz_(), 'yyyy-MM-dd');
      const last = bSh.getLastRow();
      if (last >= 2) {
        const vals = bSh.getRange(2, 1, last - 1, 7).getValues();
        for (let i = vals.length - 1; i >= 0; i--) {
          let rowDateStr = vals[i][1];
          if (Object.prototype.toString.call(rowDateStr) === '[object Date]') {
            rowDateStr = Utilities.formatDate(rowDateStr, batchTz_(), 'yyyy-MM-dd');
          } else {
            rowDateStr = String(rowDateStr || '').slice(0, 10);
          }
          if (rowDateStr === today && vals[i][2] !== 'completed') {
            resolvedId = vals[i][0]; row = i + 2; break;
          }
        }
      }
      if (!row) return { ok: true, batch: null };
    } else {
      row = _findBatchRow_(batchId);
      if (!row) return { ok: false, error: 'batch not found' };
    }

    const bRow = bSh.getRange(row, 1, 1, 7).getValues()[0];
    const batch = {
      batchId: bRow[0], date: bRow[1], status: bRow[2],
      totalSku: bRow[3], totalQty: bRow[4], createdAt: bRow[5], completedAt: bRow[6]
    };

    const bc = bcustSheet_();
    const bcLast = bc.getLastRow();
    let customers = [];
    if (bcLast >= 2) {
      const rows = bc.getRange(2, 1, bcLast - 1, 9).getValues();
      customers = rows.filter(r => String(r[0]) === String(resolvedId)).map(r => ({
        invoice: r[1], customer: r[2], shipDate: r[3], shipVia: r[4],
        totalQty: r[5], totalSku: r[6], slotNum: r[7], slotSize: r[8]
      }));
    }

    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    let sumItems = [], custItemsMap = {};
    if (biLast >= 2) {
      const rows = bi.getRange(2, 1, biLast - 1, 7).getValues();
      rows.forEach(r => {
        if (String(r[0]) !== String(resolvedId)) return;
        const item = { sku:r[2], name:r[3], barcode:r[4], req_qty:r[5], rack:r[6] };
        if (!r[1]) { sumItems.push(item); }
        else {
          if (!custItemsMap[r[1]]) custItemsMap[r[1]] = [];
          custItemsMap[r[1]].push(item);
        }
      });
    }
    customers.forEach(c => { c.items = custItemsMap[c.invoice] || []; });

    return { ok: true, batch: batch, sumItems: sumItems, customers: customers };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== ③ assignSlots =====================
 * 입력: { batchId, assignments:[{invoice, slotNum, slotSize}] }
 * ============================================================ */
function assignSlots(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const batchId = data.batchId;
    const assignments = Array.isArray(data.assignments) ? data.assignments : [];
    if (!batchId) return { ok: false, error: 'batchId required' };

    const bc = bcustSheet_();
    const last = bc.getLastRow();
    if (last < 2) return { ok: false, error: 'no customers for this batch' };

    const rows = bc.getRange(2, 1, last - 1, 9).getValues();
    const map = {};
    assignments.forEach(a => { map[a.invoice] = a; });

    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) !== String(batchId)) continue;
      const a = map[rows[i][1]];
      if (!a) continue;
      bc.getRange(i + 2, 8).setValue(a.slotNum);
      bc.getRange(i + 2, 9).setValue(a.slotSize || (Number(a.slotNum) <= 15 ? 'L' : 'S'));
      updated++;
    }
    bumpVersion_();
    return { ok: true, updated: updated };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ④ logScan =====================
 * 입력: { batchId, worker, barcode, sku, slot, customer, invoice, result }
 * result: 'pass' | 'over' | 'error'
 * ============================================================ */
function logScan(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    if (!data.batchId) return { ok: false, error: 'batchId required' };
    const scanId = Utilities.getUuid();
    scanlogSheet_().appendRow([
      data.batchId, scanId, batchNow_(), data.worker || '', data.barcode || '',
      data.sku || '', data.slot || '', data.customer || '', data.invoice || '',
      data.result || 'pass', 'active'
    ]);
    return { ok: true, scanId: scanId };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ⑤ undoScan =====================
 * 입력: { scanId }
 * → 실제 삭제 대신 Status를 'undone' 으로 변경 (동시 스캔 중 안전)
 * ============================================================ */
function undoScan(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const scanId = data.scanId;
    if (!scanId) return { ok: false, error: 'scanId required' };
    const sh = scanlogSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'no scans' };
    const ids = sh.getRange(2, 2, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(scanId)) {
        sh.getRange(i + 2, 11).setValue('undone');
        return { ok: true };
      }
    }
    return { ok: false, error: 'scan not found' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ⑥ completeBatch =====================
 * 입력: { batchId }
 * ============================================================ */
function completeBatch(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const row = _findBatchRow_(data.batchId);
    if (!row) return { ok: false, error: 'batch not found' };
    batchesSheet_().getRange(row, 3).setValue('completed');
    batchesSheet_().getRange(row, 7).setValue(batchNow_());
    bumpVersion_();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ⑦ logPickTiming =====================
 * 설계도 KPI①(피킹시간) 기록용 — 원래 7개 op 목록엔 없었지만
 * PickTiming 시트를 실제로 채우려면 반드시 필요해서 추가함.
 * 입력: { batchId, worker, action:'start'|'end', pageRange }
 * ============================================================ */
function logPickTiming(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    if (!data.batchId || !data.worker) return { ok: false, error: 'batchId, worker required' };
    const sh = picktimeSheet_();

    if (data.action === 'start') {
      sh.appendRow([data.batchId, data.worker, data.pageRange || '', batchNow_(), '', '']);
      return { ok: true };
    }
    if (data.action === 'end') {
      const last = sh.getLastRow();
      if (last >= 2) {
        const rows = sh.getRange(2, 1, last - 1, 6).getValues();
        for (let i = rows.length - 1; i >= 0; i--) {
          if (String(rows[i][0]) === String(data.batchId) && String(rows[i][1]) === String(data.worker) && !rows[i][4]) {
            const endTs = batchNow_();
            const mins = Math.round((new Date(endTs) - new Date(rows[i][3])) / 60000);
            sh.getRange(i + 2, 5).setValue(endTs);
            sh.getRange(i + 2, 6).setValue(mins);
            return { ok: true, durationMinutes: mins };
          }
        }
      }
      return { ok: false, error: 'no open pick timing found' };
    }
    return { ok: false, error: "action must be 'start' or 'end'" };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ⑧ getBatchKPI =====================
 * KPI 3종: ①피킹+분류검수 시간 ②오류/지연(over/error) ③처리량
 * 입력: batchId (문자열)
 * ============================================================ */
function getBatchKPI(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };

    const pt = picktimeSheet_();
    const ptLast = pt.getLastRow();
    const pickByWorker = {};
    if (ptLast >= 2) {
      pt.getRange(2, 1, ptLast - 1, 6).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const w = r[1];
        if (!pickByWorker[w]) pickByWorker[w] = { worker: w, sessions: 0, totalMinutes: 0 };
        pickByWorker[w].sessions++;
        pickByWorker[w].totalMinutes += Number(r[5]) || 0;
      });
    }

    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const scanByWorker = {};
    let totalPass = 0, totalErr = 0, totalOver = 0;
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 11).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[10] === 'undone') return;
        const w = r[3], result = r[9];
        if (!scanByWorker[w]) scanByWorker[w] = { worker: w, pass: 0, over: 0, error: 0 };
        if (result === 'pass') { scanByWorker[w].pass++; totalPass++; }
        else if (result === 'over') { scanByWorker[w].over++; totalOver++; }
        else { scanByWorker[w].error++; totalErr++; }
      });
    }

    const row = _findBatchRow_(batchId);
    let batchInfo = null;
    if (row) {
      const bRow = batchesSheet_().getRange(row, 1, 1, 7).getValues()[0];
      batchInfo = { batchId: bRow[0], date: bRow[1], status: bRow[2], totalSku: bRow[3], totalQty: bRow[4], createdAt: bRow[5], completedAt: bRow[6] };
    }

    return {
      ok: true,
      batch: batchInfo,
      pickTiming: Object.values(pickByWorker),
      scanStats: Object.values(scanByWorker),
      totals: { pass: totalPass, over: totalOver, error: totalErr }
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== ⑨ getSlotProgress =====================
 * TV 현황판(board.html) 전용 — 슬롯별 완료 상태 계산
 * 각 고객사(=슬롯)마다 "필요 수량 대비 실제 통과 스캔 수"를 계산해서
 * waiting(대기) / active(진행중) / done(완료) 상태로 반환한다.
 * ★ 2026-07-10: 수량(QTY) 진행률뿐 아니라 "몇 개 상품(SKU)이 다 채워졌는지"
 *   (doneSku/totalSku)도 같이 계산해서 반환하도록 확장 — TV 화면에 QTY만
 *   나오고 SKU 개수가 안 보이던 문제 수정.
 * ============================================================ */
function getSlotProgress(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };

    // 고객사별 스캔 통과(pass) 수량 집계 (undone 제외) — 전체 QTY용, 그리고
    // invoice+바코드 조합별로도 따로 집계 — SKU 단위 완료 판정용
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const scannedByInvoice = {};
    const scannedByInvoiceBarcode = {};
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 11).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return; // over/error는 완료 카운트에 안 넣음
        const inv = r[8];
        scannedByInvoice[inv] = (scannedByInvoice[inv] || 0) + 1;
        const key = inv + '|' + String(r[4]);
        scannedByInvoiceBarcode[key] = (scannedByInvoiceBarcode[key] || 0) + 1;
      });
    }

    // 고객사별 "필요한 SKU 목록"을 읽어서 SKU 단위 완료 개수(doneSku/totalSku) 계산
    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    const skuStatsByInvoice = {}; // invoice -> {totalSku, doneSku}
    if (biLast >= 2) {
      bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const inv = r[1];
        if (!inv) return; // 총량 행(Invoice 빈값)은 제외 — 고객사 행만 집계
        if (!skuStatsByInvoice[inv]) skuStatsByInvoice[inv] = { totalSku: 0, doneSku: 0 };
        skuStatsByInvoice[inv].totalSku++;
        const reqQty = Number(r[5]) || 0;
        const scannedQty = scannedByInvoiceBarcode[inv + '|' + String(r[4])] || 0;
        if (reqQty > 0 && scannedQty >= reqQty) skuStatsByInvoice[inv].doneSku++;
      });
    }

    // 고객사별 슬롯 정보 + 목표 수량
    const bc = bcustSheet_();
    const bcLast = bc.getLastRow();
    const slots = [];
    if (bcLast >= 2) {
      bc.getRange(2, 1, bcLast - 1, 9).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (!r[7] && r[7] !== 0) return; // 슬롯 미배정이면 현황판에 안 띄움
        const invoice = r[1];
        const totalQty = Number(r[5]) || 0;
        const scanned = scannedByInvoice[invoice] || 0;
        const skuStat = skuStatsByInvoice[invoice] || { totalSku: Number(r[6]) || 0, doneSku: 0 };
        let status = 'waiting';
        if (scanned > 0 && scanned < totalQty) status = 'active';
        if (scanned >= totalQty && totalQty > 0) status = 'done';
        // ★ 매니저가 "임시A" 같은 문자 라벨로 수동 배정한 슬롯도 있을 수 있어
        //   숫자로 안 바뀌면 원래 값을 그대로 씀 (화면 정렬은 숫자만 우선순위로)
        const rawSlot = r[7];
        const numericSlot = Number(rawSlot);
        slots.push({
          slotNum: isNaN(numericSlot) ? rawSlot : numericSlot,
          slotSize: r[8], invoice: invoice,
          customer: r[2], shipVia: r[4], totalQty: totalQty,
          scanned: scanned, status: status,
          totalSku: skuStat.totalSku, doneSku: skuStat.doneSku
        });
      });
    }
    slots.sort((a, b) => {
      const an = Number(a.slotNum), bn = Number(b.slotNum);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return String(a.slotNum).localeCompare(String(b.slotNum));
    });

    const doneCount = slots.filter(s => s.status === 'done').length;
    return { ok: true, slots: slots, doneCount: doneCount, totalCount: slots.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== ⑩ getScanState (★ 2026-07-09 신규) =====================
 * 목적: 여러 기기(매니저 PC, 작업자 폰/태블릿)가 batch.html을 동시에 열어놓고
 *       스캔할 때, "다른 기기가 이미 스캔한 내용"을 이 op로 몇 초마다 다시
 *       가져와서 각자의 화면 상태(done 카운트, 최근 스캔 로그)를 서버 기준으로
 *       항상 덮어써서 동기화한다.
 *
 * 반환:
 *   doneMap: { "인보이스|바코드": 통과(pass) 스캔 누적 개수, ... }
 *            → 클라이언트가 sku.queue[].done 을 이 값으로 "항상 대입"하면
 *              어느 기기에서 스캔했든 모든 기기가 같은 진행률을 보게 됨.
 *   scans:   이 배치의 전체 스캔 이벤트 목록(undone 제외, 최신순),
 *            "최근 스캔"/"전체 로그" 화면을 모든 기기가 동일하게 보여주는 데 사용.
 * ================================================================== */
function getScanState(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };

    const sl = scanlogSheet_();
    const last = sl.getLastRow();
    const doneMap = {};
    const scans = [];

    if (last >= 2) {
      const rows = sl.getRange(2, 1, last - 1, 11).getValues();
      rows.forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[10] === 'undone') return; // 취소된 스캔은 진행률/로그에서 제외

        const ts = r[2];
        const timeStr = (Object.prototype.toString.call(ts) === '[object Date]' && !isNaN(ts))
          ? Utilities.formatDate(ts, batchTz_(), 'yyyy-MM-dd HH:mm:ss')
          : String(ts || '');

        scans.push({
          scanId: r[1], time: timeStr, worker: r[3], barcode: r[4],
          sku: r[5], slot: r[6], customer: r[7], invoice: r[8], result: r[9]
        });

        if (r[9] === 'pass' && r[8] && r[4]) {
          const key = r[8] + '|' + r[4]; // invoice|barcode
          doneMap[key] = (doneMap[key] || 0) + 1;
        }
      });
    }

    scans.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)); // 최신순

    return { ok: true, doneMap: doneMap, scans: scans };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== ⑪ getOpenBatches (★ 2026-07-10 신규) =====================
 * 목적: "오늘 날짜"가 아니어도, completeBatch()로 매니저가 명시적으로 완료 처리
 *       하지 않은 배치는 전부 보여준다. (예: 어제 배치를 완료 처리 안 하고
 *       퇴근했는데 다음날 열면 화면에서 조용히 사라지는 문제 — 데이터는 시트에
 *       그대로 있지만 매니저가 확인할 기회 없이 안 보이던 것을 고침)
 * 반환: 완료(status='completed') 안 된 배치 전부, 최신순, 대략적인 진행률 포함
 * ================================================================== */
function getOpenBatches() {
  try {
    const bSh = batchesSheet_();
    const last = bSh.getLastRow();
    if (last < 2) return { ok: true, batches: [] };

    const rows = bSh.getRange(2, 1, last - 1, 7).getValues();
    const open = [];
    rows.forEach(r => {
      const status = String(r[2] || '');
      if (status === 'completed') return;
      open.push({
        batchId: r[0], date: r[1], status: status,
        totalSku: r[3], totalQty: r[4], createdAt: r[5]
      });
    });
    if (!open.length) return { ok: true, batches: [] };

    // 배치별 대략적인 진행률(통과 스캔 수) 계산 — 얼마나 진행됐는지 매니저가 판단할 수 있게
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const passByBatch = {};
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 11).getValues().forEach(r => {
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return;
        const bid = String(r[0]);
        passByBatch[bid] = (passByBatch[bid] || 0) + 1;
      });
    }
    open.forEach(b => { b.scannedPass = passByBatch[String(b.batchId)] || 0; });

    // 최신 생성순
    open.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return { ok: true, batches: open };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* =====================================================
 * ★★★ 2026-07-10 신규 — 누적 테스트 데이터 정리 유틸리티 (v2, 고속) ★★★
 * ------------------------------------------------------
 * 이틀간 테스트하면서 배치를 5~6개나 만들었고, 그때마다 데이터가
 * Batches/BatchCustomers/BatchItems/ScanLog/PickTiming 같은 시트에
 * 계속 쌓여서 지금 수만 행까지 커진 상태다. getBatch()가 매번 이
 * 거대한 시트 전체를 읽어서 필터링하는데, 이 규모에서 가끔 데이터를
 * 놓치는 것으로 추정된다 (스캔하면 슬롯이 안 뜨는 문제의 유력 원인).
 *
 * ⚠ v1은 deleteRow()를 한 줄씩 반복 호출해서 행이 많으면(BatchItems
 *   수천~수만 행) 6분 실행시간 제한에 걸려 도중에 멈췄다. v2는 "지울
 *   행을 하나씩 지우기" 대신 "남길 행만 추려서 시트를 통째로 다시 쓰기"
 *   방식으로 바꿔서, 행이 몇만 개여도 몇 초 안에 끝난다.
 *
 * 사용법 (Apps Script 에디터에서 직접 실행, 웹앱 통해서 실행하는 게 아님):
 *   1) 아래 KEEP_BATCH_IDS 배열에 "남겨둘" 배치ID만 적는다
 *      (보통은 진짜로 지금 쓰고 있는 배치 1개만 남기면 됨)
 *   2) 함수 목록에서 cleanupOldBatchData 선택 → ▶ 실행
 *   3) 실행 후 Batches/BatchCustomers/BatchItems/ScanLog/PickTiming
 *      시트를 열어서, KEEP_BATCH_IDS에 없는 배치들의 행이 다 지워졌는지
 *      확인 (Logger.log에 몇 행 지웠는지 출력됨 — 실행 → 로그 보기)
 * ===================================================== */
function cleanupOldBatchData() {
  // 🔴 여기에 남길 배치ID만 적으세요. 나머지는 전부 삭제됩니다.
  const KEEP_BATCH_IDS = ['B20260710-D6A879']; // ← 실제로 계속 쓸 배치ID로 바꿔서 실행하세요

  const sheetsToClean = [
    { name: BATCHES_SHEET, get: batchesSheet_ },
    { name: BCUST_SHEET,   get: bcustSheet_   },
    { name: BITEMS_SHEET,  get: bitemsSheet_  },
    { name: SCANLOG_SHEET, get: scanlogSheet_ },
    { name: PICKTIME_SHEET,get: picktimeSheet_},
  ];

  sheetsToClean.forEach(({ name, get }) => {
    const sh = get();
    const last = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (last < 2) { Logger.log(name + ': 데이터 없음'); return; }

    const allRows = sh.getRange(2, 1, last - 1, lastCol).getValues();
    const keepRows = allRows.filter(r => KEEP_BATCH_IDS.indexOf(String(r[0])) !== -1);

    // 기존 데이터 영역을 통째로 비우고, 남길 행만 한 번에 다시 씀 (deleteRow 반복보다 훨씬 빠름)
    sh.getRange(2, 1, last - 1, lastCol).clearContent();
    if (keepRows.length > 0) {
      sh.getRange(2, 1, keepRows.length, lastCol).setValues(keepRows);
    }

    Logger.log(name + ': ' + (allRows.length - keepRows.length) + '행 삭제, ' + keepRows.length + '행 유지');
  });

  Logger.log('✅ 정리 완료 — 남긴 배치: ' + KEEP_BATCH_IDS.join(', '));
}

/* =====================================================
 * 테스트 함수 — 에디터에서 testBatchPickingFlow 선택 후 ▶ 실행
 * 시트 5개가 자동 생성되고, 더미 배치 1개가 만들어집니다.
 * ===================================================== */
function testBatchPickingFlow() {
  const created = createBatch({
    sumItems: [
      { sku:'TEST-001', name:'테스트 상품 A', barcode:'8809999999991', req_qty: 30, rack:'SK-A-1-01' },
      { sku:'TEST-002', name:'테스트 상품 B', barcode:'8809999999992', req_qty: 10, rack:'SK-A-1-02' }
    ],
    customers: [
      { meta:{invoice_no:'TEST0001', customer:'Test Customer A', ship_date:'2026-07-10', ship_via:'UPS'},
        items:[{sku:'TEST-001', name:'테스트 상품 A', barcode:'8809999999991', req_qty:20, rack:'SK-A-1-01'}] },
      { meta:{invoice_no:'TEST0002', customer:'Test Customer B', ship_date:'2026-07-10', ship_via:'PU'},
        items:[{sku:'TEST-001', name:'테스트 상품 A', barcode:'8809999999991', req_qty:10, rack:'SK-A-1-01'},
               {sku:'TEST-002', name:'테스트 상품 B', barcode:'8809999999992', req_qty:10, rack:'SK-A-1-02'}] }
    ]
  });
  Logger.log('createBatch: ' + JSON.stringify(created));
  const batchId = created.batchId;

  Logger.log('assignSlots: ' + JSON.stringify(assignSlots({
    batchId: batchId,
    assignments: [{invoice:'TEST0001', slotNum:1}, {invoice:'TEST0002', slotNum:2}]
  })));

  Logger.log('logPickTiming(start): ' + JSON.stringify(logPickTiming({batchId, worker:'Ryan', action:'start', pageRange:'1-5'})));
  Logger.log('logPickTiming(end): ' + JSON.stringify(logPickTiming({batchId, worker:'Ryan', action:'end'})));

  const scan1 = logScan({batchId, worker:'Jane', barcode:'8809999999991', sku:'TEST-001', slot:1, customer:'Test Customer A', invoice:'TEST0001', result:'pass'});
  Logger.log('logScan: ' + JSON.stringify(scan1));
  Logger.log('getScanState: ' + JSON.stringify(getScanState(batchId)));
  Logger.log('undoScan: ' + JSON.stringify(undoScan({scanId: scan1.scanId})));

  Logger.log('getBatch: ' + JSON.stringify(getBatch(batchId)));
  Logger.log('getBatchKPI: ' + JSON.stringify(getBatchKPI(batchId)));
  Logger.log('completeBatch: ' + JSON.stringify(completeBatch({batchId})));

  Logger.log('★ 테스트 데이터 정리하려면 Batches/BatchCustomers/BatchItems/ScanLog/PickTiming 시트에서 batchId="' + batchId + '" 행들을 수동 삭제하세요.');
}
