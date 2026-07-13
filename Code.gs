/******************************************************
 * Sheets Sync — Fixed Target Spreadsheet (by ID)
 * - Start/End 은 항상 "HH:mm" 텍스트로 저장/반환
 * - 부분 업데이트(merge) 저장
 * - 헤더 이름 가변(대소문자/공백/특수문자)에도 안전
 * - Amount 저장 수정 (2026-02-19)
 * - 출고 예정 대시보드 (getShipSchedule) 추가 (2026-05-28)
 ******************************************************/

// 🔴 여기 당신 스프레드시트 ID
const SS_ID = '1geexPrgsbSJc0mEX5OCuvpBFvnyGKxRuMPT3knBbses';
const SALES_SHEET_ID   = '14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I';
const SALES_SHEET_NAME = 'WMS Invoice and Issue';
const SALES_TIMEZONE   = 'America/Los_Angeles';

// ---- Sheet names
const JOBS_SHEET     = 'Jobs';
const SETTINGS_SHEET = 'Settings';

// === Version Channel Utils ===
const PROP = PropertiesService.getScriptProperties();

function _nowVer_() {
  return String(Date.now());
}

function getVersion_() {
  let v = PROP.getProperty('jobsVersion');
  if (!v) {
    v = _nowVer_();
    PROP.setProperty('jobsVersion', v);
  }
  return v;
}

function bumpVersion_() {
  PROP.setProperty('jobsVersion', _nowVer_());
}

// === Header map cache ===
let __HDR_CACHE = null;

function headerMapCached_() {
  const sh = SHEET_();
  const sig = sh.getSheetId() + ':' + sh.getMaxColumns();
  if (__HDR_CACHE && (__HDR_CACHE.sig === sig)) return __HDR_CACHE.map;

  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const norm = normalizeHeaderName_;
  const m = {};
  header.forEach((h, i) => { m[norm(String(h))] = i + 1; });
  __HDR_CACHE = { sig, map: m };
  return m;
}

/* ================= HTTP Entrypoints ================ */
function doGet(e) {
  const op = (e && e.parameter && e.parameter.op || '').toString();
  var __cb__ = (e.parameter || {}).callback || '';

  if (op === 'ping') {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, pong: true, ts: Date.now() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (op === 'ver') {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, ver: getVersion_() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (op === 'listJobs') {
    const out = listJobs_textSafe_();
    out.pickers = getPickers_();
    out.pickerColors = getPickerColors_();
    out.ver = getVersion_();
    return json_(out);
  }

  if (op === 'getSettings') return json_({ pickers: getPickers_(), pickerColors: getPickerColors_() });

  if (op === 'getRevenueSummary') {
    return json_(getRevenueSummary());
  }

  // iOS JSONP용 GET 방식 저장 지원
  if (op === 'upsertJob') {
    const data = JSON.parse((e.parameter || {}).data || '{}');
    upsertJob_(data);
    return json_({ ok: true });
  }

  // GET 방식 deleteJob (file:// CORS 우회용)
  if (op === 'deleteJob') {
    const invoice = (e.parameter || {}).invoice || '';
    if (invoice) deleteJob_(invoice);
    return json_({ ok: true });
  }

  if (op === 'pullFromSales') {
    const dateFrom = (e.parameter || {}).dateFrom || '';
    const dateTo = (e.parameter || {}).dateTo || '';
    const result = pullFromSalesSheet(dateFrom, dateTo);
    return json_(result);
  }

  // 영업시트 K열 "Print?" = "Yes" 마킹
  if (op === 'markSalesPrinted') {
    const invoice = (e.parameter || {}).invoice || '';
    if (!invoice) return json_({ ok: false, error: 'invoice required' });
    const result = markSalesPrinted(invoice);
    return json_(result);
  }

  // CMS 데이터 저장 (GET)
  if (op === 'receiveCmsData') {
    const dataParam = (e.parameter || {}).data || '';
    const result = receiveCmsData(dataParam);
    return json_(result);
  }

  // 저장된 CMS 데이터 확인
  if (op === 'getCmsData') {
    const cmsData = getCmsData();
    return json_({ ok: true, data: cmsData, count: Object.keys(cmsData).length });
  }

  // CMS 상태 조회 (count + timestamp 함께 반환)
  if (op === 'getCmsStatus') {
    const result = getCmsStatus();
    return json_(result);
  }

  // 저장된 CMS 데이터 삭제
  if (op === 'clearCmsData') {
    clearCmsData();
    return json_({ ok: true, message: 'CMS data cleared' });
  }

  // ★ 출고 예정 대시보드 (신규 추가)
  if (op === 'getShipSchedule') {
    return json_(getShipSchedule());
  }

  // ★ 작업자별 일일 KPI (신규 추가)
  if (op === 'getWorkerKPI') {
    var kpiDate = (e.parameter || {}).date || '';
    return json_(getWorkerKPI(kpiDate));
  }

  // ★★★ 총량피킹 (신규 추가) ★★★
  if (op === 'getBatch') {
    return json_(getBatch((e.parameter || {}).batchId || ''));
  }
  if (op === 'getBatchKPI') {
    return json_(getBatchKPI((e.parameter || {}).batchId || ''));
  }
  if (op === 'getSlotProgress') {
    return json_(getSlotProgress((e.parameter || {}).batchId || ''));
  }
  // ★ 2026-07-09 신규 — 기기간 실시간 스캔 동기화용
  if (op === 'getScanState') {
    return json_(getScanState((e.parameter || {}).batchId || ''));
  }
  // ★ 2026-07-10 신규 — 완료 처리 안 된 배치(날짜 무관) 전부 조회
  if (op === 'getOpenBatches') {
    return json_(getOpenBatches());
  }

  return json_({ ok: false, error: 'unknown op' });
}

function doPost(e) {
  const ct = (e && e.postData && e.postData.type) || '';
  let op = '', data = {};

  if (ct.indexOf('application/json') >= 0) {
    try { data = JSON.parse(e.postData.contents || '{}'); } catch (_) { data = {}; }
    op = (data.op || '').toString();
  } else {
    op = (e && e.parameter && e.parameter.op || '').toString();
    if (e && e.parameter && typeof e.parameter.data === 'string') {
      try { data = JSON.parse(e.parameter.data); } catch (_) { data = {}; }
    } else {
      data = e && e.parameter ? e.parameter : {};
    }
  }

  // ★★★ upsertJob: upsertJob_mergeText_ 함수로 통합 처리 ★★★
  if (op === 'upsertJob') {
    var payload = data;
    if (e && e.parameter && typeof e.parameter.data === 'string') {
      try { payload = JSON.parse(e.parameter.data); } catch (err) { payload = data; }
    }

    Logger.log('=== PAYLOAD DEBUG ===');
    Logger.log('invoice: ' + payload.invoice);
    Logger.log('amount: ' + payload.amount);
    Logger.log('amount type: ' + typeof payload.amount);
    Logger.log('Full payload: ' + JSON.stringify(payload));
    Logger.log('====================');

    // ★ Start/End 값에 따라 Status 보정
    if (payload.endTime || payload.endAtISO) {
      payload.status = 'completed';
    } else if (payload.startTime || payload.startAtISO) {
      if (!payload.status || String(payload.status).toLowerCase() === 'ready') {
        payload.status = 'started';
      }
    }

    const result = upsertJob_mergeText_(payload);
    return json_(Object.assign({}, result, { ver: getVersion_() }));
  }

  if (op === 'deleteJob') {
    const invoice = data.invoice;
    if (!invoice) return json_({ ok: false, error: 'invoice required' });
    setArchived_(invoice, true);
    return json_({ ok: true, softDeleted: true });
  }

  if (op === 'setSettings') {
    let pickers = data.pickers;
    if (!Array.isArray(pickers)) {
      pickers = String(pickers || '').split(',').map(s => s.trim()).filter(Boolean);
    }
    setPickers_(pickers || []);
    let pc = data.pickerColors;
    if (typeof pc === 'string') { try { pc = JSON.parse(pc); } catch (_) { pc = {}; } }
    if (!pc || typeof pc !== 'object') pc = {};
    setPickerColors_(pc);
    return json_({ ok: true });
  }

  if (op === 'setArchived') {
    const invoice = data.invoice, archived = parseBool_(data.archived);
    if (!invoice) return json_({ ok: false, error: 'invoice required' });
    setArchived_(invoice, archived);
    return json_({ ok: true });
  }

  if (op === 'lockJob') {
    const row = Number(e.parameter.rowIndex);
    const email = e.parameter.userEmail || '';
    lockJobRow_(row, email);
    return json_({ ok: true });
  }

  if (op === 'unlockJob') {
    const row = Number(e.parameter.rowIndex);
    unlockJobRow_(row);
    return json_({ ok: true });
  }

  if (op === 'saveInspection') {
    return saveInspection(JSON.parse(e.parameter.data || '{}'));
  }

  if (op === 'clearInspection') {
    return clearInspection(JSON.parse(e.parameter.data || '{}'));
  }

  // CMS 데이터 저장 (POST - 북마크릿에서 호출)
  if (op === 'receiveCmsData') {
    const dataStr = (data.data !== undefined)
      ? (typeof data.data === 'string' ? data.data : JSON.stringify(data.data))
      : '';
    const result = receiveCmsData(dataStr);
    return json_(result);
  }

  // ★★★ 총량피킹 (신규 추가) ★★★
  if (op === 'createBatch')    return json_(createBatch(data));
  if (op === 'assignSlots')    return json_(assignSlots(data));
  if (op === 'logScan')        return json_(logScan(data));
  if (op === 'undoScan')       return json_(undoScan(data));
  if (op === 'completeBatch')  return json_(completeBatch(data));
  if (op === 'logPickTiming')  return json_(logPickTiming(data));

  return json_({ ok: false, error: 'unknown op' });
}

/* ================= Sheet helpers =================== */
function ss_() { return SpreadsheetApp.openById(SS_ID); }
function SHEET_() {
  const ss = ss_();
  let sh = ss.getSheetByName(JOBS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(JOBS_SHEET);
  }
  ensureJobsHeader_(sh);
  return sh;
}
function sheet_(name) { const s = ss_().getSheetByName(name) || ss_().insertSheet(name); return s; }
function json_(obj) {
  const json = JSON.stringify(obj);
  if (typeof __cb__ !== 'undefined' && __cb__) {
    return ContentService.createTextOutput(__cb__ + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function lockJobRow_(rowIndex, userEmail) {
  const sh = SHEET_();
  const lastCol = sh.getLastColumn();
  const lockedByCol = lastCol - 1;
  const lockedAtCol = lastCol;
  sh.getRange(rowIndex, lockedByCol).setValue(userEmail || 'manager');
  sh.getRange(rowIndex, lockedAtCol).setValue(new Date());
}

function unlockJobRow_(rowIndex) {
  const sh = SHEET_();
  const lastCol = sh.getLastColumn();
  sh.getRange(rowIndex, lastCol - 1, 1, 2).clearContent();
}

function parseBool_(v) { if (v === true) return true; if (v === false) return false; const s = String(v || '').trim().toLowerCase(); return s === 'true' || s === '1' || s === 'y' || s === 'yes'; }
function toDate_(v) { if (v === '' || v == null) return ''; if (Object.prototype.toString.call(v) === '[object Date]') return v; const d = new Date(v); return isNaN(d.getTime()) ? '' : d; }
function num_(v) { const n = Number(v); return isNaN(n) ? '' : n; }
function ping_() { return { ok: true, ssId: SS_ID, sheets: ss_().getSheets().map(s => s.getName()) }; }

/* ============= Header & mapping (robust) ============ */
function normalizeHeaderName_(s) {
  return String(s || '')
    .replace(/\u00A0/g, ' ')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ');
}

function ensureJobsHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      'Invoice', 'Amount', 'Ship Date', 'SKU Count', 'Total Qty', 'Trucking', 'Remarks',
      'Status', 'Picker', 'Start Time', 'End Time', 'Created At', 'archivedAt', 'archived'
    ]);
  }
  ensureISOColumns_(sh);
}

function ensureISOColumns_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const hasStartISO = headers.some(h => String(h).trim().toLowerCase() === 'startatiso');
  const hasEndISO = headers.some(h => String(h).trim().toLowerCase() === 'endatiso');

  const add = [];
  if (!hasStartISO) add.push('StartAtISO');
  if (!hasEndISO) add.push('EndAtISO');

  if (add.length) {
    sh.insertColumnsAfter(lastCol, add.length);
    sh.getRange(1, lastCol + 1, 1, add.length).setValues([add]);
    __HDR_CACHE = null;
  }
}

