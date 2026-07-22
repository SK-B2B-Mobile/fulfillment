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
const ISSUELOG_SHEET = 'IssueLog'; // ★ 2026-07-16 신규 — EXP/NF/Damaged/OOS 등 고객사별 이슈 등록
const BWORKERS_SHEET = 'BatchWorkers'; // ★ 2026-07-16 신규 — 총량피킹 "작업자 관리" 명단 서버 저장용

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
function bcustSheet_()    { return ensureBatchSheet_(BCUST_SHEET,    ['BatchId','Invoice','Customer','ShipDate','ShipVia','TotalQty','TotalSku','SlotNum','SlotSize','Cleared']); }
function bitemsSheet_()   { return ensureBatchSheet_(BITEMS_SHEET,   ['BatchId','Invoice','SKU','Name','Barcode','ReqQty','Rack']); }
function scanlogSheet_()  { return ensureBatchSheet_(SCANLOG_SHEET,  ['BatchId','ScanId','Timestamp','Worker','Barcode','SKU','Slot','Customer','Invoice','Result','Status','Qty']); }
function picktimeSheet_() { return ensureBatchSheet_(PICKTIME_SHEET, ['BatchId','Worker','PageRange','PickStart','PickEnd','DurationMinutes']); }
// ★ 2026-07-16 신규: 고객사(Invoice) 하나에 대해 등록된 이슈 한 건 = 한 행
function issuelogSheet_() { return ensureBatchSheet_(ISSUELOG_SHEET, ['BatchId','IssueId','Timestamp','Worker','Barcode','SKU','Name','Invoice','Customer','Reason','Qty','Note','Status']); }
// ★ 2026-07-16 신규: 작업자 명단 — Id/Name/Status 한 명당 한 행. batch.html의 로컬 하드코딩을 대체.
function bworkersSheet_() { return ensureBatchSheet_(BWORKERS_SHEET, ['Id','Name','Status']); }

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
      custRows.push([batchId, meta.invoice_no||'', meta.customer||'', meta.ship_date||'', meta.ship_via||'', cQty, items.length, '', '', '']);
      items.forEach(it => {
        itemRows.push([batchId, meta.invoice_no||'', it.sku||'', it.name||'', it.barcode||'', Number(it.req_qty)||0, it.rack||'']);
      });
    });
    if (custRows.length) bc.getRange(bc.getLastRow()+1, 1, custRows.length, 10).setValues(custRows);
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
      const rows = bc.getRange(2, 1, bcLast - 1, 10).getValues();
      customers = rows.filter(r => String(r[0]) === String(resolvedId)).map(r => ({
        invoice: r[1], customer: r[2], shipDate: r[3], shipVia: r[4],
        totalQty: r[5], totalSku: r[6], slotNum: r[7], slotSize: r[8], cleared: r[9] || ''
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

    const rows = bc.getRange(2, 1, last - 1, 10).getValues();
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

/* ===================== ③b clearSlot (★ 2026-07-14 신규) =====================
 * "패킹완료·슬롯비우기" 버튼 — 그 고객사분이 실제로 패킹팀에 넘어가서 물리적으로
 * 자리가 빈 시점에 눌러야 함. 시스템이 "완료(done)"라고 판정한 것과 실물이
 * 진짜 빠진 것은 다를 수 있어서, 완료 안 된 슬롯은 절대 못 비우게 안전장치를 둠.
 * 입력: { batchId, invoice }
 * ============================================================ */
function clearSlot(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const batchId = data.batchId, invoice = data.invoice;
    if (!batchId || !invoice) return { ok: false, error: 'batchId, invoice required' };

    // 안전장치: 정말로 완료(수량 100%)됐는지 재확인 없이 그냥 비우면, 아직
    // 스캔 안 끝난 자리를 실수로 다음 배치에 내줄 위험이 있음
    const sp = getSlotProgress(batchId);
    if (!sp.ok) return { ok: false, error: '슬롯 상태 확인 실패: ' + sp.error };
    const slot = sp.slots.find(s => String(s.invoice) === String(invoice));
    if (!slot) return { ok: false, error: '해당 슬롯을 찾을 수 없습니다' };
    if (slot.status !== 'done') {
      return { ok: false, error: '아직 완료되지 않은 슬롯은 비울 수 없습니다 (' + slot.scanned + '/' + slot.totalQty + ')' };
    }

    const bc = bcustSheet_();
    const last = bc.getLastRow();
    const rows = bc.getRange(2, 1, last - 1, 10).getValues();
    let found = false;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) !== String(batchId)) continue;
      if (String(rows[i][1]) !== String(invoice)) continue;
      bc.getRange(i + 2, 10).setValue(batchNow_());
      found = true;
      break;
    }
    if (!found) return { ok: false, error: '해당 고객사 행을 찾지 못했습니다' };

    // ★ 2026-07-14 신규 — 슬롯이 비워지는 즉시, 다른 진행 중인 배치(보통 오늘
    //   배치)의 미배정 대기 고객사 중 이 슬롯 크기에 맞는 곳을 자동으로 채움.
    //   1~16번(대량 고정 렉)이 비면 대기 중 SKU/수량이 가장 큰 고객사를,
    //   17~30번(무빙카트/소량)이 비면 가장 작은 고객사를 매칭해서 — 작은
    //   오더가 대량 렉에 잘못 들어가는 걸 방지함. 매니저는 필요하면 언제든
    //   드래그로 수동 재배치 가능(자동배정은 되돌릴 수 있는 기본값일 뿐).
    const clearedSlotNum = rows.find((r,i) => String(r[0])===String(batchId) && String(r[1])===String(invoice))[7];
    const numSlot = Number(clearedSlotNum);
    const sizeClass = (!isNaN(numSlot) && numSlot >= 1 && numSlot <= 16) ? 'L'
                     : (!isNaN(numSlot) && numSlot >= 17 && numSlot <= 30) ? 'S' : null;

    let autoFilled = null;
    if (sizeClass) {
      const bSh = batchesSheet_();
      const bLast = bSh.getLastRow();
      const openBatches = []; // {batchId, createdAt}
      if (bLast >= 2) {
        bSh.getRange(2, 1, bLast - 1, 7).getValues().forEach(r => {
          if (String(r[2] || '') !== 'completed') openBatches.push({ batchId: String(r[0]), createdAt: String(r[5]) });
        });
      }
      openBatches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // 최신 생성 배치 우선

      const rows2 = bc.getRange(2, 1, bc.getLastRow() - 1, 10).getValues();
      for (const ob of openBatches) {
        // 이 배치의 "아직 슬롯 미배정" 대기 고객사만 후보로
        const waiting = [];
        for (let i = 0; i < rows2.length; i++) {
          if (String(rows2[i][0]) !== ob.batchId) continue;
          if (rows2[i][7] || rows2[i][7] === 0) continue; // 이미 슬롯 배정된 건 제외
          waiting.push({ rowIdx: i, invoice: rows2[i][1], customer: rows2[i][2], totalQty: Number(rows2[i][5])||0, totalSku: Number(rows2[i][6])||0 });
        }
        if (!waiting.length) continue; // 이 배치엔 대기 고객사 없음 → 다음 배치 확인

        // 사이즈에 맞는 후보 선택: L이면 SKU/수량 큰 순, S면 작은 순
        waiting.sort((a, b) => sizeClass === 'L'
          ? (b.totalSku - a.totalSku) || (b.totalQty - a.totalQty)
          : (a.totalSku - b.totalSku) || (a.totalQty - b.totalQty));
        const pick = waiting[0];

        bc.getRange(pick.rowIdx + 2, 8).setValue(clearedSlotNum);
        bc.getRange(pick.rowIdx + 2, 9).setValue(sizeClass);
        autoFilled = { batchId: ob.batchId, invoice: pick.invoice, customer: pick.customer, slotNum: clearedSlotNum, sizeClass };
        break;
      }
    }

    bumpVersion_();
    return { ok: true, autoFilled: autoFilled };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ③c getOccupiedSlots (★ 2026-07-14 신규) =====================
 * 완료 처리 안 된(활성 상태) 모든 배치를 통틀어, 아직 "비워지지" 않은
 * 슬롯 번호 전체를 반환. 새 배치를 만들 때 이 목록을 피해서 자동배정하기 위함
 * (어제 배치가 아직 안 끝났는데 오늘 배치가 같은 슬롯 번호를 또 쓰는 사고 방지).
 * 입력: 없음 (오늘/이전 날짜 상관없이 완료 처리 안 된 배치 전부 대상)
 * ============================================================ */
function getOccupiedSlots() {
  try {
    const bSh = batchesSheet_();
    const bLast = bSh.getLastRow();
    const openBatchIds = {};
    if (bLast >= 2) {
      bSh.getRange(2, 1, bLast - 1, 7).getValues().forEach(r => {
        if (String(r[2] || '') !== 'completed') openBatchIds[String(r[0])] = String(r[1]);
      });
    }
    if (!Object.keys(openBatchIds).length) return { ok: true, occupied: [] };

    const bc = bcustSheet_();
    const bcLast = bc.getLastRow();
    const occupied = [];
    if (bcLast >= 2) {
      bc.getRange(2, 1, bcLast - 1, 10).getValues().forEach(r => {
        const batchId = String(r[0]);
        if (!(batchId in openBatchIds)) return;
        if (!r[7] && r[7] !== 0) return; // 슬롯 미배정
        if (r[9]) return; // 이미 비워짐(Cleared 값 있음) → 재사용 가능하니 목록에서 제외
        occupied.push({
          slotNum: r[7], batchId: batchId, batchDate: openBatchIds[batchId],
          customer: r[2], invoice: r[1],
        });
      });
    }
    return { ok: true, occupied: occupied };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== ③d autoClearStaleDoneSlots (★ 2026-07-14 신규) =====================
 * "패킹완료·슬롯비우기" 버튼을 깜빡했을 때 대비한 안전망. 매일 새벽 자정에
 * Apps Script 트리거로 자동 실행되도록 설정 (아래 안내 참고).
 * 규칙: 완료(done)됐고 + 그 배치 날짜가 "오늘"이 아닌(=밤새 지난) 슬롯만 자동으로 비움.
 *   같은 날 안에서는 절대 자동으로 안 비움 (패킹팀이 아직 못 치웠을 수 있어서) —
 *   반드시 하룻밤 지난 것만 안전하게 자동 처리.
 *
 * ★ Apps Script 트리거 등록 방법 (직접 한번만 설정하면 매일 자동 실행됨):
 *   1) Apps Script 에디터 왼쪽 시계 아이콘(트리거) 클릭
 *   2) 우측 하단 "트리거 추가" 클릭
 *   3) 실행할 함수: autoClearStaleDoneSlots 선택
 *   4) 이벤트 소스: "시간 기반" 선택
 *   5) 시간 기반 트리거 유형: "일 타이머" 선택
 *   6) 시간대: "오전 12시~오전 1시" 선택 (자정 직후)
 *   7) 저장
 * ============================================================ */