function headerMap_() {
  const sh = SHEET_();
  ensureJobsHeader_(sh);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const m = {};
  hdr.forEach((name, i) => m[normalizeHeaderName_(name)] = i + 1);
  return m;
}

function findRowByKey_(keyName, keyValue) {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const key = normalizeHeaderName_(keyName);
  const col = hdr[key];
  if (!col) return 0;

  const last = sh.getLastRow();
  if (last < 2) return 0;

  const vals = sh.getRange(2, col, last - 1, 1).getValues();
  const target = String(keyValue);
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === target) return 2 + i;
  }
  return 0;
}

/* ============= Time I/O: always HH:mm text =========== */
function toHHmm_(v) {
  if (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) return v;
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  }
  if (v != null) {
    const s = String(v);
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      const H = ('0' + m[1]).slice(-2), M = ('0' + m[2]).slice(-2);
      return H + ':' + M;
    }
  }
  return '';
}

/* ========= API: upsert (merge + store HH:mm text) ===== */
function upsertJob_mergeText_(job) {
  if (!job || !job.invoice) return { ok: false, error: 'invoice required' };

  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);

  try {
    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const last = sh.getLastRow();
    const cInv = hdr[norm('Invoice')];

    if (!cInv) return { ok: false, error: 'Invoice column not found' };

    let rowIdx = 0;
    const dups = [];
    if (last >= 2 && cInv >= 1) {
      const colVals = sh.getRange(2, cInv, last - 1, 1).getValues().map(r => String(r[0] || ''));
      const target = String(job.invoice);
      for (let i = 0; i < colVals.length; i++) {
        if (colVals[i] === target) {
          if (!rowIdx) rowIdx = 2 + i;
          else dups.push(2 + i);
        }
      }
    }

    const lastCol = sh.getLastColumn();

    let rowVals;
    if (rowIdx) {
      rowVals = sh.getRange(rowIdx, 1, 1, lastCol).getValues()[0];
    } else {
      rowIdx = last + 1;
      rowVals = new Array(lastCol).fill('');
    }

    const setByName = (name, val) => {
      const c = hdr[norm(name)];
      if (!c) return;
      if (val === undefined || val === null) return;
      if (String(val).trim() === '__CLEAR__') { rowVals[c - 1] = ''; return; }
      if (val === '') return;
      rowVals[c - 1] = val;
    };

    const cInvoiceCol = hdr[norm('Invoice')];
    if (cInvoiceCol) rowVals[cInvoiceCol - 1] = String(job.invoice);

    if (job.amount !== undefined && job.amount !== null && job.amount !== '') {
      const cAmt = hdr[norm('Amount')];
      if (cAmt) {
        const numAmt = parseFloat(String(job.amount).replace(/,/g, ''));
        rowVals[cAmt - 1] = isNaN(numAmt) ? job.amount : numAmt;
        Logger.log('★ Amount saved: ' + rowVals[cAmt - 1]);
      }
    }

    const S = s => (s == null ? '' : String(s).trim());
    setByName('Ship Date', S(job.shipDate));
    setByName('SKU Count', S(job.skuCount));
    setByName('Total Qty', S(job.totalQty));
    setByName('Trucking', S(job.trucking));
    setByName('Remarks', S(job.remarks));
    setByName('Status', S(job.status));
    setByName('Picker', S(job.picker));
    setByName('archived', S(job.archived));
    setByName('archivedAt', S(job.archivedAt));

    const toHHMM = v => {
      const s = S(v);
      if (/^\d{1,2}:\d{2}$/.test(s)) {
        const [h, m] = s.split(':');
        return String(h).padStart(2, '0') + ':' + m;
      }
      const d = new Date(s);
      if (!isNaN(d)) {
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
      return s;
    };

    if (job.startTime !== undefined) setByName('Start Time', toHHMM(job.startTime));
    if (job.endTime !== undefined) setByName('End Time', toHHMM(job.endTime));
    if (job.startAtISO !== undefined) setByName('StartAtISO', utcToLocalISO_(S(job.startAtISO)));
    if (job.endAtISO !== undefined)   setByName('EndAtISO',   utcToLocalISO_(S(job.endAtISO)));

    const cCreated = hdr[norm('Created At')];
    if (cCreated && (!rowVals[cCreated - 1] || S(rowVals[cCreated - 1]) === '')) {
      rowVals[cCreated - 1] = nowLocal_();
    }

    const cMonth = hdr[norm('Month')];
    if (cMonth && job.shipDate) {
      try {
        const d = new Date(job.shipDate);
        if (!isNaN(d)) {
          const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          rowVals[cMonth-1] = monthNames[d.getMonth()] + ' ' + d.getFullYear();
        }
      } catch(e) {}
    }

    const cProcMin = hdr[norm('Processing Minutes')];
    if (cProcMin) {
      const sISO = job.startAtISO || rowVals[(hdr[norm('StartAtISO')] || 1) - 1];
      const eISO = job.endAtISO   || rowVals[(hdr[norm('EndAtISO')]   || 1) - 1];
      if (sISO && eISO) {
        const hours = calcWorkHours(String(sISO), String(eISO));
        if (hours > 0) rowVals[cProcMin-1] = Math.round(hours * 60);
      }
    }

    const hdr2 = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    hdr2.forEach(function(h, i) {
      const n = String(h).trim().toLowerCase().replace(/\s/g,'');
      if (n === 'startatiso' || n === 'endatiso') {
        sh.getRange(rowIdx, i + 1).setNumberFormat('@');
      }
    });

    sh.getRange(rowIdx, 1, 1, lastCol).setValues([rowVals]);

    const cAmtFmt = hdr[norm('Amount')];
    if (cAmtFmt) sh.getRange(rowIdx, cAmtFmt).setNumberFormat('#,##0.00');

    if (dups.length) {
      dups.sort((a, b) => b - a).forEach(r => {
        if (r !== rowIdx && r >= 2 && r <= sh.getLastRow()) {
          sh.deleteRow(r);
        }
      });
    }

    bumpVersion_();
    return { ok: true, row: rowIdx };

  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ======= listJobs: always return HH:mm string ======== */
function listJobs_textSafe_() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, jobs: [] };

  const norm = normalizeHeaderName_;
  const iInv = hdr[norm('Invoice')];
  const iAmount = hdr[norm('Amount')];
  const iShip = hdr[norm('Ship Date')];
  const iSku = hdr[norm('SKU Count')];
  const iTotal = hdr[norm('Total Qty')];
  const iTruck = hdr[norm('Trucking')];
  const iRemarks = hdr[norm('Remarks')];
  const iStatus = hdr[norm('Status')];
  const iPicker = hdr[norm('Picker')];
  const iStart = hdr[norm('Start Time')] || hdr[norm('Start')];
  const iEnd = hdr[norm('End Time')] || hdr[norm('End')];
  const iStartISO = hdr[norm('StartAtISO')];
  const iEndISO = hdr[norm('EndAtISO')];
  const iCreated = hdr[norm('Created At')];
  const iArchAt = hdr[norm('archivedAt')];
  const iArch = hdr[norm('archived')];
  const iMonth = hdr[norm('Month')];
  const iProcMin = hdr[norm('Processing Minutes')];
  const iInsp = hdr[norm('Inspection')];
  const iInspector = hdr[norm('Inspector')];
  const iInspEnd   = hdr[norm('Insp. End')];
  const lastCol = sh.getLastColumn();
  const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const jobs = rows.map(r => ({
    invoice: iInv ? r[iInv - 1] : '',
    amount: iAmount ? r[iAmount - 1] : '',
    shipDate: iShip ? r[iShip - 1] : '',
    skuCount: iSku ? r[iSku - 1] : '',
    totalQty: iTotal ? r[iTotal - 1] : '',
    trucking: iTruck ? r[iTruck - 1] : '',
    remarks: iRemarks ? r[iRemarks - 1] : '',
    status: iStatus ? r[iStatus - 1] : '',
    picker: iPicker ? r[iPicker - 1] : '',
    startTime: iStart ? toHHmm_(r[iStart - 1]) : '',
    endTime: iEnd ? toHHmm_(r[iEnd - 1]) : '',
    startAtISO: iStartISO ? r[iStartISO - 1] : '',
    endAtISO: iEndISO ? r[iEndISO - 1] : '',
    createdAt: iCreated ? r[iCreated - 1] : '',
    archivedAt: iArchAt ? r[iArchAt - 1] : '',
    archived: iArch ? r[iArch - 1] : '',
    month: iMonth ? r[iMonth - 1] : '',
    processingMinutes: iProcMin ? r[iProcMin - 1] : '',
    inspection: iInsp ? r[iInsp - 1] : '',
    inspector:   iInspector ? String(r[iInspector - 1] || '') : '',
    inspEnd:     iInspEnd   ? formatInspEnd_(r[iInspEnd - 1]) : '',
    inspectionNote: '',
  }));

  jobs.forEach((job, i) => {
    if (String(job.inspection || '').indexOf('ISSUES') >= 0) {
      try {
        job.inspectionNote = sh.getRange(i + 2, iInsp).getNote() || '';
      } catch(e) { job.inspectionNote = ''; }
    }
  });

  const cleaned = jobs.filter(j => {
    const v = String(j.archived || '').trim().toLowerCase();
    return !(v === 'true' || v === '1' || v === 'y' || v === 'yes');
  });

  return { ok: true, jobs: cleaned };
}