function autoClearStaleDoneSlots() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const today = Utilities.formatDate(new Date(), batchTz_(), 'yyyy-MM-dd');
    const bSh = batchesSheet_();
    const bLast = bSh.getLastRow();
    const openBatchDates = {}; // batchId -> date, 완료처리 안 된 배치만
    if (bLast >= 2) {
      bSh.getRange(2, 1, bLast - 1, 7).getValues().forEach(r => {
        if (String(r[2] || '') !== 'completed') openBatchDates[String(r[0])] = String(r[1]);
      });
    }

    const bc = bcustSheet_();
    const bcLast = bc.getLastRow();
    if (bcLast < 2) return;
    const rows = bc.getRange(2, 1, bcLast - 1, 10).getValues();

    let clearedCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const batchId = String(rows[i][0]);
      if (!(batchId in openBatchDates)) continue;
      if (openBatchDates[batchId] === today) continue; // 오늘 생성된 배치는 자동 비움 대상 아님 (하룻밤 지난 것만)
      if (!rows[i][7] && rows[i][7] !== 0) continue; // 슬롯 미배정
      if (rows[i][9]) continue; // 이미 비워짐

      const sp = getSlotProgress(batchId);
      if (!sp.ok) continue;
      const slot = sp.slots.find(s => String(s.invoice) === String(rows[i][1]));
      if (!slot || slot.status !== 'done') continue; // 완료된 것만 자동 비움 대상

      bc.getRange(i + 2, 10).setValue('auto:' + batchNow_());
      clearedCount++;
    }
    if (clearedCount) bumpVersion_();
    Logger.log('autoClearStaleDoneSlots: ' + clearedCount + '개 슬롯 자동 비움');
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
      data.result || 'pass', 'active', Number(data.qty) || 1
      // ★ 2026-07-13: '스캔 1번 = 낱개 1개'가 아니라 '스캔 1번 = 그 순간 배정된
      //   고객사가 필요한 수량 전체를 분류 완료'로 워크플로우를 변경함에 따라
      //   추가된 컬럼. 총량피킹에서 스캔의 목적은 개수 검수가 아니라 "이 상품을
      //   어느 고객사로 보낼지 분류"하는 것이므로, 스캔 1번에 여러 개가 한번에
      //   해당 고객사 몫으로 카운트되어야 함.
    ]);
    return { ok: true, scanId: scanId };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ④-2 logIssue (★ 2026-07-16 신규) =====================
 * 목적: EXP(유통기한)/NF(재고없음)/DMG(파손)/OOS(품절) 등의 사유로
 *       "특정 고객사 주문 한 건"에 대해 필요수량 일부(또는 전량)를
 *       채워줄 수 없을 때 등록. 등록된 수량만큼 그 고객사의 완료 판정
 *       기준(totalQty)에서 빠지므로, 나머지가 다 채워지면 정상적으로
 *       "완료"로 표시된다. (배치 전체 공용이 아니라 invoice 단위로 귀속됨 —
 *       같은 SKU를 여러 고객사가 나눠 가질 때 손상분을 어느 고객사 순서로
 *       배분했는지는 작업자가 직접 판단해서 각 카드별로 등록.)
 * 입력: { batchId, worker, barcode, sku, name, invoice, customer, reason, qty, note }
 * ============================================================ */
function logIssue(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    if (!data.batchId) return { ok: false, error: 'batchId required' };
    if (!data.invoice) return { ok: false, error: 'invoice required' };
    const qty = Number(data.qty) || 0;
    if (qty <= 0) return { ok: false, error: 'qty must be > 0' };
    const issueId = Utilities.getUuid();
    issuelogSheet_().appendRow([
      data.batchId, issueId, batchNow_(), data.worker || '',
      data.barcode || '', data.sku || '', data.name || '',
      data.invoice, data.customer || '', data.reason || 'ETC',
      qty, data.note || '', 'active'
    ]);
    bumpVersion_();
    return { ok: true, issueId: issueId };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ④-3 undoIssue (★ 2026-07-16 신규) =====================
 * 잘못 등록한 이슈를 취소 (삭제 대신 Status를 'undone'으로 변경)
 * 입력: { issueId }
 * ============================================================ */
function undoIssue(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const issueId = data.issueId;
    if (!issueId) return { ok: false, error: 'issueId required' };
    const sh = issuelogSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'no issues' };
    const ids = sh.getRange(2, 2, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(issueId)) {
        sh.getRange(i + 2, 13).setValue('undone');
        bumpVersion_();
        return { ok: true };
      }
    }
    return { ok: false, error: 'issue not found' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ④-4 editIssue (★ 2026-07-22 신규) =====================
 * 목적: 잘못 등록한 이슈를 "취소"하는 게 아니라, 사유/수량/메모를 그 자리에서
 *       직접 고쳐서 저장. (undoIssue는 완전히 무효화만 시키는 것이고, 이건
 *       "287pcs를 87pcs로 고친다" 같은 실제 수정 요청에 맞는 기능.)
 * 입력: { issueId, reason, qty, note }
 * ============================================================ */
function editIssue(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const issueId = data.issueId;
    if (!issueId) return { ok: false, error: 'issueId required' };
    const qty = Number(data.qty) || 0;
    if (qty <= 0) return { ok: false, error: 'qty must be > 0' };
    const sh = issuelogSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'no issues' };
    const ids = sh.getRange(2, 2, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(issueId)) {
        const row = i + 2;
        sh.getRange(row, 10).setValue(data.reason || 'ETC'); // J: Reason
        sh.getRange(row, 11).setValue(qty);                  // K: Qty
        sh.getRange(row, 12).setValue(data.note || '');      // L: Note
        bumpVersion_();
        return { ok: true };
      }
    }
    return { ok: false, error: 'issue not found' };
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
      // ★ 2026-07-22 신규: 두 기기에서 거의 동시에 같은 작업자로 "피킹 시작"을
      //   누르는 경합 상황을 서버단에서 완전히 차단 — 이미 종료 안 된(진행중인)
      //   세션이 있으면 새로 시작하지 못하게 막음. LockService로 감싸져 있어
      //   이 체크와 appendRow 사이에 다른 요청이 끼어들 수 없음(원자적 처리).
      const last0 = sh.getLastRow();
      if (last0 >= 2) {
        const rows0 = sh.getRange(2, 1, last0 - 1, 6).getValues();
        for (let i = 0; i < rows0.length; i++) {
          const hasEnd = (rows0[i][4] !== '' && rows0[i][4] !== null && rows0[i][4] !== undefined);
          if (String(rows0[i][0]) === String(data.batchId) && String(rows0[i][1]) === String(data.worker) && !hasEnd) {
            return { ok: false, error: 'already_picking', startedAt: rows0[i][3] };
          }
        }
      }
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