/* ================== Settings ======================== */
function getPickers_() {
  const sh = sheet_(SETTINGS_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Key', 'Value']);
    sh.appendRow(['pickers', 'Ryan,Jane,Henry,Nicole']);
  }
  const last = sh.getLastRow();
  const vals = sh.getRange(1, 1, last, 2).getValues();
  let value = 'Ryan,Jane,Henry,Nicole';
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === 'pickers') { value = String(vals[i][1] || value); break; }
  }
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function setPickers_(arr) {
  const sh = sheet_(SETTINGS_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(['Key', 'Value']);
  const last = sh.getLastRow();
  const vals = sh.getRange(1, 1, last, 2).getValues();
  let row = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === 'pickers') { row = i + 1; break; }
  }
  const value = (arr || []).join(',');
  if (row > -1) sh.getRange(row, 2).setValue(value);
  else sh.appendRow(['pickers', value]);
}

function getPickerColors_() {
  const sh = sheet_(SETTINGS_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(['Key', 'Value']);
  const last = sh.getLastRow();
  const vals = sh.getRange(1, 1, last, 2).getValues();
  let raw = '';
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === 'pickerColors') { raw = String(vals[i][1] || ''); break; }
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function setPickerColors_(obj) {
  const sh = sheet_(SETTINGS_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(['Key', 'Value']);
  const last = sh.getLastRow();
  const vals = sh.getRange(1, 1, last, 2).getValues();
  let row = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === 'pickerColors') { row = i + 1; break; }
  }
  const json = JSON.stringify(obj || {});
  if (row > -1) sh.getRange(row, 2).setValue(json);
  else sh.appendRow(['pickerColors', json]);
}

function setArchived_(invoice, archived) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;

    const row = findRowByKey_('invoice', invoice);
    if (!row) return { ok: false, error: 'invoice not found' };

    const cArc = hdr[norm('archived')];
    const cArcAt = hdr[norm('archivedAt')];

    if (cArc) sh.getRange(row, cArc).setValue(archived ? 'TRUE' : '');
    if (cArcAt) sh.getRange(row, cArcAt).setValue(archived ? nowLocal_() : '');

    bumpVersion_();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* =============== Maintenance ============== */
function applyInvoiceTextFormat_(sh, lastRow) { if (lastRow < 2) return; sh.getRange(2, 1, lastRow - 1, 1).setNumberFormat('@'); }

function nowLocal_() {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
}

function toLocalDateTimeString_(v) {
  const d = toDate_(v);
  if (!d) return '';
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss');
}

function enforceTextFormat_() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const startCol = hdr[normalizeHeaderName_('Start Time')] || hdr[normalizeHeaderName_('Start')];
  const endCol = hdr[normalizeHeaderName_('End Time')] || hdr[normalizeHeaderName_('End')];
  if (startCol) sh.getRange(2, startCol, Math.max(0, sh.getLastRow() - 1), 1).setNumberFormat('@');
  if (endCol) sh.getRange(2, endCol, Math.max(0, sh.getLastRow() - 1), 1).setNumberFormat('@');
}

function resetTimeColumnsToTextOnce_() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const tz = Session.getScriptTimeZone();
  const norm = normalizeHeaderName_;

  const startCol = hdr[norm('Start Time')] || hdr[norm('Start')];
  const endCol = hdr[norm('End Time')] || hdr[norm('End')];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const toHH = (v) => {
    if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) {
      const m = v.match(/^(\d{1,2}):(\d{2})$/);
      return ('0' + m[1]).slice(-2) + ':' + m[2];
    }
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
      return Utilities.formatDate(v, tz, 'HH:mm');
    }
    const s = String(v || '');
    const m = s.match(/(\d{1,2}):(\d{2})/);
    return m ? (('0' + m[1]).slice(-2) + ':' + m[2]) : '';
  };

  if (startCol) {
    const r = sh.getRange(2, startCol, lastRow - 1, 1);
    const vv = r.getValues().map(row => [toHH(row[0])]);
    r.setNumberFormat('@');
    r.setValues(vv);
  }
  if (endCol) {
    const r = sh.getRange(2, endCol, lastRow - 1, 1);
    const vv = r.getValues().map(row => [toHH(row[0])]);
    r.setNumberFormat('@');
    r.setValues(vv);
  }
}

/* ★★★ 업무 시간 계산 ★★★ */
function calcWorkHours(startISO, endISO) {
  if (!startISO || !endISO) return 0;

  const parseAny = (iso) => {
    const s = String(iso).trim();
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (m && !s.endsWith('Z') && s.indexOf('+') < 0) {
      return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
    }
    return new Date(s);
  };

  const start = parseAny(startISO);
  const end   = parseAny(endISO);
  if (isNaN(start) || isNaN(end) || end <= start) return 0;

  const SEGMENTS = [
    { startH: 8, startM: 30, endH: 12, endM: 0 },
    { startH: 13, startM: 0, endH: 17, endM: 30 }
  ];

  let totalMs = 0;
  let currentDay = new Date(start);
  currentDay.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);

  let safety = 0;
  while (currentDay <= endDay && safety < 60) {
    safety++;
    for (const seg of SEGMENTS) {
      const segStart = new Date(currentDay);
      segStart.setHours(seg.startH, seg.startM, 0, 0);
      const segEnd = new Date(currentDay);
      segEnd.setHours(seg.endH, seg.endM, 0, 0);
      const overlapStart = start > segStart ? start : segStart;
      const overlapEnd = end < segEnd ? end : segEnd;
      if (overlapEnd > overlapStart) {
        totalMs += overlapEnd - overlapStart;
      }
    }
    currentDay.setDate(currentDay.getDate() + 1);
  }

  return Math.round((totalMs / 3600000) * 10) / 10;
}

function fixISOTimesToLocal_() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const norm = normalizeHeaderName_;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const cStartISO = hdr[norm('StartAtISO')];
  const cEndISO   = hdr[norm('EndAtISO')];
  const tz = Session.getScriptTimeZone();

  const lastCol = sh.getLastColumn();
  const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  rows.forEach((row, i) => {
    let changed = false;

    [cStartISO, cEndISO].forEach(col => {
      if (!col) return;
      const val = row[col - 1];
      if (!val) return;
      const s = String(val).trim();

      if (s.endsWith('Z') || s.endsWith('.000Z')) {
        const d = new Date(s);
        if (!isNaN(d)) {
          const local = Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss");
          row[col - 1] = local;
          changed = true;
          Logger.log(`Row ${i+2} col ${col}: ${s} → ${local}`);
        }
      }
    });

    if (changed) {
      sh.getRange(i + 2, 1, 1, lastCol).setValues([row]);
    }
  });

  Logger.log('✅ 완료');
}

function fixISOColumnFormat() {
  const sh = SHEET_();
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  hdr.forEach(function(h, i) {
    const name = String(h).trim().toLowerCase().replace(/\s/g, '');
    if (name === 'startatiso' || name === 'endatiso') {
      sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1)
        .setNumberFormat('@STRING@');
      Logger.log('✅ 텍스트 포맷 설정: 컬럼 ' + (i + 1));
    }
  });
}

function deleteJob_(invoice) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Jobs') || ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const archivedAtCol = headers.indexOf('archivedAt');
  const archivedCol   = headers.indexOf('archived');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(invoice).trim()) {
      const now = new Date();
      if (archivedAtCol >= 0) sheet.getRange(i+1, archivedAtCol+1).setValue(now);
      if (archivedCol   >= 0) sheet.getRange(i+1, archivedCol+1).setValue(true);
      break;
    }
  }
}

function utcToLocalISO_(isoStr) {
  if (!isoStr) return isoStr;
  const s = String(isoStr).trim();
  if (!s.endsWith('Z') && !s.includes('.000Z') && !s.includes('+00')) return s;
  try {
    const d = new Date(s);
    if (isNaN(d)) return s;
    const tz = Session.getScriptTimeZone();
    return Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss");
  } catch(e) { return s; }
}