/* ===================== ⑦-2 getActivePickers (★ 2026-07-22 신규) =====================
 * 목적: "지금 이 순간 피킹 중인 작업자가 누구누구인지"를 기기 간에 공유해서,
 *       한 사람이 이미 피킹 시작한 걸 다른 기기에서도 "ON"으로 보고 그 사람을
 *       중복으로 선택 못 하게 하기 위함. PickTiming 시트에서 "시작은 있는데
 *       종료가 없는" 줄을 찾으면 그게 지금 피킹 중이라는 뜻.
 * 안전장치: 실수로 "피킹 종료"를 안 누르고 꺼버린 경우 그 사람이 영원히
 *       "ON"으로 묶여버리는 걸 막기 위해, 시작한 지 4시간 넘으면 자동으로
 *       무시함(끄는 걸 깜빡한 걸로 간주).
 * 반환: { ok:true, active: { "작업자명": "14:02" (시작시각), ... } }
 * ============================================================ */
function getActivePickers(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };
    const sh = picktimeSheet_();
    const last = sh.getLastRow();
    const active = {};
    const STALE_MS = 4 * 60 * 60 * 1000; // 4시간
    const nowMs = Date.now();
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 6).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const worker = r[1];
        const startTs = r[3], endTs = r[4];
        const hasStart = (Object.prototype.toString.call(startTs) === '[object Date]' && !isNaN(startTs));
        const hasEnd = (endTs !== '' && endTs !== null && endTs !== undefined);
        if (hasStart && !hasEnd) {
          const age = nowMs - startTs.getTime();
          if (age < STALE_MS) {
            active[worker] = Utilities.formatDate(startTs, batchTz_(), 'HH:mm');
          }
        }
      });
    }
    return { ok: true, active: active };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== ⑧ getBatchKPI (★ 2026-07-16 개편) =====================
 * KPI 2종:
 *  ① 피킹 세션 목록 — 세션(시작~종료) 한 건당 한 줄. 작업자/담당페이지/
 *     시작시각/종료시각/소요시간과 함께, 그 시간대에 그 작업자 이름으로
 *     실제 스캔·분류 완료(pass)된 SKU 개수(distinct)/PCS 합계를 계산해
 *     "이 사람이 그 시간 동안 실제로 얼마나 처리했는지"를 보여준다.
 *     ※ 전제: 피킹한 사람과 스캔한 사람이 동일인(또는 그 시간대 담당자가
 *       일치)이라고 가정. 담당 페이지(pageRange)는 참고용 메모일 뿐 실제
 *       SKU/PCS 계산에는 쓰이지 않음 — PDF 파싱 단계에서 페이지-SKU
 *       매핑이 저장되지 않아 계산 불가능하기 때문.
 *  ② 작업자별 분류·검수 현황 — Pass 건수 + 이슈(EXP/NF/Damaged/OOS) 건수·수량.
 *     예전엔 Over/Error(오조작성 스캔)를 보여줬는데, 작업자 평가에 의미가
 *     적어서 실제 재고/품질 이슈 쪽으로 교체함.
 * 입력: batchId (문자열)
 * ============================================================ */