/* =====================================================
 * Processing Minutes 자동 보완
 * ===================================================== */
function fillMissingProcessingMinutes() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const norm = normalizeHeaderName_;

  const cStartISO = hdr[norm('StartAtISO')];
  const cEndISO   = hdr[norm('EndAtISO')];
  const cProcMin  = hdr[norm('Processing Minutes')];

  if (!cStartISO || !cEndISO || !cProcMin) {
    Logger.log('❌ 컬럼 못 찾음: ' + JSON.stringify({cStartISO, cEndISO, cProcMin}));
    return;
  }

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var fixedCount = 0;

  rows.forEach(function(row, i) {
    var startVal = row[cStartISO - 1];
    var endVal   = row[cEndISO   - 1];
    var procMin  = row[cProcMin  - 1];

    var isEmpty = (!procMin && procMin !== 0) || procMin === 0 || procMin === '';
    if (!isEmpty) return;
    if (!startVal || !endVal) return;

    var startISO = (startVal instanceof Date)
      ? Utilities.formatDate(startVal, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss")
      : String(startVal).trim();
    var endISO = (endVal instanceof Date)
      ? Utilities.formatDate(endVal, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss")
      : String(endVal).trim();

    if (!startISO || !endISO) return;

    var hours = calcWorkHours(startISO, endISO);
    var minutes = Math.round(hours * 60);

    if (minutes === 0) {
      var startMs = new Date(startISO).getTime();
      var endMs   = new Date(endISO).getTime();
      if (endMs > startMs) {
        minutes = Math.round((endMs - startMs) / 60000);
        if (minutes < 1) minutes = 1;
      }
    }

    if (minutes > 0) {
      sh.getRange(2 + i, cProcMin).setValue(minutes);
      fixedCount++;
      Logger.log('Row ' + (2+i) + ': ' + minutes + '분');
    }
  });

  Logger.log('✅ 완료: ' + fixedCount + '개 행 Processing Minutes 자동 채우기');

  if (fixedCount > 0) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      fixedCount + '개 행의 Processing Minutes가 자동으로 채워졌습니다.',
      '✅ 자동 업데이트',
      5
    );
  }
}

function setupFillTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'fillMissingProcessingMinutes') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('fillMissingProcessingMinutes')
    .timeBased()
    .everyMinutes(10)
    .create();

  Logger.log('✅ 트리거 설정 완료 - 10분마다 자동 실행');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '10분마다 Processing Minutes를 자동으로 채웁니다.',
    '✅ 트리거 설정 완료',
    5
  );
}

function removeFillTrigger() {
  var count = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'fillMissingProcessingMinutes') {
      ScriptApp.deleteTrigger(t);
      count++;
    }
  });
  Logger.log('트리거 ' + count + '개 제거됨');
}

function debugProcessingMinutes() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const norm = normalizeHeaderName_;

  const cStartISO = hdr[norm('StartAtISO')];
  const cEndISO   = hdr[norm('EndAtISO')];
  const cProcMin  = hdr[norm('Processing Minutes')];

  Logger.log('StartAtISO 열: ' + cStartISO);
  Logger.log('EndAtISO 열: ' + cEndISO);
  Logger.log('Processing Minutes 열: ' + cProcMin);

  const rows = sh.getRange(2, 1, Math.min(10, sh.getLastRow()-1), sh.getLastColumn()).getValues();
  rows.forEach(function(row, i) {
    Logger.log('Row ' + (i+2) +
      ' | start: [' + row[cStartISO-1] + '] (' + typeof row[cStartISO-1] + ')' +
      ' | end: [' + row[cEndISO-1] + '] (' + typeof row[cEndISO-1] + ')' +
      ' | procMin: [' + row[cProcMin-1] + '] (' + typeof row[cProcMin-1] + ')');
  });
}

function scanEmptyProcMin() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const norm = normalizeHeaderName_;

  const cStartISO = hdr[norm('StartAtISO')];
  const cEndISO   = hdr[norm('EndAtISO')];
  const cProcMin  = hdr[norm('Processing Minutes')];
  const cInv      = hdr[norm('Invoice')];

  const lastRow = sh.getLastRow();
  const rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();

  var found = 0;
  rows.forEach(function(row, i) {
    var procMin  = row[cProcMin - 1];
    var startVal = row[cStartISO - 1];
    var endVal   = row[cEndISO - 1];
    var invoice  = row[cInv - 1];

    var isEmpty = (procMin === '' || procMin === null || procMin === undefined);

    if (isEmpty && startVal && endVal) {
      found++;
      var startISO = (startVal instanceof Date)
        ? Utilities.formatDate(startVal, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss")
        : String(startVal);
      var endISO = (endVal instanceof Date)
        ? Utilities.formatDate(endVal, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss")
        : String(endVal);
      var hours = calcWorkHours(startISO, endISO);
      Logger.log('Row '+(i+2)+' | '+invoice+' | '+startISO+' ~ '+endISO+' | hours='+hours+' | minutes='+Math.round(hours*60));
    }
  });
  Logger.log('총 빈칸+ISO있는 행: ' + found + '개');
}

function onEdit(e) {
  try {
    var sheet = e.range.getSheet();
    var row   = e.range.getRow();
    var col   = e.range.getColumn();

    if (row <= 1) return;

    var isStartTime = (col === 10);
    var isEndTime   = (col === 11);
    if (!isStartTime && !isEndTime) return;

    var timeValue = e.range.getValue();

    if (timeValue === '' || timeValue === null) {
      if (isStartTime) sheet.getRange(row, 12).setValue('');
      if (isEndTime)   sheet.getRange(row, 13).setValue('');
      return;
    }

    var shipDateCell = sheet.getRange(row, 3).getValue();
    var baseDate;
    if (shipDateCell && shipDateCell !== '') {
      baseDate = new Date(shipDateCell);
      if (isNaN(baseDate.getTime())) baseDate = new Date();
    } else {
      baseDate = new Date();
    }

    var hours, minutes;
    if (timeValue instanceof Date) {
      hours   = timeValue.getHours();
      minutes = timeValue.getMinutes();
    } else {
      var timeStr = String(timeValue).trim();
      var parts   = timeStr.split(':');
      if (parts.length < 2) return;
      hours   = parseInt(parts[0], 10);
      minutes = parseInt(parts[1], 10);
      if (isNaN(hours) || isNaN(minutes)) return;
    }

    var y  = baseDate.getFullYear();
    var mo = String(baseDate.getMonth() + 1).padStart(2, '0');
    var d  = String(baseDate.getDate()).padStart(2, '0');
    var hh = String(hours).padStart(2, '0');
    var mm = String(minutes).padStart(2, '0');

    var isoString = y + '-' + mo + '-' + d + 'T' + hh + ':' + mm + ':00';

    if (isStartTime) {
      sheet.getRange(row, 12).setValue(isoString);
    } else {
      sheet.getRange(row, 13).setValue(isoString);
    }

  } catch(err) {
    console.error('onEdit AutoISO error:', err);
  }
}

/* =====================================================
 * ★ INSPECTION 기능
 * ===================================================== */
function saveInspection(data) {
  try {
    var ss      = SpreadsheetApp.openById(SS_ID);
    var sheet   = ss.getSheetByName(JOBS_SHEET);
    var lastRow = sheet.getLastRow();
    var tz      = Session.getScriptTimeZone();

    function fmtTime(isoStr) {
      if (!isoStr) return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
      try {
        return Utilities.formatDate(new Date(isoStr), tz, 'yyyy-MM-dd HH:mm:ss');
      } catch(e) { return String(isoStr); }
    }

    var invoiceCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var targetRow  = -1;
    for (var i = 0; i < invoiceCol.length; i++) {
      if (String(invoiceCol[i][0]).trim() === String(data.invoice).trim()) {
        targetRow = i + 2;
        break;
      }
    }
    if (targetRow === -1) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: 'Invoice not found: ' + data.invoice })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var inspEndAt  = fmtTime(data.inspEndAt || data.inspectedAt);
    var inspector  = String(data.inspector || '').trim();

    var cell = sheet.getRange(targetRow, 19);

    if (data.pass && (!data.issues || data.issues.length === 0)) {
      cell.setValue('✓ PASS');
      cell.setBackground('#0d2e1a');
      cell.setFontColor('#10b981');
      cell.setFontWeight('bold');
      cell.setNote(
        '✓ PASS\n'
        + 'Completed: ' + inspEndAt
        + (inspector ? '\nInspector: ' + inspector : '')
      );
    } else {
      var issueCount = data.issues ? data.issues.length : 0;
      cell.setValue('⚠ ISSUES(' + issueCount + ')');
      cell.setBackground('#2e0d0d');
      cell.setFontColor('#ef4444');
      cell.setFontWeight('bold');
      var noteLines = ['=== Inspection Issues ==='];
      if (data.issues && data.issues.length > 0) {
        data.issues.forEach(function(issue) {
          noteLines.push(issue.type + ': Barcode ' + issue.barcode + ' x ' + issue.qty + ' pcs');
        });
      }
      if (data.memo && data.memo.trim() !== '') {
        noteLines.push('');
        noteLines.push('Note: ' + data.memo);
      }
      noteLines.push('');
      noteLines.push('Completed: ' + inspEndAt);
      if (inspector) noteLines.push('Inspector: ' + inspector);
      cell.setNote(noteLines.join('\n'));
    }

    var sH = sheet.getRange(1, 19);
    if (!sH.getValue()) { sH.setValue('Inspection'); sH.setFontWeight('bold'); }
    var tH = sheet.getRange(1, 20);
    if (!tH.getValue()) { tH.setValue('Inspector'); tH.setFontWeight('bold'); }
    var uH = sheet.getRange(1, 21);
    if (!uH.getValue()) { uH.setValue('Insp. End'); uH.setFontWeight('bold'); }

    if (inspector) {
      sheet.getRange(targetRow, 20).setValue(inspector);
    } else {
      var existing = sheet.getRange(targetRow, 20).getValue();
      if (!existing) sheet.getRange(targetRow, 20).setValue('(Unknown)');
    }

    sheet.getRange(targetRow, 21).setValue(inspEndAt);

    bumpVersion_();
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, invoice: data.invoice, row: targetRow })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (e) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: e.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function clearInspection(data) {
  try {
    var ss    = SpreadsheetApp.openById(SS_ID);
    var sheet = ss.getSheetByName(JOBS_SHEET);
    var lastRow = sheet.getLastRow();
    var invoiceCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var targetRow = -1;
    for (var i = 0; i < invoiceCol.length; i++) {
      if (String(invoiceCol[i][0]).trim() === String(data.invoice).trim()) {
        targetRow = i + 2;
        break;
      }
    }
    if (targetRow === -1) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: 'Invoice not found' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    var cell = sheet.getRange(targetRow, 19);
    cell.clearContent();
    cell.clearNote();
    cell.setBackground(null);
    cell.setFontColor(null);
    cell.setFontWeight('normal');
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: e.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function formatInspEnd_(val) {
  if (!val) return '';
  var tz = Session.getScriptTimeZone();
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val)) {
    return Utilities.formatDate(val, tz, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(val).trim();
}

/* =====================================================
 * ★ Sales Sheet — Pull & Mark
 * ===================================================== */
function pullFromSalesSheet(dateFrom, dateTo) {
  try {
    const today = new Date();
    const todayStr = Utilities.formatDate(today, SALES_TIMEZONE, 'yyyy-MM-dd');

    let fromStr = String(dateFrom || '').trim();
    let toStr = String(dateTo || '').trim();

    if (!fromStr) fromStr = todayStr;
    if (!toStr) toStr = todayStr;

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(fromStr) || !datePattern.test(toStr)) {
      return { ok: false, error: 'Invalid date format. Use yyyy-MM-dd', invoices: [] };
    }

    if (fromStr > toStr) {
      const tmp = fromStr;
      fromStr = toStr;
      toStr = tmp;
    }

    const fromDate = new Date(fromStr + 'T00:00:00');
    const toDate = new Date(toStr + 'T00:00:00');
    const diffDays = Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24));
    if (diffDays > 14) {
      return {
        ok: false,
        error: 'Date range too wide (max 14 days). Selected: ' + (diffDays + 1) + ' days',
        invoices: []
      };
    }

    Logger.log('Date range: ' + fromStr + ' ~ ' + toStr + ' (' + (diffDays + 1) + ' days)');

    const ss = SpreadsheetApp.openById(SALES_SHEET_ID);
    const sheet = ss.getSheetByName(SALES_SHEET_NAME) || ss.getSheets()[0];

    if (!sheet) {
      return { ok: false, error: 'Sales sheet not found', invoices: [] };
    }

    const data = sheet.getDataRange().getValues();
    if (data.length < 3) {
      return { ok: true, invoices: [], message: 'No data found' };
    }

    let headerRowIdx = -1;
    let headers = null;

    for (let i = 0; i < Math.min(5, data.length); i++) {
      const row = data[i];
      const hasInvoice = row.some(cell => {
        const s = String(cell || '').trim().toLowerCase();
        return s === 'invoice#' || s === 'invoice #' || s === 'invoice';
      });
      if (hasInvoice) {
        headerRowIdx = i;
        headers = row;
        break;
      }
    }

    if (headerRowIdx === -1) {
      return { ok: false, error: 'Header row not found', invoices: [] };
    }

    const findCol = (names) => {
      for (const name of names) {
        const target = name.toLowerCase().replace(/\s+/g, '').replace(/[?]/g, '');
        for (let c = 0; c < headers.length; c++) {
          const h = String(headers[c] || '').toLowerCase().replace(/\s+/g, '').replace(/[?]/g, '');
          if (h === target) return c;
        }
      }
      return -1;
    };

    const colDate        = findCol(['Date']);
    const colInvoice     = findCol(['Invoice#', 'Invoice #', 'Invoice']);
    const colCustomer    = findCol(['Customer Name', 'CustomerName', 'Customer']);
    const colShipDate    = findCol(['Ship out Date', 'ShipoutDate', 'Ship Date', 'ShipDate']);
    const colShipMethod  = findCol(['SHIPPING METHOD', 'ShippingMethod', 'Shipping', 'Method']);
    const colAmount      = findCol(['INVOICE AMOUNT', 'InvoiceAmount', 'Amount']);
    const colPrint       = findCol(['Print?', 'Print', 'Printed']);
    const colIssue       = findCol(['Issue?', 'Issue']);

    if (colInvoice === -1) {
      return { ok: false, error: 'Invoice column not found', invoices: [] };
    }
    if (colDate === -1) {
      return { ok: false, error: 'Date column not found', invoices: [] };
    }

    const existingInvoices = new Set();
    try {
      const jobsSS = SpreadsheetApp.openById(SS_ID);
      const jobsSheet = jobsSS.getSheetByName(JOBS_SHEET);

      if (jobsSheet && jobsSheet.getLastRow() >= 2) {
        const jobsHeaders = jobsSheet.getRange(1, 1, 1, jobsSheet.getLastColumn()).getValues()[0];

        let jobsInvoiceCol = -1;
        let jobsArchivedCol = -1;
        for (let c = 0; c < jobsHeaders.length; c++) {
          const h = String(jobsHeaders[c] || '').toLowerCase().trim();
          if (h === 'invoice') jobsInvoiceCol = c;
          if (h === 'archived') jobsArchivedCol = c;
        }

        if (jobsInvoiceCol >= 0) {
          const jobsData = jobsSheet.getRange(
            2, 1, jobsSheet.getLastRow() - 1, jobsSheet.getLastColumn()
          ).getValues();

          jobsData.forEach(row => {
            const inv = String(row[jobsInvoiceCol] || '').trim().toUpperCase();
            if (!inv) return;

            if (jobsArchivedCol >= 0) {
              const archVal = String(row[jobsArchivedCol] || '').trim().toLowerCase();
              if (archVal === 'true' || archVal === '1' || archVal === 'y' || archVal === 'yes') {
                return;
              }
            }

            existingInvoices.add(inv);
          });
        }
      }
    } catch (e) {
      Logger.log('Warning: Could not read warehouse invoices: ' + String(e));
    }

    const cmsData = getCmsData();
    const cmsTimestamp = getCmsDataTimestamp();
    const cmsCount = Object.keys(cmsData).length;

    const invoices = [];
    const startRow = headerRowIdx + 1;
    let stats = {
      total: 0, outOfRange: 0, alreadyInWarehouse: 0,
      issueYes: 0, printYes: 0, added: 0, cmsMatched: 0
    };

    for (let i = startRow; i < data.length; i++) {
      const row = data[i];

      const invoiceRaw = String(row[colInvoice] || '').trim();
      if (!invoiceRaw || invoiceRaw.length < 3) continue;
      if (invoiceRaw.toLowerCase() === 'invoice#') continue;
      if (invoiceRaw.toLowerCase() === 'invoice') continue;

      stats.total++;

      const dateVal = row[colDate];
      if (!dateVal) { stats.outOfRange++; continue; }

      let rowDateStr = '';
      if (dateVal instanceof Date) {
        rowDateStr = Utilities.formatDate(dateVal, SALES_TIMEZONE, 'yyyy-MM-dd');
      } else {
        const parsed = new Date(dateVal);
        if (!isNaN(parsed.getTime())) {
          rowDateStr = Utilities.formatDate(parsed, SALES_TIMEZONE, 'yyyy-MM-dd');
        }
      }

      if (rowDateStr < fromStr || rowDateStr > toStr) {
        stats.outOfRange++;
        continue;
      }

      if (colIssue >= 0) {
        const issueVal = String(row[colIssue] || '').trim().toLowerCase();
        if (issueVal === 'yes' || issueVal === 'y' || issueVal === 'true') {
          stats.issueYes++;
          continue;
        }
      }

      if (colPrint >= 0) {
        const printVal = String(row[colPrint] || '').trim().toLowerCase();
        if (printVal === 'yes' || printVal === 'y' || printVal === 'true') {
          stats.printYes++;
          continue;
        }
      }

      const invoiceNormalized = invoiceRaw.toUpperCase();
      if (existingInvoices.has(invoiceNormalized)) {
        stats.alreadyInWarehouse++;
        continue;
      }

      let shipDateStr = '';
      if (colShipDate >= 0) {
        const shipVal = row[colShipDate];
        if (shipVal instanceof Date) {
          shipDateStr = Utilities.formatDate(shipVal, SALES_TIMEZONE, 'yyyy-MM-dd');
        } else if (shipVal) {
          const parsed = new Date(shipVal);
          if (!isNaN(parsed.getTime())) {
            shipDateStr = Utilities.formatDate(parsed, SALES_TIMEZONE, 'yyyy-MM-dd');
          }
        }
      }

      let trucking = '';
      if (colShipMethod >= 0) {
        const rawMethod = String(row[colShipMethod] || '').trim().toUpperCase();
        if (rawMethod === 'TRUCKING')                               trucking = 'TK';
        else if (rawMethod === 'PICK UP' || rawMethod === 'PICKUP') trucking = 'PU';
        else if (rawMethod === 'UPS')                               trucking = 'UPS';
        else if (rawMethod === 'FEDEX')                             trucking = 'FedEx';
        else if (rawMethod !== '')                                  trucking = 'Other';
      }

      let amount = 0;
      if (colAmount >= 0) {
        const amtVal = row[colAmount];
        if (amtVal !== '' && !isNaN(Number(amtVal))) {
          amount = Number(amtVal);
        }
      }

      const customer = (colCustomer >= 0)
        ? String(row[colCustomer] || '').trim()
        : '';

      let skuCount = '';
      let totalQty = '';
      const cmsMatch = cmsData[invoiceNormalized] || cmsData[invoiceRaw];
      if (cmsMatch) {
        skuCount = cmsMatch.item || '';
        totalQty = cmsMatch.qty || '';
        stats.cmsMatched++;
      }

      invoices.push({
        invoice:   invoiceRaw,
        amount:    amount,
        shipDate:  shipDateStr,
        trucking:  trucking,
        remarks:   customer,
        salesDate: rowDateStr,
        skuCount:  skuCount,
        totalQty:  totalQty,
        fromCms:   !!cmsMatch,
        row:       i + 1
      });
      stats.added++;
    }

    Logger.log('=== STATS ===');
    Logger.log('Date range: ' + fromStr + ' ~ ' + toStr);
    Logger.log('Total: ' + stats.total + ', Added: ' + stats.added);
    Logger.log('  - Out of range: ' + stats.outOfRange);
    Logger.log('  - Already in warehouse: ' + stats.alreadyInWarehouse);
    Logger.log('  - Issue?=Yes: ' + stats.issueYes);
    Logger.log('  - Print?=Yes: ' + stats.printYes);
    Logger.log('  → CMS matched: ' + stats.cmsMatched + ' / ' + stats.added);

    const invoiceCounts = {};
    invoices.forEach(inv => {
      invoiceCounts[inv.invoice] = (invoiceCounts[inv.invoice] || 0) + 1;
    });
    invoices.forEach(inv => {
      inv.isDuplicate = invoiceCounts[inv.invoice] > 1;
    });

    return {
      ok: true,
      invoices: invoices,
      count: invoices.length,
      cmsDataAvailable: cmsCount > 0,
      cmsTimestamp: cmsTimestamp,
      cmsMatched: stats.cmsMatched,
      dateFrom: fromStr,
      dateTo: toStr
    };

  } catch (err) {
    return { ok: false, error: String(err), invoices: [] };
  }
}