function getBatchKPI(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };

    // 이 배치의 pass 스캔 전체를 먼저 한 번에 읽어둔다 (세션별 SKU/PCS 계산과
    // 작업자별 Pass 집계 양쪽에서 재사용)
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const passScans = []; // {worker, sku, qty, timeMs}
    const scanByWorker = {}; // worker -> {pass}
    let totalPass = 0;
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[10] === 'undone' || r[9] !== 'pass') return;
        const w = r[3];
        const qty = Number(r[11]) || 1;
        const ts = r[2];
        const timeMs = (Object.prototype.toString.call(ts) === '[object Date]' && !isNaN(ts)) ? ts.getTime() : NaN;
        passScans.push({ worker: w, sku: r[5], qty: qty, timeMs: timeMs });
        if (!scanByWorker[w]) scanByWorker[w] = { worker: w, pass: 0 };
        scanByWorker[w].pass++;
        totalPass++;
      });
    }

    // ① 피킹 세션 목록
    const pt = picktimeSheet_();
    const ptLast = pt.getLastRow();
    const sessions = [];
    if (ptLast >= 2) {
      pt.getRange(2, 1, ptLast - 1, 6).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const worker = r[1];
        const startTs = r[3], endTs = r[4];
        const startMs = (Object.prototype.toString.call(startTs) === '[object Date]' && !isNaN(startTs)) ? startTs.getTime() : NaN;
        const endMs = (Object.prototype.toString.call(endTs) === '[object Date]' && !isNaN(endTs)) ? endTs.getTime() : NaN;

        let totalSku = 0, totalQty = 0;
        if (!isNaN(startMs) && !isNaN(endMs)) {
          const skuSet = new Set();
          passScans.forEach(sc => {
            if (sc.worker !== worker) return;
            if (isNaN(sc.timeMs) || sc.timeMs < startMs || sc.timeMs > endMs) return;
            skuSet.add(sc.sku);
            totalQty += sc.qty;
          });
          totalSku = skuSet.size;
        }

        sessions.push({
          worker: worker,
          pageRange: r[2] || '',
          start: !isNaN(startMs) ? Utilities.formatDate(startTs, batchTz_(), 'HH:mm') : '-',
          end: !isNaN(endMs) ? Utilities.formatDate(endTs, batchTz_(), 'HH:mm') : '진행중',
          durationMinutes: Number(r[5]) || 0,
          totalSku: totalSku, totalQty: totalQty,
          _sortMs: isNaN(startMs) ? 0 : startMs,
        });
      });
    }
    sessions.sort((a, b) => b._sortMs - a._sortMs); // 최신순
    sessions.forEach(s => delete s._sortMs);

    // ② 작업자별 이슈(EXP/NF/Damaged/OOS) 집계
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const issueByWorker = {};
    const issueTotalsByReason = {};
    let totalIssueCount = 0, totalIssueQty = 0;
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[12] === 'undone') return;
        const w = r[3], reason = r[9] || 'ETC', qty = Number(r[10]) || 0;
        if (!issueByWorker[w]) issueByWorker[w] = { issueCount: 0, issueQty: 0 };
        issueByWorker[w].issueCount++;
        issueByWorker[w].issueQty += qty;
        issueTotalsByReason[reason] = (issueTotalsByReason[reason] || 0) + qty;
        totalIssueCount++; totalIssueQty += qty;
      });
    }

    // scanByWorker(Pass)와 issueByWorker(이슈)를 작업자 기준으로 합쳐서 하나의 표로
    const workerNames = new Set([...Object.keys(scanByWorker), ...Object.keys(issueByWorker)]);
    const scanStats = Array.from(workerNames).map(w => ({
      worker: w,
      pass: (scanByWorker[w] || {}).pass || 0,
      issueCount: (issueByWorker[w] || {}).issueCount || 0,
      issueQty: (issueByWorker[w] || {}).issueQty || 0,
    })).sort((a, b) => b.pass - a.pass);

    const row = _findBatchRow_(batchId);
    let batchInfo = null;
    if (row) {
      const bRow = batchesSheet_().getRange(row, 1, 1, 7).getValues()[0];
      batchInfo = { batchId: bRow[0], date: bRow[1], status: bRow[2], totalSku: bRow[3], totalQty: bRow[4], createdAt: bRow[5], completedAt: bRow[6] };
    }

    return {
      ok: true,
      batch: batchInfo,
      pickSessions: sessions,
      scanStats: scanStats,
      totals: {
        pass: totalPass,
        issueCount: totalIssueCount,
        issueQty: totalIssueQty,
        byReason: issueTotalsByReason,
      }
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
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return; // over/error는 완료 카운트에 안 넣음
        // ★ 2026-07-13: 스캔 1건 = +1이 아니라, 그 스캔으로 분류된 실제 수량(Qty
        //   컬럼)만큼 더함. 예전 데이터(Qty 컬럼 없음)는 1로 취급해 하위호환.
        const qty = Number(r[11]) || 1;
        const inv = r[8];
        scannedByInvoice[inv] = (scannedByInvoice[inv] || 0) + qty;
        const key = inv + '|' + String(r[4]);
        scannedByInvoiceBarcode[key] = (scannedByInvoiceBarcode[key] || 0) + qty;
      });
    }

    // ★ 2026-07-16 신규: EXP/NF/Damaged/OOS 등으로 등록된 이슈 수량 집계.
    //   이 수량만큼은 애초에 "필요하지 않았던 것"처럼 그 고객사(Invoice)의
    //   완료 판정 기준(totalQty)에서 빼준다 — 100% 못 채워도 완료로 표시되도록.
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const issueQtyByInvoice = {};
    const issueQtyByInvoiceBarcode = {};
    const issuesByInvoice = {};
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[12] === 'undone') return;
        const inv = r[7];
        const qty = Number(r[10]) || 0;
        issueQtyByInvoice[inv] = (issueQtyByInvoice[inv] || 0) + qty;
        const key = inv + '|' + String(r[4]);
        issueQtyByInvoiceBarcode[key] = (issueQtyByInvoiceBarcode[key] || 0) + qty;
        if (!issuesByInvoice[inv]) issuesByInvoice[inv] = [];
        issuesByInvoice[inv].push({
          issueId: r[1], time: r[2], worker: r[3], barcode: r[4],
          sku: r[5], name: r[6], reason: r[9], qty: qty, note: r[11] || '',
        });
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
        const bcKey = inv + '|' + String(r[4]);
        const scannedQty = scannedByInvoiceBarcode[bcKey] || 0;
        const issueQty = issueQtyByInvoiceBarcode[bcKey] || 0;
        // ★ 2026-07-13 수정: "요청수량 100% 완료"가 아니라 "스캔이 1개라도 된 SKU"를
        //   카운트하도록 변경. ★ 2026-07-16 추가: 이슈로 등록된 SKU도 "손을 댄"
        //   것이므로(결론이 났으므로) 함께 카운트 — 안 그러면 이슈 처리해도
        //   SKU 진행률이 영원히 안 올라가는 것처럼 보임.
        if (scannedQty > 0 || issueQty > 0) skuStatsByInvoice[inv].doneSku++;
      });
    }

    // 고객사별 슬롯 정보 + 목표 수량
    const bc = bcustSheet_();
    const bcLast = bc.getLastRow();
    const slots = [];
    if (bcLast >= 2) {
      bc.getRange(2, 1, bcLast - 1, 10).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (!r[7] && r[7] !== 0) return; // 슬롯 미배정이면 현황판에 안 띄움
        const invoice = r[1];
        const totalQty = Number(r[5]) || 0;
        const scanned = scannedByInvoice[invoice] || 0;
        const issueQty = issueQtyByInvoice[invoice] || 0;
        // ★ 2026-07-16: 완료 판정 기준 수량 = 원래 필요수량 - 이슈로 빠진 수량.
        //   예) 20개 필요 중 3개가 EXP로 등록되면 → 17개만 채우면 완료.
        const effectiveTotal = Math.max(0, totalQty - issueQty);
        const skuStat = skuStatsByInvoice[invoice] || { totalSku: Number(r[6]) || 0, doneSku: 0 };
        let status = 'waiting';
        if (scanned > 0 && scanned < effectiveTotal) status = 'active';
        if (effectiveTotal >= 0 && totalQty > 0 && scanned >= effectiveTotal) status = 'done';
        // ★ 매니저가 "임시A" 같은 문자 라벨로 수동 배정한 슬롯도 있을 수 있어
        //   숫자로 안 바뀌면 원래 값을 그대로 씀 (화면 정렬은 숫자만 우선순위로)
        const rawSlot = r[7];
        const numericSlot = Number(rawSlot);
        slots.push({
          slotNum: isNaN(numericSlot) ? rawSlot : numericSlot,
          slotSize: r[8], invoice: invoice,
          customer: r[2], shipVia: r[4], totalQty: totalQty,
          scanned: scanned, status: status,
          totalSku: skuStat.totalSku, doneSku: skuStat.doneSku,
          cleared: r[9] || '', // ★ 2026-07-14 신규: 비어있으면 "패킹완료·슬롯비우기" 버튼 표시 대상
          issueQty: issueQty, // ★ 2026-07-16 신규: 현황판 "⚠ N" 뱃지용
          issues: issuesByInvoice[invoice] || [], // ★ 2026-07-16 신규: 뱃지 클릭 시 상세 목록
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
 *   issueMap: { "인보이스|바코드": 이슈로 등록된 누적 수량, ... } (★ 2026-07-16 신규)
 *            → 클라이언트가 sku.queue[].need 를 "원래수량 - 이 값"으로 항상
 *              재계산하면, 어느 기기에서 이슈를 등록했든 모든 기기가 같은
 *              필요수량/완료 여부를 보게 됨.
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
      const rows = sl.getRange(2, 1, last - 1, 12).getValues();
      rows.forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[10] === 'undone') return; // 취소된 스캔은 진행률/로그에서 제외

        const ts = r[2];
        const timeStr = (Object.prototype.toString.call(ts) === '[object Date]' && !isNaN(ts))
          ? Utilities.formatDate(ts, batchTz_(), 'yyyy-MM-dd HH:mm:ss')
          : String(ts || '');
        const qty = Number(r[11]) || 1; // ★ 2026-07-13: Qty 컬럼 없는 예전 데이터는 1로 하위호환

        scans.push({
          scanId: r[1], time: timeStr, worker: r[3], barcode: r[4],
          sku: r[5], slot: r[6], customer: r[7], invoice: r[8], result: r[9], qty: qty
        });

        if (r[9] === 'pass' && r[8] && r[4]) {
          const key = r[8] + '|' + r[4]; // invoice|barcode
          doneMap[key] = (doneMap[key] || 0) + qty;
        }
      });
    }

    scans.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)); // 최신순

    // ★ 2026-07-16 신규: 이슈 맵도 함께 반환 — invoice|barcode 키로 누적 수량 집계
    const issueMap = {};
    const issues = [];
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[12] === 'undone') return;
        const inv = r[7], bc = String(r[4]);
        const qty = Number(r[10]) || 0;
        const key = inv + '|' + bc;
        issueMap[key] = (issueMap[key] || 0) + qty;
        const ts = r[2];
        const timeStr = (Object.prototype.toString.call(ts) === '[object Date]' && !isNaN(ts))
          ? Utilities.formatDate(ts, batchTz_(), 'yyyy-MM-dd HH:mm:ss')
          : String(ts || '');
        issues.push({
          issueId: r[1], time: timeStr, worker: r[3], barcode: bc,
          sku: r[5], name: r[6], invoice: inv, customer: r[8],
          reason: r[9], qty: qty, note: r[11] || '',
        });
      });
    }
    issues.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

    return { ok: true, doneMap: doneMap, scans: scans, issueMap: issueMap, issues: issues };
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

    // 배치별 대략적인 진행률(통과 스캔 수량 합계) 계산 — 얼마나 진행됐는지 매니저가 판단할 수 있게
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const passByBatch = {};
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return;
        const bid = String(r[0]);
        const qty = Number(r[11]) || 1;
        passByBatch[bid] = (passByBatch[bid] || 0) + qty;
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
/* ===================== ⑫ getBatchWorkers / setBatchWorkers (★ 2026-07-16 신규) =====================
 * 목적: "Workers" 탭에서 추가/수정/삭제한 작업자 명단이 브라우저 메모리에만
 *       있고 서버에 저장되지 않아, 새로고침하거나 다른 기기에서 열면 예전
 *       하드코딩된 목록으로 돌아가던 문제를 고침. 명단이 적어서(보통 5~10명)
 *       변경할 때마다 시트 전체를 지우고 다시 쓰는 단순한 방식 사용.
 * ================================================================== */
function getBatchWorkers() {
  try {
    const sh = bworkersSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: true, workers: [] }; // 비어있으면 클라이언트가 기본값 사용
    const rows = sh.getRange(2, 1, last - 1, 3).getValues();
    const workers = rows
      .filter(r => r[1]) // 이름 없는 빈 행 제외
      .map(r => ({ id: Number(r[0]) || 0, name: String(r[1]), status: r[2] || 'active' }));
    return { ok: true, workers: workers };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function setBatchWorkers(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const workers = data.workers || [];
    const sh = bworkersSheet_();
    const last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, 3).clearContent();
    if (workers.length > 0) {
      const rows = workers.map(w => [w.id, w.name, w.status || 'active']);
      sh.getRange(2, 1, rows.length, 3).setValues(rows);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

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