function testPullFromSales() {
  const result = pullFromSalesSheet();
  Logger.log('========== TEST RESULT ==========');
  Logger.log('Success: ' + result.ok);
  Logger.log('Count: ' + (result.count || 0));
  if (result.error) Logger.log('Error: ' + result.error);
  Logger.log('--- Invoices ---');
  (result.invoices || []).forEach((inv, i) => {
    const dupFlag = inv.isDuplicate ? ' ⚠ DUPLICATE' : '';
    Logger.log((i+1) + '. [Row ' + inv.row + '] ' + inv.invoice + dupFlag +
               ' | ' + inv.remarks + ' | ' +
               inv.trucking + ' | $' + inv.amount + ' | Ship: ' + inv.shipDate);
  });
}

function markSalesPrinted(invoice) {
  try {
    if (!invoice) return { ok: false, error: 'invoice required' };

    const invoiceTrimmed = String(invoice).trim();
    if (!invoiceTrimmed) return { ok: false, error: 'empty invoice' };

    const ss = SpreadsheetApp.openById(SALES_SHEET_ID);
    const sheet = ss.getSheetByName(SALES_SHEET_NAME) || ss.getSheets()[0];
    if (!sheet) return { ok: false, error: 'Sales sheet not found' };

    const data = sheet.getDataRange().getValues();
    if (data.length < 3) return { ok: false, error: 'No data in sales sheet' };

    let headerRowIdx = -1;
    let headers = null;
    for (let i = 0; i < Math.min(5, data.length); i++) {
      const row = data[i];
      const hasInvoice = row.some(cell => {
        const s = String(cell || '').trim().toLowerCase();
        return s === 'invoice#' || s === 'invoice #' || s === 'invoice';
      });
      if (hasInvoice) {
        headerRowIdx = i;
        headers = row;
        break;
      }
    }
    if (headerRowIdx === -1) return { ok: false, error: 'Header row not found' };

    const findCol = (names) => {
      for (const name of names) {
        const target = name.toLowerCase().replace(/\s+/g, '').replace(/[?]/g, '');
        for (let c = 0; c < headers.length; c++) {
          const h = String(headers[c] || '').toLowerCase().replace(/\s+/g, '').replace(/[?]/g, '');
          if (h === target) return c;
        }
      }
      return -1;
    };

    const colInvoice = findCol(['Invoice#', 'Invoice #', 'Invoice']);
    const colPrint   = findCol(['Print?', 'Print', 'Printed']);

    if (colInvoice === -1) return { ok: false, error: 'Invoice column not found' };
    if (colPrint === -1)   return { ok: false, error: 'Print? column not found' };

    const targetUpper = invoiceTrimmed.toUpperCase();
    let targetRow = -1;

    for (let i = headerRowIdx + 1; i < data.length; i++) {
      const cellVal = String(data[i][colInvoice] || '').trim().toUpperCase();
      if (cellVal === targetUpper) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) {
      return { ok: false, error: 'Invoice not found in sales sheet: ' + invoice };
    }

    sheet.getRange(targetRow, colPrint + 1).setValue('Yes');

    Logger.log('✓ Marked Print?=Yes for ' + invoice + ' at row ' + targetRow);
    return { ok: true, row: targetRow, invoice: invoice };

  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function testMarkSalesPrinted() {
  const invoice = 'IN00431766';
  const result = markSalesPrinted(invoice);
  Logger.log('========== TEST RESULT ==========');
  Logger.log('Success: ' + result.ok);
  if (result.ok) {
    Logger.log('Marked row: ' + result.row);
    Logger.log('Invoice: ' + result.invoice);
  } else {
    Logger.log('Error: ' + result.error);
  }
}

/* =====================================================
 * ★ CMS 데이터 저장/조회
 * ===================================================== */
function receiveCmsData(dataStr) {
  try {
    if (!dataStr) return { ok: false, error: 'No data provided' };

    let invoiceMap = {};
    try {
      invoiceMap = JSON.parse(dataStr);
    } catch (e) {
      return { ok: false, error: 'Invalid JSON: ' + e.message };
    }

    if (typeof invoiceMap !== 'object' || invoiceMap === null) {
      return { ok: false, error: 'Data must be an object' };
    }

    const count = Object.keys(invoiceMap).length;
    if (count === 0) {
      return { ok: false, error: 'Empty invoice map' };
    }

    const props = PropertiesService.getScriptProperties();
    const jsonStr = JSON.stringify(invoiceMap);
    const sizeKB = (jsonStr.length / 1024).toFixed(2);

    if (jsonStr.length > 450000) {
      return { ok: false, error: 'Data too large: ' + sizeKB + ' KB (max 450KB)' };
    }

    props.setProperty('cms_invoice_data', jsonStr);
    props.setProperty('cms_invoice_timestamp', String(Date.now()));

    Logger.log('✓ Stored CMS data: ' + count + ' invoices, ' + sizeKB + ' KB');

    return {
      ok: true,
      count: count,
      sizeKB: sizeKB,
      timestamp: Date.now(),
      message: count + ' invoices stored successfully'
    };

  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function getCmsData() {
  try {
    const props = PropertiesService.getScriptProperties();
    const jsonStr = props.getProperty('cms_invoice_data') || '{}';
    return JSON.parse(jsonStr);
  } catch (e) {
    return {};
  }
}

function getCmsDataTimestamp() {
  try {
    const props = PropertiesService.getScriptProperties();
    return Number(props.getProperty('cms_invoice_timestamp') || 0);
  } catch (e) {
    return 0;
  }
}

function clearCmsData() {
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('cms_invoice_data');
    props.deleteProperty('cms_invoice_timestamp');
    return true;
  } catch (e) {
    return false;
  }
}

function testGetCmsData() {
  const data = getCmsData();
  const timestamp = getCmsDataTimestamp();
  const count = Object.keys(data).length;

  Logger.log('========== CMS DATA STATUS ==========');
  Logger.log('Count: ' + count);
  Logger.log('Last update: ' + (timestamp ? new Date(timestamp).toISOString() : 'Never'));

  if (count > 0) {
    Logger.log('--- Sample (first 5) ---');
    let i = 0;
    for (const inv in data) {
      if (i++ >= 5) break;
      Logger.log(inv + ' → item: ' + data[inv].item + ', qty: ' + data[inv].qty);
    }
  }
}

function getCmsStatus() {
  try {
    const cmsData = getCmsData();
    const timestamp = getCmsDataTimestamp();
    const count = Object.keys(cmsData).length;

    return {
      ok: true,
      count: count,
      timestamp: timestamp,
      hasData: count > 0,
      ageMinutes: timestamp > 0 ? Math.floor((Date.now() - timestamp) / 60000) : -1
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err),
      count: 0,
      timestamp: 0,
      hasData: false
    };
  }
}

/* =====================================================
 * ★ Revenue Summary
 * ===================================================== */
function getRevenueSummary() {
  try {
    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: true, summary: {} };

    const iInv    = hdr[norm('Invoice')];
    const iAmount = hdr[norm('Amount')];
    const iShip   = hdr[norm('Ship Date')];
    const iStatus = hdr[norm('Status')];
    const iPicker = hdr[norm('Picker')];
    const iArch   = hdr[norm('archived')];

    const lastCol = sh.getLastColumn();
    const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    const tz = Session.getScriptTimeZone();
    const summary = {};

    rows.forEach(function(r) {
      const status = String(r[iStatus - 1] || '').trim().toLowerCase();
      if (status !== 'completed') return;

      const amount = parseFloat(r[iAmount - 1]) || 0;
      if (amount <= 0) return;

      const shipVal = r[iShip - 1];
      if (!shipVal) return;

      let shipDateStr = '';
      if (Object.prototype.toString.call(shipVal) === '[object Date]' && !isNaN(shipVal)) {
        shipDateStr = Utilities.formatDate(shipVal, tz, 'yyyy-MM-dd');
      } else {
        const s = String(shipVal).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
          shipDateStr = s.slice(0, 10);
        } else {
          const d = new Date(s);
          if (!isNaN(d.getTime())) {
            shipDateStr = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
          }
        }
      }
      if (!shipDateStr) return;

      const monthKey = shipDateStr.slice(0, 7);
      const picker   = String(r[iPicker - 1] || '').trim() || 'Unknown';

      if (!summary[monthKey]) {
        summary[monthKey] = { amount: 0, count: 0, byDate: {}, byPicker: {} };
      }
      const m = summary[monthKey];
      m.amount += amount;
      m.count++;

      if (!m.byDate[shipDateStr]) m.byDate[shipDateStr] = { amount: 0, count: 0 };
      m.byDate[shipDateStr].amount += amount;
      m.byDate[shipDateStr].count++;

      if (!m.byPicker[picker]) m.byPicker[picker] = { amount: 0, count: 0 };
      m.byPicker[picker].amount += amount;
      m.byPicker[picker].count++;
    });

    Object.keys(summary).forEach(function(k) {
      summary[k].amount = Math.round(summary[k].amount * 100) / 100;
      Object.keys(summary[k].byDate).forEach(function(d) {
        summary[k].byDate[d].amount = Math.round(summary[k].byDate[d].amount * 100) / 100;
      });
      Object.keys(summary[k].byPicker).forEach(function(p) {
        summary[k].byPicker[p].amount = Math.round(summary[k].byPicker[p].amount * 100) / 100;
      });
    });

    return { ok: true, summary: summary };

  } catch(e) {
    return { ok: false, error: String(e), summary: {} };
  }
}

function testRevenueSummary() {
  var result = getRevenueSummary();
  Logger.log(JSON.stringify(result));
}

/* =====================================================
 * ★★★ 출고 예정 대시보드 — getShipSchedule (신규 추가)
 *
 * 기준:
 *   - 창고 Jobs 시트 (SS_ID)
 *   - startTime 없는 것 = 미피킹
 *   - archived != true
 *   - status != 'completed'
 *
 * 영업일 계산:
 *   - 주말(토/일) 스킵
 *   - 미국 연방 공휴일 스킵
 *
 * 반환 예시:
 * {
 *   ok: true,
 *   schedule: {
 *     overdue: { count:3, amount:5200, byTruck:{UPS:{count:2,amount:3000},...}, byPicker:{...} },
 *     today:   { count:15, amount:25430, byTruck:{...}, byPicker:{...} },
 *     d1:      { count:23, amount:42180, byTruck:{...}, byPicker:{...} },
 *     d2:      { count:8,  amount:15290, byTruck:{...}, byPicker:{...} }
 *   },
 *   dates: { today:'2026-05-28', d1:'2026-05-29', d2:'2026-06-01' },
 *   asOf: '2026-05-28 09:39:11'
 * }
 * ===================================================== */
function getShipSchedule() {
  try {
    var tz = Session.getScriptTimeZone(); // America/Los_Angeles

    // ── 미국 연방 공휴일 2025-2027 ──────────────────────────
    var HOLIDAYS = {
      '2025-01-01':1,'2025-01-20':1,'2025-02-17':1,'2025-05-26':1,
      '2025-06-19':1,'2025-07-04':1,'2025-09-01':1,'2025-10-13':1,
      '2025-11-11':1,'2025-11-27':1,'2025-12-25':1,
      '2026-01-01':1,'2026-01-19':1,'2026-02-16':1,'2026-05-25':1,
      '2026-06-19':1,'2026-07-03':1,'2026-09-07':1,'2026-10-12':1,
      '2026-11-11':1,'2026-11-26':1,'2026-12-25':1,
      '2027-01-01':1,'2027-01-18':1,'2027-02-15':1,'2027-05-31':1,
      '2027-06-18':1,'2027-07-05':1,'2027-09-06':1,'2027-10-11':1,
      '2027-11-11':1,'2027-11-25':1,'2027-12-24':1
    };

    function fmtDate(d) {
      return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    }

    function isBizDay(s) {
      var d = new Date(s + 'T12:00:00');
      return d.getDay() !== 0 && d.getDay() !== 6 && !HOLIDAYS[s];
    }

    // N번째 영업일 계산 (주말+공휴일 스킵)
    function addBizDays(baseStr, n) {
      var d = new Date(baseStr + 'T12:00:00');
      var count = 0;
      while (count < n) {
        d.setDate(d.getDate() + 1);
        if (isBizDay(fmtDate(d))) count++;
      }
      return fmtDate(d);
    }

    // ── 오늘 날짜 (LA 기준) ─────────────────────────────────
    var today = fmtDate(new Date());
    var d1    = addBizDays(today, 1);   // 내일 (다음 영업일)
    var d2    = addBizDays(today, 2);   // 모레 (다다음 영업일)

    Logger.log('[ShipSchedule] today=' + today + ', d1=' + d1 + ', d2=' + d2);

    // ── 창고 Jobs 시트 읽기 ─────────────────────────────────
    var sh      = SHEET_();
    var hdr     = headerMapCached_();
    var norm    = normalizeHeaderName_;
    var lastRow = sh.getLastRow();

    // 빈 버킷 생성 헬퍼
    function emptyBucket() {
      return { count: 0, amount: 0, byTruck: {}, byPicker: {} };
    }

    var buckets = {
      overdue:    emptyBucket(),
      today:      emptyBucket(),
      d1:         emptyBucket(),
      d2:         emptyBucket(),
      later:      emptyBucket(),
      inprogress: emptyBucket()
    };

    if (lastRow < 2) {
      return {
        ok: true,
        schedule: buckets,
        dates: { today: today, d1: d1, d2: d2 },
        asOf: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
      };
    }

    // ── 컬럼 인덱스 찾기 ────────────────────────────────────
    var iInvoice = hdr[norm('Invoice')];
    var iAmount = hdr[norm('Amount')];
    var iShip   = hdr[norm('Ship Date')];
    var iTruck  = hdr[norm('Trucking')];
    var iPicker = hdr[norm('Picker')];
    var iStart  = hdr[norm('Start Time')] || hdr[norm('Start')];
    var iStartISO = hdr[norm('StartAtISO')];
    var iArch   = hdr[norm('archived')];
    var iStatus = hdr[norm('Status')];

    var lastCol = sh.getLastColumn();
    var rows    = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    var processed = 0, skipped = 0;

    rows.forEach(function(r) {
      // 아카이브된 것 제외
      var arch = String(r[(iArch || 1) - 1] || '').toLowerCase().trim();
      if (arch === 'true' || arch === '1' || arch === 'y' || arch === 'yes') {
        skipped++; return;
      }

      // 완료된 것은 무조건 제외 (카드에 표시 안 함)
      var status = iStatus ? String(r[iStatus - 1] || '').toLowerCase().trim() : '';
      if (status === 'completed') { skipped++; return; }

      var amount = parseFloat(r[(iAmount || 1) - 1]) || 0;
      var truck  = String(r[(iTruck  || 1) - 1] || '').trim() || 'Other';
      var picker = String(r[(iPicker || 1) - 1] || '').trim() || '미배정';
      // ★ 인보이스 끝 4자리 (작업자가 들고 있는 종이 식별용)
      // 분할 오더(IN00444397_01)는 "본체 끝4자리 + 접미사" → "4397_01" 로 표시
      var invFull = iInvoice ? String(r[iInvoice - 1] || '').trim() : '';
      var inv4 = '';
      if (invFull) {
        var usIdx = invFull.indexOf('_');
        if (usIdx >= 0) {
          var base = invFull.slice(0, usIdx);
          var suffix = invFull.slice(usIdx); // "_01" 포함
          inv4 = base.slice(-4) + suffix;
        } else {
          inv4 = invFull.slice(-4);
        }
      }

      // 버킷에 합산하는 헬퍼 (startISO: 진행중 작업의 시작 시각, 경과시간 계산용)
      function addToBucket(bucketName, startISO) {
        var b = buckets[bucketName];
        b.count++;
        b.amount += amount;
        if (!b.byTruck[truck])  b.byTruck[truck]  = { count: 0, amount: 0 };
        b.byTruck[truck].count++;
        b.byTruck[truck].amount += amount;
        if (!b.byPicker[picker]) b.byPicker[picker] = { count: 0, amount: 0, oldestStart: '', trucks: {}, invoices: [] };
        b.byPicker[picker].count++;
        b.byPicker[picker].amount += amount;
        // ★ 작업자별 Trucking 종류 집계 (이 사람이 UPS/PU 중 무엇을 잡았는지)
        if (!b.byPicker[picker].trucks[truck]) b.byPicker[picker].trucks[truck] = 0;
        b.byPicker[picker].trucks[truck]++;
        // ★ 작업자별 인보이스 끝 4자리 목록 (어떤 오더를 들고 있는지)
        if (inv4 && b.byPicker[picker].invoices.indexOf(inv4) < 0) {
          b.byPicker[picker].invoices.push(inv4);
        }
        // ★ 작업자별 가장 오래된 시작 시각 추적 (가장 오래 잡고 있는 작업 = 병목 신호)
        if (startISO) {
          var cur = b.byPicker[picker].oldestStart;
          if (!cur || startISO < cur) b.byPicker[picker].oldestStart = startISO;
        }
        processed++;
      }

      // ★ Start Time 있음 = 현재 진행 중 (날짜 무관)
      var startVal = iStart ? String(r[iStart - 1] || '').trim() : '';
      if (startVal) {
        // 경과시간 계산용 ISO 시각 (StartAtISO 우선, 없으면 오늘+Start Time 조합)
        var startISO = '';
        if (iStartISO) {
          var isoRaw = r[iStartISO - 1];
          if (isoRaw instanceof Date && !isNaN(isoRaw)) {
            startISO = Utilities.formatDate(isoRaw, tz, "yyyy-MM-dd'T'HH:mm:ss");
          } else {
            startISO = String(isoRaw || '').trim();
          }
        }
        // StartAtISO가 없으면 오늘 날짜 + Start Time(HH:mm) 으로 추정
        if (!startISO && /^\d{1,2}:\d{2}/.test(startVal)) {
          startISO = today + 'T' + startVal.slice(0,5) + ':00';
        }
        addToBucket('inprogress', startISO);
        return;
      }

      // ★ Start Time 없음 = 미피킹 → Ship Date 기준 날짜 버킷
      var shipRaw = iShip ? r[iShip - 1] : null;
      if (!shipRaw) { skipped++; return; }

      var shipStr = '';
      if (Object.prototype.toString.call(shipRaw) === '[object Date]' && !isNaN(shipRaw)) {
        shipStr = fmtDate(shipRaw);
      } else {
        var s = String(shipRaw).trim().split('T')[0];
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) shipStr = s.slice(0, 10);
      }
      if (!shipStr) { skipped++; return; }

      var bucket = null;
      if      (shipStr < today)       bucket = 'overdue';
      else if (shipStr === today)      bucket = 'today';
      else if (shipStr === d1)         bucket = 'd1';
      else if (shipStr === d2)         bucket = 'd2';
      else                             bucket = 'later'; // d2 이후(범위 밖) → Later 버킷

      if (!bucket) { skipped++; return; }

      addToBucket(bucket, '');
    });

    Logger.log('[ShipSchedule] processed=' + processed + ', skipped=' + skipped);
    Logger.log('[ShipSchedule] overdue=' + buckets.overdue.count
      + ' today=' + buckets.today.count
      + ' d1='    + buckets.d1.count
      + ' d2='    + buckets.d2.count
      + ' later=' + buckets.later.count
      + ' inprogress=' + buckets.inprogress.count);

    // ── 금액 소수점 2자리 반올림 ────────────────────────────
    ['overdue','today','d1','d2','later','inprogress'].forEach(function(key) {
      var b = buckets[key];
      b.amount = Math.round(b.amount * 100) / 100;
      Object.keys(b.byTruck).forEach(function(k) {
        b.byTruck[k].amount = Math.round(b.byTruck[k].amount * 100) / 100;
      });
      Object.keys(b.byPicker).forEach(function(k) {
        b.byPicker[k].amount = Math.round(b.byPicker[k].amount * 100) / 100;
      });
    });

    return {
      ok: true,
      schedule: buckets,
      dates: { today: today, d1: d1, d2: d2 },
      asOf: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
    };

  } catch(e) {
    Logger.log('[ShipSchedule] ERROR: ' + String(e));
    return {
      ok: false,
      error: String(e),
      schedule: {},
      dates: {}
    };
  }
}

/**
 * 테스트 함수 — GAS 에디터에서 직접 실행해서 결과 확인
 * 실행 방법: 함수 선택 드롭다운 → testShipSchedule → ▶ 실행
 */
function testShipSchedule() {
  var result = getShipSchedule();
  Logger.log('========== ShipSchedule TEST ==========');
  Logger.log('ok: ' + result.ok);
  if (!result.ok) { Logger.log('ERROR: ' + result.error); return; }
  Logger.log('Dates: today=' + result.dates.today
    + ', d1=' + result.dates.d1
    + ', d2=' + result.dates.d2);
  Logger.log('asOf: ' + result.asOf);
  Logger.log('--- Overdue (지연) ---');
  Logger.log('  count=' + result.schedule.overdue.count + ', amount=$' + result.schedule.overdue.amount);
  Logger.log('  byTruck: ' + JSON.stringify(result.schedule.overdue.byTruck));
  Logger.log('--- Today (오늘) ---');
  Logger.log('  count=' + result.schedule.today.count + ', amount=$' + result.schedule.today.amount);
  Logger.log('  byTruck: ' + JSON.stringify(result.schedule.today.byTruck));
  Logger.log('  byPicker: ' + JSON.stringify(result.schedule.today.byPicker));
  Logger.log('--- D1 (내일) ---');
  Logger.log('  count=' + result.schedule.d1.count + ', amount=$' + result.schedule.d1.amount);
  Logger.log('--- D2 (모레) ---');
  Logger.log('  count=' + result.schedule.d2.count + ', amount=$' + result.schedule.d2.amount);
  Logger.log('--- In Progress (진행중) ---');
  Logger.log('  count=' + result.schedule.inprogress.count + ', amount=$' + result.schedule.inprogress.amount);
  Logger.log('  byPicker: ' + JSON.stringify(result.schedule.inprogress.byPicker));
  Logger.log('=======================================');
}

/* =====================================================
 * ★★★ 작업자별 일일 KPI — getWorkerKPI (신규 추가)
 *
 * 기준: 창고 Jobs 시트
 *   - status === 'completed' 인 오더만 (그날 완료한 작업)
 *   - 완료일(EndAtISO 우선, 없으면 endTime의 날짜)이 지정 날짜와 같은 것
 *   - dateStr 미지정 시 오늘(LA) 기준
 *
 * 반환:
 * {
 *   ok: true,
 *   date: '2026-06-08',
 *   workers: [
 *     { picker, jobs, sku, qty, amount, avgMinutes, totalMinutes,
 *       inspPass, inspIssues, inspPending }
 *   ],
 *   totals: { jobs, sku, qty, amount, inspPass, inspIssues, inspPending },
 *   asOf: 'yyyy-MM-dd HH:mm:ss'
 * }
 * ===================================================== */
function getWorkerKPI(dateStr) {
  try {
    var tz = Session.getScriptTimeZone();
    var targetDate = String(dateStr || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      targetDate = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    }

    var sh   = SHEET_();
    var hdr  = headerMapCached_();
    var norm = normalizeHeaderName_;
    var lastRow = sh.getLastRow();

    var empty = {
      ok: true, date: targetDate, workers: [],
      totals: { jobs:0, sku:0, qty:0, amount:0, inspPass:0, inspIssues:0, inspPending:0 },
      asOf: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
    };
    if (lastRow < 2) return empty;

    var iPicker  = hdr[norm('Picker')];
    var iAmount  = hdr[norm('Amount')];
    var iSku     = hdr[norm('SKU Count')];
    var iQty     = hdr[norm('Total Qty')];
    var iStatus  = hdr[norm('Status')];
    var iEndISO  = hdr[norm('EndAtISO')];
    var iEnd     = hdr[norm('End Time')] || hdr[norm('End')];
    var iProcMin = hdr[norm('Processing Minutes')];
    var iInsp    = hdr[norm('Inspection')];
    var iArch    = hdr[norm('archived')];

    var lastCol = sh.getLastColumn();
    var rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    // 완료일 추출: EndAtISO(앞 10자리) 우선, 없으면 패스(날짜 불명)
    function completedDateOf(r) {
      if (iEndISO) {
        var v = r[iEndISO - 1];
        if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        var s = String(v || '').trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      }
      return '';
    }

    var map = {}; // picker -> kpi
    function bucket(p) {
      if (!map[p]) map[p] = { picker:p, jobs:0, sku:0, qty:0, amount:0,
        totalMinutes:0, _minCount:0, inspPass:0, inspIssues:0, inspPending:0 };
      return map[p];
    }

    rows.forEach(function(r) {
      // 완료된 것만
      var status = iStatus ? String(r[iStatus - 1] || '').toLowerCase().trim() : '';
      if (status !== 'completed') return;

      // 완료일이 지정 날짜와 같은 것만
      var cd = completedDateOf(r);
      if (cd !== targetDate) return;

      var picker = String(r[(iPicker || 1) - 1] || '').trim() || '(Unknown)';
      var b = bucket(picker);

      b.jobs++;
      b.sku    += parseInt(r[(iSku || 1) - 1], 10) || 0;
      b.qty    += parseInt(r[(iQty || 1) - 1], 10) || 0;
      b.amount += parseFloat(r[(iAmount || 1) - 1]) || 0;

      // 처리시간 (Processing Minutes, 0/빈값 제외)
      if (iProcMin) {
        var pm = parseFloat(r[iProcMin - 1]);
        if (!isNaN(pm) && pm > 0) { b.totalMinutes += pm; b._minCount++; }
      }

      // 검수 결과
      var insp = iInsp ? String(r[iInsp - 1] || '').trim() : '';
      if (insp.indexOf('PASS') >= 0)        b.inspPass++;
      else if (insp.indexOf('ISSUES') >= 0) b.inspIssues++;
      else                                  b.inspPending++;
    });

    var workers = [];
    var totals = { jobs:0, sku:0, qty:0, amount:0, inspPass:0, inspIssues:0, inspPending:0 };
    Object.keys(map).forEach(function(p) {
      var b = map[p];
      var avg = b._minCount > 0 ? Math.round(b.totalMinutes / b._minCount) : 0;
      workers.push({
        picker: b.picker,
        jobs: b.jobs,
        sku: b.sku,
        qty: b.qty,
        amount: Math.round(b.amount * 100) / 100,
        avgMinutes: avg,
        totalMinutes: Math.round(b.totalMinutes),
        inspPass: b.inspPass,
        inspIssues: b.inspIssues,
        inspPending: b.inspPending
      });
      totals.jobs += b.jobs; totals.sku += b.sku; totals.qty += b.qty;
      totals.amount += b.amount;
      totals.inspPass += b.inspPass; totals.inspIssues += b.inspIssues; totals.inspPending += b.inspPending;
    });
    totals.amount = Math.round(totals.amount * 100) / 100;

    // 완료 건수 내림차순 정렬
    workers.sort(function(a, z) { return z.jobs - a.jobs; });

    return {
      ok: true,
      date: targetDate,
      workers: workers,
      totals: totals,
      asOf: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
    };

  } catch(e) {
    return { ok: false, error: String(e), workers: [], totals: {} };
  }
}

function testWorkerKPI() {
  var r = getWorkerKPI('');
  Logger.log('========== Worker KPI TEST ==========');
  Logger.log('ok=' + r.ok + ', date=' + r.date);
  if (!r.ok) { Logger.log('ERROR: ' + r.error); return; }
  r.workers.forEach(function(w) {
    Logger.log(w.picker + ' | ' + w.jobs + ' jobs | SKU ' + w.sku + ' / Qty ' + w.qty
      + ' | $' + w.amount + ' | avg ' + w.avgMinutes + 'm/job'
      + ' | insp ' + w.inspPass + '✓ ' + w.inspIssues + '⚠ ' + w.inspPending + ' pending');
  });
  Logger.log('TOTALS: ' + JSON.stringify(r.totals));
}
