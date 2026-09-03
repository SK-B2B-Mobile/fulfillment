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
  // ★ 2026-07-14 신규: 데이터가 실제로 바뀌면 listJobs 캐시를 즉시 지워서,
  //   다음 조회부터는(캐시 만료 8초를 기다리지 않고) 곧바로 최신 데이터를 읽음
  try { CacheService.getScriptCache().remove('listJobs_cache_v1'); } catch (e) {}
  // ★ 2026-07-28 신규 — 영업 공유 페이지(sales.html) 캐시도 같이 비움.
  //   디멘션 저장/검수/패킹존이동 등 거의 모든 쓰기 작업이 이 함수를 거치므로,
  //   여기서 같이 지워주면 "방금 저장했는데 목록에 안 보임" 문제 없이
  //   짧은 캐시(속도용)와 즉시반영(정확성)을 둘 다 챙길 수 있음.
  try { CacheService.getScriptCache().remove('salesOverview_cache_v1'); } catch (e) {}
  try { CacheService.getScriptCache().remove('salesToday_cache_v1'); } catch (e) {}
  // ★ 2026-08-25 신규(안전 확인) — getOpenBatches("다른 배치" 목록) 캐시를 6초→20초로
  //   늘리면서(속도 개선), 방금 2차 검증을 끝냈는데도 목록엔 최대 20초간 예전
  //   숫자("검증 대기 N건")가 보일 위험이 새로 생겼음. 데이터가 실제로 바뀌는
  //   모든 쓰기 작업이 이 함수(bumpVersion_)를 거치므로, 여기서 같이 지워서
  //   "속도는 빠르게, 정확도는 항상 최신"을 둘 다 보장함.
  try { CacheService.getScriptCache().remove('openBatches_v1'); } catch (e) {}
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
    // ★ 2026-07-14 신규 — 총량피킹/기존 웹/모바일 앱 세 시스템이 같은 스프레드시트를
    //   공유하다보니, 여러 기기가 거의 동시에 새로고침할 때 매번 시트를 처음부터
    //   다시 읽어서 요청이 몰리면 응답이 느려지고(때로 1분 이상) 타임아웃까지
    //   발생했음. 8초짜리 짧은 캐시를 둬서, 그 사이 들어온 요청들은 시트를 다시
    //   안 읽고 캐시된 값을 즉시 돌려줌. 실제로 데이터가 바뀌면(upsertJob/delete/
    //   saveInspection 등) bumpVersion_()이 이 캐시를 바로 지우므로, 최대 8초의
    //   "약간 오래된 데이터"만 감수하면 되고 그 안에서도 본인이 직접 바꾼 내용은
    //   즉시 반영됨(자기 자신의 쓰기 → 캐시 삭제 → 자신의 다음 조회는 새 데이터).
    const cache = CacheService.getScriptCache();
    const cacheKey = 'listJobs_cache_v1';
    let out;
    const cached = cache.get(cacheKey);
    if (cached) {
      try { out = JSON.parse(cached); } catch (e) { out = null; }
    }
    if (!out) {
      out = listJobs_textSafe_();
      out.pickers = getPickers_();
      out.pickerColors = getPickerColors_();
      out.ver = getVersion_();
      try { cache.put(cacheKey, JSON.stringify(out), 8); } catch (e) { /* 캐시 실패해도 정상 응답은 계속 진행 */ }
    }
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
    // ★ 2026-08-10 신규 — 서버측 보관 규칙 검증.
    //   자동보관은 브라우저가 판단해서 지시하는 구조라, 몇일 지난 index.html을
    //   캐시로 물고 있는 PC가 자정에 예전 규칙으로 실행해버리는 사고가 실제로
    //   발생했음(8/7 검수분이 8/8 새벽에 전부 보관됨).
    //   이제 서버가 직접 규칙을 확인하고, 미달이면 거부한다.
    //   매니저 수동 삭제만 force=1로 예외 허용.
    const force = String((e.parameter || {}).force || '') === '1';
    if (!invoice) return json_({ ok: false, error: 'invoice required' });
    if (!force) {
      const chk = jobArchiveCheck_(invoice);
      if (!chk.eligible) {
        Logger.log('deleteJob 거부: ' + invoice + ' — ' + chk.reason);
        return json_({ ok: false, blocked: true, error: '보관 기준 미달: ' + chk.reason });
      }
    }
    deleteJob_(invoice);
    return json_({ ok: true });
  }
  // ★ 2026-08-10 신규 — 규칙을 어기고 보관된 오더 복구
  if (op === 'restoreWronglyArchived') {
    const q = e.parameter || {};
    return json_(restoreWronglyArchived(q.from || '', q.to || ''));
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
  // ★ 2026-07-24 신규 — 이슈 등록 팝업에서 "어떤 SKU가 부족한지" 보여주기 위한 조회
  if (op === 'getInvoiceItemStatus') {
    const p = e.parameter || {};
    return json_(getInvoiceItemStatus(p.batchId || '', p.invoice || ''));
  }
  // ★ 2026-09-01 신규 — 04 단독 1차 검수: 이 인보이스의 현재 활성 이슈 전체 조회(취소용)
  if (op === 'getInvoiceIssues') {
    const p2 = e.parameter || {};
    return json_(getInvoiceIssues(p2.batchId || '', p2.invoice || ''));
  }
  // ★ 2026-07-24 신규 — 스캔/이슈 액션 없이도, 특정 인보이스의 fulfillment
  //   대시보드 Inspection을 지금 당장 강제로 다시 계산해서 씀. 배포 직후 예전에
  //   저장된 오래된 값을 새 액션 없이 바로 고치고 싶을 때 씀(1회성 유틸리티).
  if (op === 'forceSyncInspection') {
    const p = e.parameter || {};
    try {
      // ★ 2026-07-24 재수정 — 그냥 비워서 넘기면, 직전에 이미 잘못 박힌 값
      //   (예: "(수동 재동기화)")이 "기존값 보존" 로직 때문에 그대로 남는 문제가
      //   있었음. 그래서 "지금 활성 이슈 중 가장 최근 것을 등록한 실제 작업자"를
      //   직접 찾아서 그 이름으로 정확히 복원함 — placeholder 대신 진짜 담당자.
      let realWorker = '';
      const il = issuelogSheet_();
      const ilLast = il.getLastRow();
      if (ilLast >= 2) {
        let latestTime = null;
        il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
          if (String(r[0]) !== String(p.batchId)) return;
          if (String(r[7]) !== String(p.invoice)) return;
          if (r[12] === 'undone') return;
          const t = r[2] instanceof Date ? r[2].getTime() : 0;
          if (latestTime === null || t > latestTime) { latestTime = t; realWorker = String(r[3] || ''); }
        });
      }
      syncInspectionFromPicking_(p.batchId || '', p.invoice || '', realWorker, true);
      return json_({ ok: true, message: '재동기화 완료 (담당자: ' + (realWorker || '(찾지 못함, 기존값 유지)') + ')' });
    } catch (e2) {
      return json_({ ok: false, error: String(e2 && e2.message || e2) });
    }
  }
  // ★ 2026-07-09 신규 — 기기간 실시간 스캔 동기화용
  // ★ 2026-08-24 신규 — 오출고 방지: 패킹 검증 진행 상태 조회
  if (op === 'getPackScanState') {
    return json_(getPackScanState((e.parameter||{}).batchId||'', (e.parameter||{}).invoice||''));
  }
  // ★ 2026-08-31 신규 — 단독 오더 목록 조회
  if (op === 'getStandaloneOrders') {
    return json_(getStandaloneOrders());
  }
  // ★ 2026-08-25 신규 — Scan & Sort 작업자 중복 선택 방지(다른 기기에서 쓰는 중인지 조회)
  if (op === 'getActiveScanWorkers') {
    return json_(getActiveScanWorkers({ batchId: (e.parameter||{}).batchId||'' }));
  }
  // ★ 2026-09-01 신규 — Workers 탭 실시간 근무 상태(배치 무관, 전역)
  if (op === 'getActiveWorkersGlobal') {
    return json_(getActiveWorkersGlobal());
  }
  if (op === 'getScanState') {
    return json_(getScanState((e.parameter || {}).batchId || ''));
  }
  // ★ 2026-08-19 신규(긴급, 요청 합치기) — getScanState + getActivePickers를
  //   한 번에 묶어서 반환. batch.html이 8초·10초마다 따로 부르던 걸 하나로
  //   합쳐서, 폴링 주기는 그대로 두고 실제 요청 개수만 줄이기 위함.
  if (op === 'getScanAndPickers') {
    return json_(getScanAndPickers((e.parameter || {}).batchId || ''));
  }
  // ★ 2026-07-10 신규 — 완료 처리 안 된 배치(날짜 무관) 전부 조회
  if (op === 'getOpenBatches') {
    return json_(getOpenBatches());
  }
  // ★ 2026-08-25 신규 — TV 현황판에서 "지난 배치" 전체(완료 여부 무관)를 조회
  if (op === 'getBatchHistoryList') {
    return json_(getBatchHistoryList({ days: (e.parameter||{}).days || 14 }));
  }
  // ★ 2026-07-14 신규 — 아직 안 비워진(패킹 대기중이거나 진행중인) 슬롯 전체 조회.
  //   새 배치 만들 때 이 슬롯 번호들을 피해서 자동배정하기 위함.
  if (op === 'getOccupiedSlots') {
    return json_(getOccupiedSlots());
  }
  // ★ 2026-07-16 신규 — 총량피킹 작업자 명단 서버 조회
  if (op === 'getBatchWorkers') {
    return json_(getBatchWorkers());
  }
  // ★ 2026-07-22 신규 — 지금 피킹 중인 작업자 목록(기기 간 중복 선택 방지용)
  if (op === 'getActivePickers') {
    return json_(getActivePickers((e.parameter || {}).batchId || ''));
  }
  // ★ 2026-07-23 신규 — 매니저가 지정한 "지금 활성 배치"를 모든 기기가 조회
  if (op === 'getActiveBatch') {
    return json_(getActiveBatch());
  }
  // ★ 2026-08-05 신규 — 미배분 경보: 배치 안에서 "다른 고객사에겐 스캔됐는데
  //   이 고객사만 완전히 빠진" 상품을 찾아 TV 현황판에 즉시 경보로 보여주기 위함.
  //   (BatchPicking.gs의 getUnfulfilledSkuAlerts 함수를 그대로 연결)
  if (op === 'getUnfulfilledSkuAlerts') {
    return json_(getUnfulfilledSkuAlerts((e.parameter || {}).batchId || ''));
  }

  // ★ 2026-07-28 신규 — 영업 공유: 오더 검수 상세 + 배송 디멘션 조회
  // ★ 2026-08-06 신규 — 디멘션 합치기 후보(같은 고객사 오더) 조회. 상세조회를
  //   느리게 만들지 않도록 무거운 계산을 이 별도 호출로 분리함.
  // ★ 2026-08-06 신규 — 바코드/SKU로 오더 찾기 (2번 화면 통합검색)
  // ★ 2026-08-06 신규 — 총량피킹 배치의 Jobs 상태를 수동으로 한 번에 맞춤
  if (op === 'syncBatchJobs') {
    return json_(syncBatchJobsAll((e.parameter || {}).batchId || ''));
  }
  if (op === 'getOrdersByItem') {
    return json_(getOrdersByItem((e.parameter || {}).q || ''));
  }
  if (op === 'getDimCandidates') {
    return json_(getDimCandidates((e.parameter || {}).invoice || ''));
  }
  if (op === 'getSalesInvoiceDetail') {
    return json_(getSalesInvoiceDetail((e.parameter || {}).invoice || ''));
  }
  // ★ 2026-07-28 신규 — 영업 공유: "오늘 완료된 오더" 목록 전용 경량 조회.
  //   listJobs는 전체 오더 + 이슈건마다 개별 getNote() 호출까지 있어서 느림.
  //   영업 페이지는 오늘 것 몇 건만 필요하므로, 서버에서 날짜 필터링 후
  //   최소 필드만 반환해서 훨씬 빠르게 함.
  if (op === 'getSalesTodayList') {
    return json_(getSalesTodayList());
  }
  // ★ 2026-07-28 신규 — 영업 공유: 시트 미리보기 화면 (검수 여부 무관 전체 목록)
  if (op === 'getSalesOverview') {
    return json_(getSalesOverview());
  }
  // ★ 2026-08-19 신규(긴급, 요청 합치기) — getSalesOverview + getSalesTodayList
  //   한 번에 반환. sales.html의 30초 자동동기화가 항상 이 둘을 같이 부르므로
  //   요청 개수를 절반으로 줄임.
  if (op === 'getSalesOverviewAndToday') {
    return json_(getSalesOverviewAndToday());
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
    // ★ 2026-08-10 — GET 경로와 동일한 서버측 검증
    if (String(data.force || '') !== '1') {
      const chk = jobArchiveCheck_(invoice);
      if (!chk.eligible) return json_({ ok: false, blocked: true, error: '보관 기준 미달: ' + chk.reason });
    }
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

  // ★ 2026-07-14 신규 — 여러 건을 체크박스로 선택해서 한번에 PASS 처리할 때,
  //   건별로 따로따로 서버를 호출하면 19건에 19번 네트워크 왕복 + 19번 스크립트
  //   실행이 발생해서 느림(체감 30초 이상). 이 op은 배열로 한번에 받아서
  //   시트를 한 번만 열고 순서대로 기록 → 왕복 1번으로 끝남.
  if (op === 'saveInspectionBulk') {
    let list = [];
    try { list = JSON.parse(e.parameter.data || '[]'); } catch (err) { list = []; }
    return json_(saveInspectionBulk_(list));
  }

  // ★ 2026-07-14 신규 — 여러 작업자가 정확히 같은 순간 완료 버튼을 눌러서 "다음
  //   오더"가 우연히 같은 걸로 겹치면, 그 오더를 동시에 여러 명이 열어버릴 수
  //   있었음(아직 아무도 검수 안 한 오더라 서버가 막을 근거가 없었음). 오더를
  //   열 때 "지금 내가 이거 검수 중" 도장을 찍어두고, 다른 사람이 같은 오더를
  //   열려고 하면 막아주는 선점(claim) 기능.
  if (op === 'claimInspection') {
    return json_(claimInspection_(data));
  }
  if (op === 'releaseInspectionClaim') {
    return json_(releaseInspectionClaim_(data));
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
  // ★ 2026-07-14 신규 — "패킹완료·슬롯비우기" 버튼
  if (op === 'clearSlot')      return json_(clearSlot(data));
  if (op === 'setPackingMoved') return json_(setPackingMoved(data)); // ★ 2026-07-23 신규: 패킹존 이동 체크(순수 표시용)
  // ★ 2026-08-24 신규 — 오출고 방지: 패킹 검증 스캔 기록/취소
  if (op === 'logPackScan')   return json_(logPackScan(data));
  // ★ 2026-09-01 신규 — 관리자 강제확정 시 남은 수량을 실제로 채워서, 화면/슬립이 항상 일치하게 함
  if (op === 'forceCompletePackScan') return json_(forceCompletePackScan(data));
  if (op === 'undoPackScan')  return json_(undoPackScan(data));
  // ★ 2026-08-25 신규 — Scan & Sort 작업자 선택 하트비트(다른 기기 중복 선택 방지)
  if (op === 'pingScanWorker') return json_(pingScanWorker(data));
  // ★ 2026-09-01 신규 — Workers 탭 실시간 근무 상태(배치 무관, 전역) 하트비트
  if (op === 'pingWorkerPresenceBatch') return json_(pingWorkerPresenceBatch(data));
  // ★ 2026-08-31 신규 — 단독 오더 등록/삭제
  if (op === 'addStandaloneOrder')    return json_(addStandaloneOrder(data));
  if (op === 'removeStandaloneOrder') return json_(removeStandaloneOrder(data));
  // ★ 2026-07-16 신규 — EXP/NF/Damaged/OOS 등 고객사별 이슈 등록
  if (op === 'logIssue')       return json_(logIssue(data));
  if (op === 'undoIssue')      return json_(undoIssue(data));
  if (op === 'editIssue')      return json_(editIssue(data)); // ★ 2026-07-22 신규
  // ★ 2026-07-16 신규 — 총량피킹 작업자 명단 서버 저장
  if (op === 'setBatchWorkers') return json_(setBatchWorkers(data));
  // ★ 2026-07-23 신규 — 매니저가 배치를 이어서/새로 시작하면 서버에 "활성 배치" 기록
  if (op === 'setActiveBatch')  return json_(setActiveBatch(data));
  if (op === 'clearActiveBatch') return json_(clearActiveBatch());

  // ★ 2026-07-28 신규 — 영업 공유: 패킹 작업자가 배송 디멘션(치수/무게) 저장
  if (op === 'saveDimensions') return json_(saveDimensions(data));
  // ★ 2026-08-06 신규 — 단독 오더(총량피킹 배치 없음)의 패킹존 이동 수동 표시
  if (op === 'setManualPackingMoved') return json_(setManualPackingMoved(data));
  // ★ 2026-08-31 신규 — Order Detail Lookup에서 검수완료 오더의 배송방법 수정
  if (op === 'updateOrderMethod') return json_(updateOrderMethod(data));
  // ★ 2026-09-02 신규 — PU 결제확인(Order Detail Lookup 전용)
  if (op === 'updatePaymentStatus') return json_(updatePaymentStatus(data));
  // ★ 2026-08-06 신규 — 디멘션 합산(대표 인보이스 + 포함 오더). BatchPicking.gs에 구현됨.
  if (op === 'linkDimensions')   return json_(linkDimensions(data));
  if (op === 'unlinkDimensions') return json_(unlinkDimensions(data));
  if (op === 'setDimPrimary')    return json_(setDimPrimary(data));

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
  ensureManualPackingCol_(sh); // ★ 2026-08-06 신규
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

/* ★ 2026-08-06 신규 — 단독(총량피킹을 거치지 않는) 오더용 "패킹존 이동" 수동 표시.
 * 총량피킹 오더는 TV 현황판에서 파랑으로 바뀌면 BatchCustomers 시트의 TakenOut
 * 컬럼에 자동 기록되지만, 단독 오더는 애초에 그 시트에 아예 기록이 안 남아서
 * "Moved to Packing"이 영원히 No로 고정되는 문제가 있었음. 출고 작업자가 직접
 * 표시할 수 있도록 Jobs 시트에 별도 컬럼(PackingMovedManual: 시각,
 * PackingMovedManualBy: 누가)을 추가함. */
function ensureManualPackingCol_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) return;
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const hasFlag = headers.some(h => String(h).trim().toLowerCase() === 'packingmovedmanual');
  const hasBy = headers.some(h => String(h).trim().toLowerCase() === 'packingmovedmanualby');
  const add = [];
  if (!hasFlag) add.push('PackingMovedManual');
  if (!hasBy) add.push('PackingMovedManualBy');
  if (add.length) {
    const curLastCol = sh.getLastColumn();
    sh.insertColumnsAfter(curLastCol, add.length);
    sh.getRange(1, curLastCol + 1, 1, add.length).setValues([add]);
    __HDR_CACHE = null;
  }
}

/* ★ 2026-08-31 신규 — 영업팀이 처음엔 PU로 받았다가 나중에 UPS/TK로(또는 그
 * 반대로) 바뀌는 경우가 실제로 자주 있음. 예전엔 패킹 작업자가 매니저에게
 * 요청 → 매니저가 구글시트에서 직접 Trucking 컬럼을 고치는 번거로운 흐름이었음.
 * 이제 검수 완료된 오더에 한해 Order Detail Lookup 화면에서 패킹 작업자가
 * 직접 바로 고칠 수 있게 함. "누가/언제 바꿨는지"는 감사 추적용으로 남김
 * (PackingMovedManualBy와 같은 패턴). */
function ensureMethodChangeCol_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) return;
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const hasAt = headers.some(h => String(h).trim().toLowerCase() === 'methodchangedat');
  const hasBy = headers.some(h => String(h).trim().toLowerCase() === 'methodchangedby');
  const hasOrig = headers.some(h => String(h).trim().toLowerCase() === 'originalmethod');
  const add = [];
  if (!hasAt) add.push('MethodChangedAt');
  if (!hasBy) add.push('MethodChangedBy');
  if (!hasOrig) add.push('OriginalMethod');
  if (add.length) {
    const curLastCol = sh.getLastColumn();
    sh.insertColumnsAfter(curLastCol, add.length);
    sh.getRange(1, curLastCol + 1, 1, add.length).setValues([add]);
    __HDR_CACHE = null;
  }
}

/* updateOrderMethod — ★ 2026-08-31 신규. Order Detail Lookup(Screen 2)에서만
 * 호출되는 걸 전제로 함(클라이언트에서 검수 완료된 오더에서만 수정 버튼을
 * 보여줌). 서버에서도 한 번 더 "검수가 완료된 오더인지"를 확인해서, 혹시
 * 다른 경로로 요청이 와도 검수 전 오더의 배송방법이 실수로 바뀌지 않게 막음.
 * 입력: { invoice, method('TK'|'UPS'|'PU'), by } */
function updateOrderMethod(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    const method = String((data && data.method) || '').trim().toUpperCase();
    const by = String((data && data.by) || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };
    const allowed = ['TK', 'UPS', 'PU'];
    if (allowed.indexOf(method) === -1) return { ok: false, error: 'method는 TK/UPS/PU 중 하나여야 합니다' };

    const sh = SHEET_();
    ensureMethodChangeCol_(sh);
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const row = findRowByKey_('invoice', invoice);
    if (!row) return { ok: false, error: 'invoice not found' };

    const iInsp = hdr[norm('Inspection')];
    if (iInsp) {
      const insp = String(sh.getRange(row, iInsp).getValue() || '').trim();
      if (!insp) return { ok: false, error: '검수가 아직 완료되지 않은 오더는 배송방법을 변경할 수 없습니다.' };
    }

    const iTruck = hdr[norm('Trucking')];
    if (!iTruck) return { ok: false, error: 'Trucking 컬럼을 찾지 못했습니다' };
    const oldMethod = String(sh.getRange(row, iTruck).getValue() || '').trim();
    if (oldMethod === method) return { ok: true, method: method, unchanged: true };

    const iAt = hdr[norm('MethodChangedAt')];
    const iBy = hdr[norm('MethodChangedBy')];
    const iOrig = hdr[norm('OriginalMethod')];
    sh.getRange(row, iTruck).setValue(method);
    if (iAt) sh.getRange(row, iAt).setValue(nowLocal_());
    if (iBy) sh.getRange(row, iBy).setValue(by);
    // ★ 최초 원래 배송방법은 한 번만 기록(이미 있으면 덮어쓰지 않음) — 여러 번
    //   바뀌어도 "영업팀이 처음에 뭐라고 했었는지"를 계속 추적할 수 있게 함.
    if (iOrig) {
      const existingOrig = String(sh.getRange(row, iOrig).getValue() || '').trim();
      if (!existingOrig) sh.getRange(row, iOrig).setValue(oldMethod);
    }

    bumpVersion_();
    // ★ 2026-08-31 — getSalesInvoiceDetail은 인보이스별로 6초 캐시가 있어서,
    //   수정 직후 화면을 새로고침해도 옛날 배송방법이 잠깐 보일 수 있음.
    //   그 캐시 키를 여기서 바로 지워서, 수정하자마자 항상 최신값이 보이게 함.
    try { CacheService.getScriptCache().remove('salesInvDetail_v1_' + invoice); } catch (e) {}
    return { ok: true, method: method, oldMethod: oldMethod };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ★ 2026-09-02 신규(매니저 요청) — PU(직접 픽업) 결제확인 컬럼.
 * [배경] PU 오더는 결제가 끝나야만 물건을 내줄 수 있는데, 이 정보를 영업팀만
 * 알고 창고는 알 방법이 없어서 미납 상태로 픽업이 나가는 사고가 실제로 있었음.
 * [범위] Order Detail Lookup(개별 오더 검색 화면)에서만 표시·수정 가능 —
 * "Recently Completed" 목록은 METHOD 컬럼 폭이 PU/TK/UPS 세 글자에 딱 맞춰져
 * 있어서 배지를 더 넣으면 잘리거나 레이아웃이 깨짐(매니저 확인 사항) — 그래서
 * 목록 쪽은 전혀 안 건드림. */
function ensurePaymentStatusCol_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) return;
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const hasStatus = headers.some(h => String(h).trim().toLowerCase() === 'paymentstatus');
  const hasAt = headers.some(h => String(h).trim().toLowerCase() === 'paymentstatusupdatedat');
  const hasBy = headers.some(h => String(h).trim().toLowerCase() === 'paymentstatusupdatedby');
  const add = [];
  if (!hasStatus) add.push('PaymentStatus');
  if (!hasAt) add.push('PaymentStatusUpdatedAt');
  if (!hasBy) add.push('PaymentStatusUpdatedBy');
  if (add.length) {
    const curLastCol = sh.getLastColumn();
    sh.insertColumnsAfter(curLastCol, add.length);
    sh.getRange(1, curLastCol + 1, 1, add.length).setValues([add]);
    __HDR_CACHE = null;
  }
}

/* updatePaymentStatus — Order Detail Lookup에서만 호출되는 걸 전제로 함
 * (클라이언트가 PU + 검수완료 + 패킹존 이동완료 조건을 만족할 때만 편집
 * 버튼을 보여줌). 서버에서도 이 세 조건을 그대로 다시 검증해서, 혹시
 * 다른 경로로 요청이 와도 이르거나 잘못된 시점에 실수로 입력되지 않게 막음.
 * 입력: { invoice, paid(true|false), by } */
function updatePaymentStatus(data) {
  try {
    const invoice = String((data && data.invoice) || '').trim();
    const paid = !!(data && data.paid);
    const by = String((data && data.by) || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };

    // ★ 2026-09-02 긴급 수정 — 예전엔 이 함수 전체(무거운 검증 포함)를 락 안에
    //   넣고 있었음. 이 스프레드시트는 batch.html/board.html/sales.html이 동시에
    //   공유해서 쓰는 문서라, 락을 오래 붙잡으면 그동안 다른 모든 저장 작업
    //   (스캔 기록·이슈 등록·슬롯 상태변경 등)이 줄줄이 밀려서, 심하면 읽기
    //   요청까지 전부 타임아웃되는 연쇄 장애로 이어질 수 있음(실제 발생 확인됨).
    //   그래서 읽기·검증(PU 여부, 검수완료 여부, 패킹존 이동 여부 확인)은 전부
    //   락 밖에서 먼저 끝내고, 락은 아래 "실제 값 쓰기" 그 몇 줄만 최소한으로 잡음.
    const sh = SHEET_();
    ensurePaymentStatusCol_(sh);
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const row = findRowByKey_('invoice', invoice);
    if (!row) return { ok: false, error: 'invoice not found' };

    const iTruck = hdr[norm('Trucking')];
    const method = iTruck ? String(sh.getRange(row, iTruck).getValue() || '').trim().toUpperCase() : '';
    if (method !== 'PU') return { ok: false, error: 'PU(직접 픽업) 오더만 결제 상태를 관리합니다' };

    const iInsp = hdr[norm('Inspection')];
    const insp = iInsp ? String(sh.getRange(row, iInsp).getValue() || '').trim() : '';
    if (!insp) return { ok: false, error: '검수가 아직 완료되지 않은 오더는 결제 상태를 입력할 수 없습니다' };

    // ★ 2026-09-02 재수정(속도) — getSalesInvoiceDetail()을 검증용으로 통째로
    //   다시 부르는 건 너무 무거웠음(BatchCustomers·IssueLog·Dimensions·DimLinks
    //   등을 전부 다시 계산). 저장 1번에 이 무거운 함수가 2번(검증용 1번 + 저장
    //   후 새로고침용 1번) 실행되면서 전체 처리 시간이 길어지고, 그로 인한
    //   타임아웃·재시도가 겹쳐 "로딩만 계속되다 결국 예전 값을 보여주는" 증상으로
    //   이어졌을 가능성이 높음. PU 오더는 디멘션을 안 쓰므로(TK/UPS만 해당),
    //   패킹존 이동 여부는 buildMovedToPackingMap_()만으로도 getSalesInvoiceDetail과
    //   결과가 동일하면서 훨씬 가벼움 — 이걸로 대체.
    let moved = false;
    try { moved = !!buildMovedToPackingMap_()[invoice]; } catch (e) { moved = false; }
    if (!moved) return { ok: false, error: '패킹존 이동이 완료되지 않은 오더는 결제 상태를 입력할 수 없습니다' };

    // ★ 실제 시트 쓰기 — 여기서부터만 짧게 락으로 보호
    const lock = LockService.getDocumentLock();
    lock.waitLock(10000);
    try {
      const iStatus = hdr[norm('PaymentStatus')];
      const iAt = hdr[norm('PaymentStatusUpdatedAt')];
      const iBy = hdr[norm('PaymentStatusUpdatedBy')];
      if (iStatus) sh.getRange(row, iStatus).setValue(paid ? 'paid' : 'unpaid');
      if (iAt) sh.getRange(row, iAt).setValue(nowLocal_());
      if (iBy) sh.getRange(row, iBy).setValue(by);
      bumpVersion_();
    } finally {
      lock.releaseLock();
    }

    try { CacheService.getScriptCache().remove('salesInvDetail_v1_' + invoice); } catch (e) {}
    return { ok: true, paid: paid };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
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
      ensureSheetRoom_(sh, rowIdx); // ★ 2026-08-12 신규 — 시트 행 부족 시 자동으로 미리 늘려둠 (BatchPicking.gs에 정의, 같은 프로젝트라 호출 가능)
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

  // ★ 2026-08-06 신규(매니저 요청) — 메인 대시보드(index.html)의 자동보관 규칙을
  //   "검수 다음날 무조건 삭제"에서 "디멘션 저장 시각 기준 영업일 2일 후"로
  //   바꾸기 위해, 각 인보이스의 디멘션 저장 여부·시각을 같이 내려줌.
  const dimsMap = buildDimsExistsMap_();

  const tz = Session.getScriptTimeZone();
  const jobs = rows.map((r, i) => ({
    _rowIndex: i + 2, // ★ 2026-07-29 신규: 원본 시트 행 번호를 미리 저장해둠(아래 메모 읽기용)
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
    // ★ 2026-08-31 버그 수정 — getSalesOverview와 같은 이유로 명시적으로 정규화.
    //   예전엔 원본 값(Date 객체일 수도, 문자열일 수도 있음)을 그대로 내려보내서
    //   JSON 직렬화 방식에 우연히 기대는 구조였음. Date 객체면 반드시 같은
    //   형식('yyyy-MM-dd HH:mm:ss')으로 통일해서, 이후 어디서든 이 값으로
    //   정렬/비교해도 항상 안전하게 함.
    createdAt: iCreated
      ? (r[iCreated - 1] instanceof Date ? Utilities.formatDate(r[iCreated - 1], tz, 'yyyy-MM-dd HH:mm:ss') : String(r[iCreated - 1] || ''))
      : '',
    archivedAt: iArchAt ? r[iArchAt - 1] : '',
    archived: iArch ? r[iArch - 1] : '',
    month: iMonth ? r[iMonth - 1] : '',
    processingMinutes: iProcMin ? r[iProcMin - 1] : '',
    inspection: iInsp ? r[iInsp - 1] : '',
    inspector:   iInspector ? String(r[iInspector - 1] || '') : '',
    inspEnd:     iInspEnd   ? formatInspEnd_(r[iInspEnd - 1]) : '',
    inspectionNote: '',
    dimsCount: (dimsMap[String(iInv ? r[iInv - 1] : '').trim()] || {}).count || 0,
    dimsEnteredAt: (dimsMap[String(iInv ? r[iInv - 1] : '').trim()] || {}).enteredAt || '',
  }));

  // ★ 2026-07-29 성능 개선 — 예전엔 "이미 보관 처리(archived)돼서 화면에 안 보일
  //   행"까지도 이슈 메모(getNote, 행마다 개별 API 호출이라 느림)를 전부 읽은
  //   뒤에야 걸러냈음. Jobs 시트가 수천 행까지 쌓인 상태라, 캐시가 만료된 직후
  //   첫 조회(cold load)마다 이 불필요한 메모 읽기가 누적되어 "fetchData timed
  //   out"까지 발생하는 원인이 됐음. 필터링을 먼저 해서, 실제로 화면에 보일
  //   행에 대해서만 메모를 읽도록 순서를 바꿈 — 결과는 완전히 동일하고 속도만 개선됨.
  const cleaned = jobs.filter(j => {
    const v = String(j.archived || '').trim().toLowerCase();
    return !(v === 'true' || v === '1' || v === 'y' || v === 'yes');
  });

  cleaned.forEach(job => {
    if (String(job.inspection || '').indexOf('ISSUES') >= 0) {
      try {
        job.inspectionNote = sh.getRange(job._rowIndex, iInsp).getNote() || '';
      } catch(e) { job.inspectionNote = ''; }
    }
    delete job._rowIndex; // 내부용 필드라 응답에는 안 실어 보냄
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

/* ★ 2026-08-06 신규 — 단독 오더(총량피킹 배치에 없는 오더)의 "패킹존 이동"을
 * 출고 작업자가 직접 표시. sales.html 2번 화면의 수동 버튼이 이걸 호출함.
 * 안전장치: 확인 팝업(confirm)을 거쳐야만 호출되도록 클라이언트에서 강제하고,
 * "실수로 눌렀을 때 되돌리기"도 이 함수로 그대로 처리(moved:false로 다시 호출).
 * 입력: { invoice, moved: true|false, by }
 * ============================================================ */
function setManualPackingMoved(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };
    const moved = !!(data && data.moved);
    const by = String((data && data.by) || '').trim();

    const sh = SHEET_(); // ensureJobsHeader_를 통해 컬럼 자동 보장됨
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const row = findRowByKey_('invoice', invoice);
    if (!row) return { ok: false, error: 'invoice not found' };

    const cFlag = hdr[norm('PackingMovedManual')];
    const cBy = hdr[norm('PackingMovedManualBy')];
    if (cFlag) sh.getRange(row, cFlag).setValue(moved ? nowLocal_() : '');
    if (cBy) sh.getRange(row, cBy).setValue(moved ? by : '');

    bumpVersion_();
    return { ok: true, moved: moved };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ★ 2026-08-06 긴급 신규 — 일회성 복구 함수. 자동보관 규칙이 "검수 다음날
 * 무조건 삭제"였던 예전 버그 때문에, 규칙을 고치기 전에 이미 잘못 archived=TRUE
 * 처리된 주문들이 있음(디멘션 저장 전이거나 영업일 2일이 아직 안 지났는데도
 * 삭제된 것들). 지금 archived=TRUE인 행 전부를 "새 규칙"으로 다시 판정해서,
 * 새 규칙으로는 아직 보관 대상이 아닌 것들을 원상복구(archived 비움)함.
 * Apps Script 에디터에서 딱 한 번 실행하면 됨 — 실행 후 다시 실행해도 안전함
 * (이미 정상인 것들은 그대로 둠, 새 규칙으로 정말 보관 대상인 것만 그대로 유지).
 * ============================================================ */
function repairPrematurelyArchivedJobs() {
  const sh = SHEET_();
  const hdr = headerMapCached_();
  const norm = normalizeHeaderName_;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('Jobs 시트에 데이터 없음'); return { ok: true, restored: 0 }; }

  const iInv = hdr[norm('Invoice')];
  const iArch = hdr[norm('archived')];
  const iArchAt = hdr[norm('archivedAt')];
  const iTruck = hdr[norm('Trucking')];
  const iInsp = hdr[norm('Inspection')];
  const iInspEnd = hdr[norm('Insp. End')];
  const iEndISO = hdr[norm('EndAtISO')];

  const dimsMap = buildDimsExistsMap_(); // BatchPicking.gs에 정의된 함수 재사용

  function needsDims(trucking) { const t = String(trucking || '').toUpperCase(); return t === 'TRUCKING' || t === 'TK' || t === 'UPS'; }
  function businessDaysSince(dateStr) {
    if (!dateStr) return -1;
    const s = String(dateStr).slice(0, 10);
    const trigger = new Date(s + 'T00:00:00');
    if (isNaN(trigger.getTime())) return -1;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let count = 0;
    const d = new Date(trigger.getTime());
    while (d.getTime() < today.getTime()) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return count;
  }
  function isInspected(insp) { const v = String(insp || '').trim(); return v.indexOf('PASS') >= 0 || v.indexOf('ISSUES') >= 0; }
  function toDateStr(v) {
    if (!v) return '';
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    return String(v).slice(0, 10);
  }

  const lastCol = sh.getLastColumn();
  const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  let restored = 0;
  const restoredInvoices = [];

  rows.forEach((r, i) => {
    const archVal = String(r[iArch - 1] || '').trim().toLowerCase();
    const isArchived = archVal === 'true' || archVal === '1' || archVal === 'y' || archVal === 'yes';
    if (!isArchived) return;

    const invoice = String(r[iInv - 1] || '').trim();
    if (!invoice) return;
    const trucking = r[iTruck - 1];
    const insp = r[iInsp - 1];
    if (!isInspected(insp)) return; // 검수 안 된 게 archived면 애초에 이상 케이스라 손대지 않음

    // ★ 2026-08-06 긴급 수정 — Dimensions 시트는 입력 2일 후 자동삭제되는 별도
    //   정리 기능이 있어서, 몇 주 전에 정상적으로 디멘션 입력하고 정상 보관된
    //   "오래된" 주문은 지금 시점엔 Dimensions 시트에 기록이 이미 자연스럽게
    //   없음 — 이걸 "디멘션 미입력"으로 오판해서 몇 달치 주문을 통째로 복구
    //   시켜버리는 사고가 실제로 발생했음(1,905건). 그래서 이 복구 함수는
    //   "검수완료일이 최근 N일 이내인 것"만 대상으로 하도록 안전장치를 추가함 —
    //   그보다 오래된 건 애초에 디멘션 기록 유무를 신뢰할 수 없으므로 손대지 않음.
    const RECENT_GUARD_DAYS = 4;
    const inspTrigger = toDateStr(r[iInspEnd - 1]) || toDateStr(r[iEndISO - 1]);
    if (!inspTrigger) return; // 검수완료일을 못 찾으면 안전하게 건드리지 않음
    const inspAgeMs = new Date() - new Date(inspTrigger + 'T00:00:00');
    if (inspAgeMs > RECENT_GUARD_DAYS * 86400000) return; // 최근이 아니면 절대 손대지 않음

    let eligible;
    if (needsDims(trucking)) {
      const dims = dimsMap[invoice];
      if (!dims || !dims.count) eligible = false; // 디멘션 저장 전 — 절대 보관 대상 아님
      else eligible = businessDaysSince(dims.enteredAt) >= 2;
    } else {
      const trigger = toDateStr(r[iInspEnd - 1]) || toDateStr(r[iEndISO - 1]);
      eligible = businessDaysSince(trigger) >= 2;
    }

    if (!eligible) {
      sh.getRange(i + 2, iArch).setValue('');
      if (iArchAt) sh.getRange(i + 2, iArchAt).setValue('');
      restored++;
      restoredInvoices.push(invoice);
    }
  });

  if (restored > 0) bumpVersion_();
  Logger.log('=== 복구 결과 ===');
  Logger.log('복구된(보관 해제된) 주문: ' + restored + '건');
  Logger.log(JSON.stringify(restoredInvoices, null, 2));
  return { ok: true, restored: restored, invoices: restoredInvoices };
}

/* ★★★ 2026-08-06 긴급 신규 — 되돌리기(사고 수습) 함수 ★★★
 * repairPrematurelyArchivedJobs()의 버그로 인해 몇 달치 오래된 주문
 * 1,905건이 실수로 "보관 해제(복구)"되어버린 사고를 바로잡음.
 * 지금 archived=FALSE(안 보관됨) 상태인 주문 중, 검수완료일이 오늘로부터
 * RECENT_KEEP_DAYS(4일)보다 오래된 것들은 전부 다시 archived=TRUE로 되돌림.
 * 최근 것(진짜 필요해서 복구해야 했던 것들)은 그대로 안 건드리고 남겨둠.
 * Apps Script 에디터에서 지금 바로 한 번 실행하면 됨.
 * ============================================================ */
function undoOverRestoredJobs() {
  const RECENT_KEEP_DAYS = 4; // 이 안쪽(최근)은 그대로 두고, 이보다 오래된 것만 다시 보관 처리

  const sh = SHEET_();
  const hdr = headerMapCached_();
  const norm = normalizeHeaderName_;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('Jobs 시트에 데이터 없음'); return { ok: true, reArchived: 0 }; }

  const iInv = hdr[norm('Invoice')];
  const iArch = hdr[norm('archived')];
  const iArchAt = hdr[norm('archivedAt')];
  const iInsp = hdr[norm('Inspection')];
  const iInspEnd = hdr[norm('Insp. End')];
  const iEndISO = hdr[norm('EndAtISO')];

  function isInspected(insp) { const v = String(insp || '').trim(); return v.indexOf('PASS') >= 0 || v.indexOf('ISSUES') >= 0; }
  function toDateStr(v) {
    if (!v) return '';
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    return String(v).slice(0, 10);
  }

  const lastCol = sh.getLastColumn();
  const rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  let reArchived = 0;
  const list = [];
  const cutoffMs = RECENT_KEEP_DAYS * 86400000;
  const nowMs = new Date().getTime();

  rows.forEach((r, i) => {
    const archVal = String(r[iArch - 1] || '').trim().toLowerCase();
    const isArchived = archVal === 'true' || archVal === '1' || archVal === 'y' || archVal === 'yes';
    if (isArchived) return; // 이미 보관중이면 손대지 않음(정상)

    const insp = r[iInsp - 1];
    if (!isInspected(insp)) return; // 검수 안 된 활성 주문은 원래 안 보관 대상이므로 안 건드림

    const trigger = toDateStr(r[iInspEnd - 1]) || toDateStr(r[iEndISO - 1]);
    if (!trigger) return; // 날짜를 못 찾으면 안전하게 건드리지 않음

    const ageMs = nowMs - new Date(trigger + 'T00:00:00').getTime();
    if (ageMs > cutoffMs) {
      // 오래된 주문인데 지금 보관 안 된 상태 = 잘못 복구된 것 → 다시 보관 처리
      sh.getRange(i + 2, iArch).setValue('TRUE');
      if (iArchAt) sh.getRange(i + 2, iArchAt).setValue(nowLocal_());
      reArchived++;
      list.push(String(r[iInv - 1] || ''));
    }
  });

  if (reArchived > 0) bumpVersion_();
  Logger.log('=== 되돌리기 결과 ===');
  Logger.log('다시 보관 처리된 주문(오래된 것들, 원상복구): ' + reArchived + '건');
  Logger.log('최근 ' + RECENT_KEEP_DAYS + '일 이내 주문은 그대로 유지됨(정상)');
  return { ok: true, reArchived: reArchived, sample: list.slice(0, 100) };
}


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

// ★ 2026-07-14 신규 — 체크박스로 선택한 여러 건을 한번에 처리하는 벌크 버전.
//   saveInspection()과 저장 로직은 동일하되, 시트를 한 번만 열고 인보이스
//   위치도 한 번만 스캔해서, 건별로 따로 호출할 때보다 훨씬 빠름.
function saveInspectionBulk_(dataList) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    if (!Array.isArray(dataList) || !dataList.length) return { ok: false, error: 'empty list' };

    var ss      = SpreadsheetApp.openById(SS_ID);
    var sheet   = ss.getSheetByName(JOBS_SHEET);
    var lastRow = sheet.getLastRow();
    var tz      = Session.getScriptTimeZone();

    function fmtTime(isoStr) {
      if (!isoStr) return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
      try { return Utilities.formatDate(new Date(isoStr), tz, 'yyyy-MM-dd HH:mm:ss'); }
      catch (e) { return String(isoStr); }
    }

    // 인보이스 → 행번호 매핑을 딱 한 번만 만들어서 재사용
    var invoiceCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var rowMap = {};
    for (var i = 0; i < invoiceCol.length; i++) {
      rowMap[String(invoiceCol[i][0]).trim()] = i + 2;
    }

    var results = [];
    dataList.forEach(function(data) {
      var targetRow = rowMap[String(data.invoice || '').trim()];
      if (!targetRow) { results.push({ invoice: data.invoice, ok: false, error: 'not found' }); return; }

      var inspEndAt = fmtTime(data.inspEndAt || data.inspectedAt);
      var inspector = String(data.inspector || '').trim();
      var cell = sheet.getRange(targetRow, 19);

      if (data.pass && (!data.issues || data.issues.length === 0)) {
        cell.setValue('✓ PASS');
        cell.setBackground('#0d2e1a');
        cell.setFontColor('#10b981');
        cell.setFontWeight('bold');
        cell.setNote('✓ PASS\nCompleted: ' + inspEndAt + (inspector ? '\nInspector: ' + inspector : ''));
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
        if (data.memo && data.memo.trim() !== '') { noteLines.push(''); noteLines.push('Note: ' + data.memo); }
        noteLines.push(''); noteLines.push('Completed: ' + inspEndAt);
        if (inspector) noteLines.push('Inspector: ' + inspector);
        cell.setNote(noteLines.join('\n'));
      }

      if (inspector) {
        sheet.getRange(targetRow, 20).setValue(inspector);
      } else {
        var existing = sheet.getRange(targetRow, 20).getValue();
        if (!existing) sheet.getRange(targetRow, 20).setValue('(Unknown)');
      }
      sheet.getRange(targetRow, 21).setValue(inspEndAt);
      results.push({ invoice: data.invoice, ok: true, row: targetRow });
    });

    var sH = sheet.getRange(1, 19); if (!sH.getValue()) { sH.setValue('Inspection'); sH.setFontWeight('bold'); }
    var tH = sheet.getRange(1, 20); if (!tH.getValue()) { tH.setValue('Inspector'); tH.setFontWeight('bold'); }
    var uH = sheet.getRange(1, 21); if (!uH.getValue()) { uH.setValue('Insp. End'); uH.setFontWeight('bold'); }

    bumpVersion_();
    return { ok: true, results: results };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

// ★ 2026-07-14 신규 — 오더 선점(claim) 기능. CacheService를 씀(3분 후 자동 만료라
//   작업자가 앱을 닫고 안 돌아와도 그 오더가 영원히 잠기지 않음).
function claimInspection_(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const invoice = String(data.invoice || '').trim();
    const worker = String(data.worker || '').trim();
    if (!invoice || !worker) return { ok: false, error: 'invoice, worker required' };

    const cache = CacheService.getScriptCache();
    const key = 'insp_claim_' + invoice;
    const existingRaw = cache.get(key);
    if (existingRaw) {
      let existing;
      try { existing = JSON.parse(existingRaw); } catch (e) { existing = null; }
      if (existing && existing.worker && existing.worker !== worker) {
        // 이미 다른 사람이 선점 중 — 거부
        return { ok: false, claimedBy: existing.worker, claimedAt: existing.at };
      }
    }
    // 선점 성공 (또는 본인이 이미 선점한 걸 갱신) — 3분(180초) 후 자동 만료
    cache.put(key, JSON.stringify({ worker: worker, at: new Date().toISOString() }), 180);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

function releaseInspectionClaim_(data) {
  try {
    const invoice = String(data.invoice || '').trim();
    if (!invoice) return { ok: false };
    CacheService.getScriptCache().remove('insp_claim_' + invoice);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
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

    // ★ 2026-08-20 긴급 수정 — 실제 영업시트를 확인해보니 이 칸의 헤더 이름이
    //   "Date"가 아니라 "TAWA"로 되어 있었음(영업팀 내부 명칭으로 추정, 값 자체는
    //   인보이스 등록일이 정상적으로 들어있음 — 예: 08/13/2026). 정확히 "Date"만
    //   찾다 보니 못 찾고 계속 "Date column not found"로 실패했던 것.
    //   'TAWA'를 추가하고, 혹시 또 이름이 바뀔 경우를 대비해 흔한 이름들도 같이 인식.
    const colDate         = findCol(['TAWA', 'Date', 'Entry Date', 'Created', 'Order Date']);
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
    // ★ 2026-08-19 신규(긴급) — index.html 로드 시마다(+30분마다 자동) 부르는데,
    //   여러 매니저가 거의 동시에 페이지를 열면 한꺼번에 몰릴 수 있어서 30초
    //   캐시로 완화(어차피 30분 주기라 30초 정도는 지연으로 느낄 수준이 아님).
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'revenueSummary_v1';
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

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

    const _result = { ok: true, summary: summary };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 30);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;

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
    // ★ 2026-08-19 신규(긴급) — index.html이 5분마다 자동 조회 + 페이지 로드
    //   시 즉시 1회 조회하는데, 여러 매니저가 거의 동시에 페이지를 열면
    //   한꺼번에 몰릴 수 있어서 60초 캐시로 완화(5분 주기 대비 충분히 짧음).
    var _cache = CacheService.getScriptCache();
    var _cacheKey = 'shipSchedule_v1';
    var _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

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

    var _result = {
      ok: true,
      schedule: buckets,
      dates: { today: today, d1: d1, d2: d2 },
      asOf: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')
    };
    try {
      var _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 60);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;

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

/* ---------------------------------------------------------------------
 * buildMovedToPackingMap_() — BatchCustomers 시트를 한 번만 읽어서
 * {invoice: movedToPacking(boolean)} 맵으로 만듦. 여러 인보이스를
 * 한꺼번에 조회할 때(오늘 목록, 시트 미리보기) 인보이스마다 따로
 * 시트를 뒤지지 않도록 공통 재사용.
 * ------------------------------------------------------------------- */
function buildMovedToPackingMap_() {
  const map = {};
  try {
    const bc = bcustSheetSafe_();
    const last = bc.getLastRow();
    if (last >= 2) {
      // ★ 2026-08-05 수정(매니저 요청) — 예전엔 K컬럼(MovedToPacking, TV 카드가
      //   핑크로 바뀌는 순간 = "패킹존 이동 필요"로 표시된 시각)을 기준으로 영업
      //   공유 페이지의 "Moved" 상태를 판단했음. 그런데 실제로는 검수팀이 핑크로
      //   바꿔서 "가지고 가라"고 표시해도, 출고팀이 실제로 가져가지 않으면 아직
      //   이동한 게 아님 — 진짜 이동 완료 시점은 TV 카드가 파랑으로 바뀌는 순간
      //   (L컬럼, TakenOut)임. 그래서 이제 L컬럼을 기준으로 판단하도록 변경.
      //   12번째 컬럼(L)까지 읽어야 하므로 범위를 11→12로 확장.
      bc.getRange(2, 1, last - 1, 12).getValues().forEach(r => {
        const inv = String(r[1] || '').trim();
        if (!inv) return;
        map[inv] = !!r[11]; // r[11] = L컬럼(TakenOut) — 나중 행(더 최근 배치)이 앞선 값을 덮어씀 = 최신 상태 유지
      });
    }
  } catch (e) { /* best-effort */ }

  // ★ 2026-08-06 신규 — 단독 오더(총량피킹 배치가 아예 없는 오더)는 위 BatchCustomers
  //   경로로는 절대 true가 될 수 없어서, Jobs 시트의 수동 표시(PackingMovedManual)도
  //   같이 OR로 합쳐줌. 이미 배치 기반으로 true인 건 안 건드림(덮어쓰지 않음).
  try {
    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const iInv = hdr[norm('Invoice')];
    const iManual = hdr[norm('PackingMovedManual')];
    const lastRow = sh.getLastRow();
    if (iInv && iManual && lastRow >= 2) {
      const invVals = sh.getRange(2, iInv, lastRow - 1, 1).getValues();
      const manualVals = sh.getRange(2, iManual, lastRow - 1, 1).getValues();
      for (let i = 0; i < invVals.length; i++) {
        const inv = String(invVals[i][0] || '').trim();
        if (!inv) continue;
        if (manualVals[i][0]) map[inv] = true; // 이미 true였으면 그대로, false/미기록이었으면 true로 승격
      }
    }
  } catch (e) { /* best-effort */ }

  return map;
}

/* ---------------------------------------------------------------------
 * buildPackStageMap_() — ★ 2026-08-24 신규 (오출고 방지 신기능 연동)
 * sales.html이 기존의 boolean(movedToPacking)만으로는 파랑(패킹존 이동완료)과
 * 주황(최종 2차 검증완료)을 구분할 수 없어서, 4단계 문자열 상태를 별도로
 * 계산해서 반환. (K=핑크/L=파랑의 기존 의미·계산 방식은 절대 안 건드림 — 이
 * 함수는 그 뒤에 M=주황(최종 검증완료)만 추가로 얹어주는 것.)
 * 반환: { invoice: 'none'|'moved'|'taken'|'verified' }
 * ------------------------------------------------------------------- */
function buildPackStageMap_() {
  const map = {};
  try {
    const bc = bcustSheetSafe_();
    const last = bc.getLastRow();
    if (last < 2) return map;
    const rows = bc.getRange(2, 1, last - 1, 13).getValues();
    rows.forEach(r => {
      const inv = String(r[1] || '').trim();
      if (!inv) return;
      if (r[12]) map[inv] = 'verified';       // M컬럼: 최종 2차 검증완료(주황)
      else if (r[11]) map[inv] = 'taken';     // L컬럼: 패킹존 이동완료(파랑) — 기존 그대로
      else if (r[10]) map[inv] = 'moved';     // K컬럼: 이동대기(핑크) — 기존 그대로
      else map[inv] = 'none';
    });
  } catch (e) { /* best-effort */ }
  return map;
}

/* =====================================================================
 * autoDeleteOldJobs() — ★ 2026-08-24 신규 (버그 수정)
 *
 * ★★★ 근본 원인 발견 ★★★
 * 지금까지 "완료건 자동 삭제"는 서버가 아니라 index.html(매니저 대시보드)
 * 브라우저 탭 안의 자바스크립트 타이머(AutoDelete 객체)에만 의존하고 있었음.
 * 즉 그 화면이 실제로 열려 있고, 그 컴퓨터가 자정을 넘겨서까지 계속 켜져
 * 있어야만 실제로 정리가 일어나는 구조였음(서버는 "지워도 되는지 규칙만
 * 검증"할 뿐, 먼저 나서서 지우자고 하지 않았음). 그래서 index.html을 밤새
 * 켜둔 날이 없으면 그날치 정리가 통째로 안 일어났고, 오래된 완료건이
 * sales.html "Recently Completed" 목록에 계속 쌓이는 문제로 이어졌음.
 *
 * 이 함수는 정확히 같은 판정 규칙(jobArchiveCheck_ — 위 3300번대)을 서버가
 * 직접 매일 새벽에 돌려서, 브라우저가 단 하나도 안 열려 있어도 정리가
 * 실제로 일어나게 만듦. 규칙 자체(영업일 3일, TK/UPS는 디멘션 저장 후
 * 기준)는 전혀 안 바뀜 — 실행 주체만 "브라우저"에서 "서버 트리거"로 옮김.
 * ===================================================================== */
function autoDeleteOldJobs() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const last = sh.getLastRow();
    if (last < 2) { Logger.log('autoDeleteOldJobs: 데이터 없음'); return { ok: true, checked: 0, deleted: 0 }; }

    const iInv = hdr[norm('Invoice')];
    // ★ 2026-08-28 긴급 버그 수정 — 예전엔 여기서 "Status"(피킹 진행 상태) 컬럼이
    //   'completed'인 것만 검사 대상으로 추렸음. 그런데 Status는 검수 완료
    //   여부와 다른, 순수 "피킹" 상태 필드임(getSalesOverview의 기존 주석에도
    //   "검수는 PASS인데 피킹 기록(Status)이 전혀 없었던" 실제 불일치 사례가
    //   남아있음). 그래서 검수는 이미 끝나서 진짜 삭제 대상이어야 할 오더가,
    //   피킹 세션 기록이 어떤 이유로 'completed'로 안 찍혀 있다는 이유만으로
    //   jobArchiveCheck_(진짜 판정 로직)까지 가보지도 못하고 걸러지는 사고가
    //   있었음. 삭제 대상 여부는 "검수(Inspection)가 끝났는지"로 판단해야
    //   맞으므로, 그 기준으로 바로잡음(jobArchiveCheck_ 내부 규칙과 일치).
    const iInsp = hdr[norm('Inspection')];
    const iArch = hdr[norm('archived')];
    if (!iInv || !iInsp) { Logger.log('autoDeleteOldJobs: 필요 컬럼(Invoice/Inspection)을 찾지 못함'); return { ok: false, error: '필요 컬럼 없음' }; }

    const n = last - 1;
    const invCol = sh.getRange(2, iInv, n, 1).getValues();
    const inspCol = sh.getRange(2, iInsp, n, 1).getValues();
    const archCol = iArch ? sh.getRange(2, iArch, n, 1).getValues() : null;

    const targets = [];
    for (let i = 0; i < n; i++) {
      const invoice = String(invCol[i][0] || '').trim();
      if (!invoice) continue;
      const insp = String(inspCol[i][0] || '').trim();
      if (!insp) continue; // 검수 안 끝난 건만 제외(진행중 오더는 절대 안 건드림)
      const archFlag = archCol ? String(archCol[i][0] || '').trim().toLowerCase() : '';
      if (archFlag === 'true' || archFlag === '1' || archFlag === 'y') continue; // 이미 보관된 건은 다시 검사 안 함
      targets.push(invoice);
    }

    let deleted = 0;
    targets.forEach(invoice => {
      const chk = jobArchiveCheck_(invoice); // ★ sales.html/index.html과 완전히 동일한 규칙으로 판정
      if (chk.eligible) { deleteJob_(invoice); deleted++; }
    });

    if (deleted > 0) bumpVersion_(); // 캐시 무효화 — 다음 조회부터 바로 반영
    Logger.log('autoDeleteOldJobs: 완료건 ' + targets.length + '건 검사, ' + deleted + '건 보관 처리(3일/영업일 기준 충족)');
    return { ok: true, checked: targets.length, deleted: deleted };
  } catch (e) {
    Logger.log('autoDeleteOldJobs 오류: ' + String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* 트리거 설치 — Apps Script 편집기에서 이 함수를 딱 한 번 수동 실행해야 함
 * (함수 목록에서 setupAutoDeleteOldJobsTrigger 선택 → ▶ 실행).
 * 그 이후로는 매일 새벽 1시~2시 사이에 자동으로 autoDeleteOldJobs()가 실행됨 —
 * autoDeleteOldDimensions와 같은 시간대라 순서가 꼬일 일 없음. */
function setupAutoDeleteOldJobsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'autoDeleteOldJobs') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoDeleteOldJobs')
    .timeBased()
    .atHour(1) // 새벽 1시~2시 사이 자동 실행
    .everyDays(1)
    .create();
  Logger.log('✅ 트리거 설정 완료 — 매일 새벽 1시경, 서버가 직접 영업일 3일 지난 완료건을 자동 보관 처리합니다(브라우저가 안 열려 있어도 동작).');
}
function removeAutoDeleteOldJobsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'autoDeleteOldJobs') ScriptApp.deleteTrigger(t);
  });
  Logger.log('트리거 삭제 완료');
}

/* =====================================================
 * ★ 2026-07-28 신규 — 영업 공유: 오늘 완료된 오더 경량 조회
 * listJobs 전체를 재사용하지 않고, Jobs 시트에서 딱 필요한 필드만
 * 읽고 오늘 날짜(Insp. End 기준)로 서버에서 걸러서 반환.
 * ISSUES 건마다 getNote()를 개별 호출하지 않으므로 훨씬 빠름.
 * ===================================================== */
function getSalesTodayList() {
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'salesToday_cache_v1';
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* 캐시 파싱 실패 시 그냥 새로 조회 */ }
    }

    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: true, jobs: [] };

    const iInv      = hdr[norm('Invoice')];
    const iRemarks   = hdr[norm('Remarks')];
    const iShip      = hdr[norm('Ship Date')];
    const iTruck     = hdr[norm('Trucking')];
    const iInsp      = hdr[norm('Inspection')];
    const iInspEnd   = hdr[norm('Insp. End')];
    const iArch      = hdr[norm('archived')]; // ★ 2026-08-06 신규
    if (!iInv || !iInsp || !iInspEnd) return { ok: true, jobs: [] };

    const tz = Session.getScriptTimeZone();
    const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

    const invVals     = sh.getRange(2, iInv, lastRow - 1, 1).getValues();
    const remarksVals = iRemarks ? sh.getRange(2, iRemarks, lastRow - 1, 1).getValues() : null;
    const shipVals    = iShip ? sh.getRange(2, iShip, lastRow - 1, 1).getValues() : null;
    const truckVals   = iTruck ? sh.getRange(2, iTruck, lastRow - 1, 1).getValues() : null;
    const inspVals    = sh.getRange(2, iInsp, lastRow - 1, 1).getValues();
    const inspEndVals = sh.getRange(2, iInspEnd, lastRow - 1, 1).getValues();
    const archVals    = iArch ? sh.getRange(2, iArch, lastRow - 1, 1).getValues() : null; // ★ 2026-08-06 신규

    const movedMap = buildMovedToPackingMap_();
    const dimsMap = buildDimsExistsMap_();
    const packStageMap = buildPackStageMap_(); // ★ 2026-08-24 신규 — 4단계 패킹 상태(none/moved/taken/verified)

    // ★ 2026-08-06 재설계(매니저 요청) — 예전엔 "오늘 날짜에 검수완료된 것"만
    //   보여줬음. 그런데 이제 자동보관 규칙이 "검수 다음날"이 아니라 "디멘션
    //   저장 후 영업일 2일"로 늘어나서, 1번 표(Sales Sheet Preview)에는 여러
    //   날짜에 걸친 주문이 계속 남아있는데 이 목록은 "오늘"만 보여줘서 1번과
    //   전혀 안 맞아 보이는 문제가 있었음(1번엔 60건 검수완료인데 여기는 1건).
    //   이제 "오늘"이 아니라 "아직 보관 처리 안 된 것 전부"(1번 표와 완전히
    //   동일한 기준)로 바꿔서, 두 화면이 항상 정확히 같은 데이터를 보여주게 함.
    const jobs = [];
    for (let i = 0; i < invVals.length; i++) {
      if (archVals) {
        const a = String(archVals[i][0] || '').trim().toLowerCase();
        if (a === 'true' || a === '1' || a === 'y' || a === 'yes') continue; // 보관된 건 제외
      }
      const insp = String(inspVals[i][0] || '').trim();
      if (!insp) continue; // 검수 안 된 건 이 목록 대상 아님(원래도 그랬음)
      const inspEnd = formatInspEnd_(inspEndVals[i][0]);
      const invoice = String(invVals[i][0] || '');
      const shipRaw = shipVals ? shipVals[i][0] : '';
      const shipDate = shipRaw instanceof Date ? Utilities.formatDate(shipRaw, tz, 'yyyy-MM-dd') : String(shipRaw || '');
      jobs.push({
        invoice: invoice,
        remarks: remarksVals ? remarksVals[i][0] : '',
        shipDate: shipDate,
        method: truckVals ? truckVals[i][0] : '',
        inspection: insp,
        inspEnd: inspEnd,
        // ★ 2026-08-06 신규(매니저 요청) — 디멘션이 저장돼 있으면 물리적으로
        //   이미 패킹존에서 측정된 것이므로 자동으로 이동완료로 인정.
        movedToPacking: !!movedMap[invoice] || ((dimsMap[invoice] || {}).count || 0) > 0,
        dimsCount: (dimsMap[invoice] || {}).count || 0,
        // ★ 2026-08-06 신규 — 이 오더의 디멘션이 다른(대표) 인보이스에 포함돼 있으면 그 번호
        dimsLinkedTo: (dimsMap[invoice] || {}).linkedTo || '',
        // ★ 2026-08-24 신규 — 오출고 방지: 핑크(moved)/파랑(taken)/주황(verified, 최종 2차 검증완료) 4단계.
        //   디멘션이 이미 저장된 건(수기 배송 준비 완료로 간주) taken(파랑)으로 승격.
        packStage: ((dimsMap[invoice] || {}).count || 0) > 0 ? 'taken' : (packStageMap[invoice] || 'none'),
      });
    }
    jobs.sort((a, b) => String(b.inspEnd).localeCompare(String(a.inspEnd)));

    const out = { ok: true, jobs: jobs, date: today };
    try { cache.put(cacheKey, JSON.stringify(out), 60); } catch (e) { /* 캐시 실패해도 정상 응답은 계속 진행 */ }
    return out;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), jobs: [] };
  }
}

/* =====================================================
 * ★ 2026-07-28 신규 — 영업 공유: 시트 미리보기 화면용 전체 목록
 * (검수 여부 무관, 보관 처리(archived) 안 된 것 전부) — 시뮬레이션의
 * "① Sales Sheet Preview" 화면을 실제 데이터로 재현.
 * ===================================================== */
function getSalesOverview() {
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'salesOverview_cache_v1';
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* 캐시 파싱 실패 시 그냥 새로 조회 */ }
    }

    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: true, jobs: [] };

    const iInv      = hdr[norm('Invoice')];
    const iRemarks   = hdr[norm('Remarks')];
    const iShip      = hdr[norm('Ship Date')];
    const iTruck     = hdr[norm('Trucking')];
    const iAmount    = hdr[norm('Amount')];
    const iInsp      = hdr[norm('Inspection')];
    const iInspEnd   = hdr[norm('Insp. End')];
    const iArch      = hdr[norm('archived')];
    const iCreated   = hdr[norm('Created At')];
    const iStartISO  = hdr[norm('StartAtISO')];
    const iEndISO    = hdr[norm('EndAtISO')]; // ★ 2026-08-05 신규 — 피킹 완료 여부 판단용
    const iStatus    = hdr[norm('Status')];   // ★ 2026-08-06 신규 — 메인 대시보드와 기준을 100% 맞추기 위해
    if (!iInv) return { ok: true, jobs: [] };

    const tz = Session.getScriptTimeZone();
    const n = lastRow - 1;

    // ★ 2026-07-28 신규 — 성능 개선: 예전엔 전체 컬럼(lastCol개)을 통째로
    //   읽었는데, 실제 쓰는 건 9개뿐이라 나머지(잠금·비고 등)까지 매번 읽는
    //   낭비가 있었음. 필요한 컬럼만 각각 읽도록 바꿔서 시트에서 오고가는
    //   데이터량을 크게 줄임(getSalesTodayList와 동일한 방식).
    const invVals      = sh.getRange(2, iInv, n, 1).getValues();
    const remarksVals  = iRemarks  ? sh.getRange(2, iRemarks,  n, 1).getValues() : null;
    const shipVals      = iShip    ? sh.getRange(2, iShip,     n, 1).getValues() : null;
    const truckVals    = iTruck    ? sh.getRange(2, iTruck,    n, 1).getValues() : null;
    const amountVals   = iAmount   ? sh.getRange(2, iAmount,   n, 1).getValues() : null;
    const inspVals     = iInsp     ? sh.getRange(2, iInsp,     n, 1).getValues() : null;
    const inspEndVals  = iInspEnd  ? sh.getRange(2, iInspEnd,  n, 1).getValues() : null;
    const archVals     = iArch     ? sh.getRange(2, iArch,     n, 1).getValues() : null;
    const createdVals  = iCreated  ? sh.getRange(2, iCreated,  n, 1).getValues() : null;
    const startISOVals = iStartISO ? sh.getRange(2, iStartISO, n, 1).getValues() : null;
    const endISOVals   = iEndISO   ? sh.getRange(2, iEndISO,   n, 1).getValues() : null; // ★ 2026-08-05 신규
    const statusVals   = iStatus   ? sh.getRange(2, iStatus,   n, 1).getValues() : null; // ★ 2026-08-06 신규

    const movedMap = buildMovedToPackingMap_();
    const dimsMap = buildDimsExistsMap_();

    const jobs = [];
    for (let i = 0; i < n; i++) {
      if (archVals) {
        const a = String(archVals[i][0] || '').trim().toLowerCase();
        if (a === 'true' || a === '1' || a === 'y' || a === 'yes') continue;
      }
      const invoice = String(invVals[i][0] || '');
      if (!invoice) continue;
      const shipRaw = shipVals ? shipVals[i][0] : '';
      const shipDate = shipRaw instanceof Date ? Utilities.formatDate(shipRaw, tz, 'yyyy-MM-dd') : String(shipRaw || '');
      const createdRaw = createdVals ? createdVals[i][0] : '';
      // ★ 2026-08-31 긴급 버그 수정(진짜 원인) — 구글시트가 "2026-08-26 16:53:39"
      //   같은 문자열을 날짜/시간으로 자동 인식해서 내부적으로 Date 타입으로
      //   바꿔버리는 경우가 있음(전부는 아니고 일부 행만 — 정확히 왜 이런
      //   불일치가 생기는지는 특정 못 함). 예전엔 이걸 그냥 String()으로만
      //   감쌌는데, Date 객체를 String()하면 "Wed Aug 26 2026 16:53:39 GMT..."
      //   처럼 완전히 다른 형태의 문자열이 되어버림. 이 문자열이 순수 ISO
      //   문자열("2026-08-31")과 사전순으로 비교되면 "Wed"가 "2"보다 알파벳상
      //   뒤라서, 실제로는 훨씬 예전 날짜인데도 최신으로 잘못 정렬되는 사고로
      //   이어졌음(실제 발생 확인됨). Date 객체면 반드시 같은 형식
      //   ('yyyy-MM-dd HH:mm:ss')으로 다시 포맷해서, 문자열이든 Date든 항상
      //   똑같은 형태로 비교되게 함.
      const createdAt = createdRaw
        ? (createdRaw instanceof Date ? Utilities.formatDate(createdRaw, tz, 'yyyy-MM-dd HH:mm:ss') : String(createdRaw))
        : '';
      // 작업(피킹) 시작일 — StartAtISO의 날짜 부분만 추출.
      let pickStart = '';
      if (startISOVals) {
        const sv = startISOVals[i][0];
        if (sv instanceof Date && !isNaN(sv)) pickStart = Utilities.formatDate(sv, tz, 'yyyy-MM-dd');
        else { const s = String(sv || '').trim(); if (/^\d{4}-\d{2}-\d{2}/.test(s)) pickStart = s.slice(0, 10); }
      }
      // ★ 2026-08-06 긴급 수정 — 메인 대시보드와 영업 화면이 서로 다른 값을 보이던 문제.
      //
      //   [무엇이 문제였나]
      //   예전 규칙: 피킹완료 = EndAtISO 있음 || 검수값 있음
      //   여기서 뒷부분("검수가 됐으면 피킹도 끝난 것으로 인정")이 위험했음.
      //   실제로 IN00463486은 검수는 PASS인데 피킹 기록(Status/Start/End)이 전혀 없었고,
      //   그 결과 메인 대시보드는 READY, 영업 화면은 "✓ Complete"로 정반대를 표시했음.
      //   영업팀은 영업 화면을 믿고 고객에게 답하므로 이런 불일치는 절대 있으면 안 됨.
      //
      //   [새 규칙] 메인 대시보드와 똑같이 Jobs 시트의 Status를 기준으로 삼음.
      //   추측으로 메우지 않고, 기록된 사실만 그대로 보여줌.
      const jobStatus = statusVals ? String(statusVals[i][0] || '').trim().toLowerCase() : '';
      const pickComplete = (jobStatus === 'completed') || !!(endISOVals && endISOVals[i][0]);
      // 검수는 끝났는데 피킹 기록이 없는 경우 — 데이터가 어긋난 상태이므로
      // 조용히 "완료"로 덮지 않고 화면에 경고로 드러냄(원인 파악이 가능하도록).
      const inspVal = inspVals ? String(inspVals[i][0] || '').trim() : '';
      const pickAnomaly = !!inspVal && !pickComplete;
      jobs.push({
        invoice: invoice,
        remarks: remarksVals ? remarksVals[i][0] : '',
        shipDate: shipDate,
        pickStart: pickStart,
        pickComplete: pickComplete,
        status: jobStatus,          // ★ 2026-08-06 신규 — 메인 대시보드와 동일 기준
        pickAnomaly: pickAnomaly,   // ★ 2026-08-06 신규 — 검수됨인데 피킹 기록 없음
        method: truckVals ? truckVals[i][0] : '',
        amount: amountVals ? amountVals[i][0] : '',
        inspection: inspVals ? String(inspVals[i][0] || '').trim() : '',
        inspEnd: inspEndVals ? formatInspEnd_(inspEndVals[i][0]) : '',
        // ★ 2026-08-06 신규(매니저 요청) — 디멘션이 저장돼 있으면 물리적으로
        //   이미 패킹존에서 측정된 것이므로 자동으로 이동완료로 인정.
        movedToPacking: !!movedMap[invoice] || ((dimsMap[invoice] || {}).count || 0) > 0,
        dimsCount: (dimsMap[invoice] || {}).count || 0,
        // ★ 2026-08-06 신규 — 디멘션이 다른(대표) 인보이스에 포함돼 있으면 그 번호
        dimsLinkedTo: (dimsMap[invoice] || {}).linkedTo || '',
        createdAt: createdAt
      });
    }
    // ★ 2026-08-31 긴급 버그 수정 — 총량피킹으로 시작된 오더 중 일부가 실제로
    //   확인해보니 "Created At"이 비어있었음(원인 미상 — syncBatchJobsStart는
    //   Status/Picker/Start만 쓰고 Created At은 안 건드림. 이 행들이 정확히
    //   어떤 경로로 처음 만들어졌는지는 아직 못 찾았지만, 데이터를 함부로
    //   추측해서 채워넣는 대신 "정렬 목적"으로만 안전하게 보완함).
    //   Created At이 비어있으면, 이미 확실히 채워져 있는 걸 확인한 StartAtISO
    //   (=pickStart, 날짜만) 로 대신 정렬 기준을 삼음 — "방금 등록됨"을 놓쳐도
    //   "방금 피킹 시작됨"은 놓치지 않게 함. 서버가 최근 생성순으로 1차 정렬해서
    //   내려주면 sales.html이 다시 같은 기준으로 확정 정렬함.
    const sortKey = j => j.createdAt || j.pickStart || '';
    jobs.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

    const out = { ok: true, jobs: jobs.slice(0, 500) }; // 화면이 감당 못 할 정도로 많아지는 것 방지, 최근 500건
    try { cache.put(cacheKey, JSON.stringify(out), 60); } catch (e) { /* 캐시 실패해도 정상 응답은 계속 진행 */ }
    return out;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), jobs: [] };
  }
}

// ★ 2026-08-19 신규(긴급, 요청 합치기) — sales.html의 autoSync()가 30초마다
//   getSalesOverview + getSalesTodayList를 항상 같이(Promise.all) 부르는데,
//   이걸 한 요청으로 합침. 폴링 주기(30초)는 그대로, 요청 개수만 절반으로
//   줄임. 기존 두 함수는 그대로 남겨둠(다른 곳에서 개별로 계속 씀).
function getSalesOverviewAndToday() {
  try {
    const overviewRes = getSalesOverview();
    const todayRes = getSalesTodayList();
    return { ok: true, overview: overviewRes, today: todayRes };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
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

/* =====================================================================
 * ★★★ 2026-08-10 신규 — 서버측 보관 규칙 검증 (안전장치) ★★★
 *
 * [왜 필요한가 — 2026-08-08 실제 사고]
 * 자동보관은 브라우저(index.html)가 판단하고, 서버는 그 지시를 무조건 따랐음.
 * 그래서 어느 PC가 며칠 지난 index.html을 캐시로 물고 있다가 자정에 실행하면,
 * 그 옛날 규칙("검수 다음날 무조건 삭제")대로 멀쩡한 오더가 통째로 보관돼버림.
 * 실제로 8/7(금) 검수분이 8/8(토) 새벽 00:01~00:03에 전부 보관 처리됐음.
 *
 * [해결]
 * 서버가 직접 규칙을 검증한다. 클라이언트가 아무리 지우라고 해도, 규칙을
 * 만족하지 않으면 서버가 거부한다. 오래된 브라우저가 남아 있어도 안전함.
 * 매니저가 수동으로 지우는 경우에만 force=1을 붙여서 예외를 허용한다.
 *
 * [규칙 — index.html과 동일]
 *  - 검수 완료된 건만 대상
 *  - TK/UPS: 디멘션이 저장돼 있어야 하고, 저장일부터 영업일 3일 경과
 *  - 그 외(PU 등): 검수완료일부터 영업일 3일 경과
 *  - 토·일 및 미국 공휴일은 카운트에서 제외
 * ===================================================================== */

const KEEP_BUSINESS_DAYS_SERVER = 3;

function nthDow_(y, m, dow, n) {
  const d = new Date(y, m, 1);
  const shift = (dow - d.getDay() + 7) % 7;
  return new Date(y, m, 1 + shift + (n - 1) * 7);
}
function lastDow_(y, m, dow) {
  const d = new Date(y, m + 1, 0);
  const shift = (d.getDay() - dow + 7) % 7;
  return new Date(y, m + 1, 0 - shift);
}
function usHolidaySet_(y) {
  const pad = n => String(n).padStart(2, '0');
  const k = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  // ★ 2026-08-28 버그 수정 — 이 목록(자동삭제 판정용)이 BatchPicking.gs/sales.html의
  //   isUsFederalHoliday_(11개, "다음 영업일" 계산용)와 서로 다른 목록이었음.
  //   대통령의날·콜럼버스데이·베테랑데이가 여기만 빠져 있었음. 안 지워지는
  //   방향의 버그는 아니었지만(빠지면 오히려 더 빨리 지워지는 쪽), 시스템
  //   전체의 "영업일" 기준이 곳에 따라 다르면 안 되므로 11개로 통일함.
  const list = [
    k(new Date(y, 0, 1)),        // New Year's Day 1/1
    k(nthDow_(y, 0, 1, 3)),      // MLK (1월 셋째 월)
    k(nthDow_(y, 1, 1, 3)),      // Presidents Day (2월 셋째 월)
    k(lastDow_(y, 4, 1)),        // Memorial Day (5월 마지막 월)
    k(new Date(y, 5, 19)),       // Juneteenth
    k(new Date(y, 6, 4)),        // Independence Day
    k(nthDow_(y, 8, 1, 1)),      // Labor Day (9월 첫째 월)
    k(nthDow_(y, 9, 1, 2)),      // Columbus Day (10월 둘째 월)
    k(new Date(y, 10, 11)),      // Veterans Day 11/11
    k(nthDow_(y, 10, 4, 4)),     // Thanksgiving (11월 넷째 목)
    k(new Date(y, 11, 25))       // Christmas
  ];
  const set = {};
  list.forEach(d => { set[d] = true; });
  return set;
}
function isHoliday_(d) {
  const pad = n => String(n).padStart(2, '0');
  const key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return !!usHolidaySet_(d.getFullYear())[key];
}

/* 시트에서 온 값(Date 객체일 수도, 문자열일 수도)에서 yyyy-MM-dd만 뽑음 */
function ymdOf_(raw) {
  if (!raw) return '';
  if (Object.prototype.toString.call(raw) === '[object Date]' && !isNaN(raw)) {
    return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const m = String(raw).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

/* 기준일로부터 오늘까지 경과한 영업일 수 (토·일·미국 공휴일 제외) */
function businessDaysSince_(ymd) {
  if (!ymd) return -1;
  const parts = ymd.split('-');
  if (parts.length !== 3) return -1;
  const trigger = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(trigger.getTime())) return -1;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let count = 0;
  const d = new Date(trigger.getTime());
  while (d.getTime() < today.getTime()) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !isHoliday_(d)) count++;
  }
  return count;
}

/* ---------------------------------------------------------------------
 * jobArchiveCheck_(invoice) — 이 오더가 보관 가능한 상태인지 서버가 직접 판단.
 * 반환: { eligible: true|false, reason: '...' }
 * ------------------------------------------------------------------- */
function jobArchiveCheck_(invoice) {
  try {
    invoice = String(invoice || '').trim();
    if (!invoice) return { eligible: false, reason: 'invoice 없음' };

    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const last = sh.getLastRow();
    if (last < 2) return { eligible: false, reason: '데이터 없음' };

    const iInv = hdr[norm('Invoice')];
    if (!iInv) return { eligible: false, reason: 'Invoice 컬럼 없음' };
    const n = last - 1;
    const invCol = sh.getRange(2, iInv, n, 1).getValues();
    let row = -1;
    for (let i = 0; i < n; i++) {
      if (String(invCol[i][0] || '').trim() === invoice) { row = i + 2; break; }
    }
    if (row < 0) return { eligible: false, reason: '해당 오더를 찾을 수 없음' };

    const get = name => {
      const c = hdr[norm(name)];
      return c ? sh.getRange(row, c).getValue() : '';
    };
    const insp    = String(get('Inspection') || '').trim();
    const inspEnd = get('Insp. End');
    const endISO  = get('EndAtISO');
    const method  = String(get('Trucking') || '').trim().toUpperCase();

    // 검수가 안 끝난 건 절대 보관 대상 아님
    if (!insp) return { eligible: false, reason: '아직 검수되지 않음' };

    const needsDims = (method === 'TK' || method === 'TRUCKING' || method === 'UPS');
    if (needsDims) {
      const dimsMap = buildDimsExistsMap_();
      const d = dimsMap[invoice] || {};
      if (!d.count || d.count <= 0) return { eligible: false, reason: '디멘션 미입력 (TK/UPS는 필수)' };
      const days = businessDaysSince_(ymdOf_(d.enteredAt));
      if (days < KEEP_BUSINESS_DAYS_SERVER) {
        return { eligible: false, reason: '디멘션 저장 후 영업일 ' + days + '일 경과 (' + KEEP_BUSINESS_DAYS_SERVER + '일 필요)' };
      }
      return { eligible: true, reason: 'ok' };
    }

    const trigger = ymdOf_(inspEnd) || ymdOf_(endISO);
    const days = businessDaysSince_(trigger);
    if (days < KEEP_BUSINESS_DAYS_SERVER) {
      return { eligible: false, reason: '검수완료 후 영업일 ' + days + '일 경과 (' + KEEP_BUSINESS_DAYS_SERVER + '일 필요)' };
    }
    return { eligible: true, reason: 'ok' };
  } catch (e) {
    // 판단에 실패하면 "보관하지 않음"으로 — 지우는 쪽이 훨씬 위험하므로
    return { eligible: false, reason: '검증 중 오류: ' + String(e && e.message || e) };
  }
}

/* ---------------------------------------------------------------------
 * restoreWronglyArchived(fromYmd, toYmd) — 규칙을 어기고 보관된 오더를 되살림.
 *
 * archivedAt이 지정 기간 안에 있는 보관 건만 검사해서, 지금 규칙으로도
 * 보관 대상이 아닌 것만 되돌립니다. 규칙상 정당하게 보관된 건은 건드리지 않음.
 * (2026-08-06에 있었던 "과도 복구 사고"를 되풀이하지 않기 위해 기간을 반드시 지정)
 *
 * 사용: ...exec?op=restoreWronglyArchived&from=2026-08-08&to=2026-08-08
 * ------------------------------------------------------------------- */
function restoreWronglyArchived(fromYmd, toYmd) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    fromYmd = ymdOf_(fromYmd) || String(fromYmd || '').trim();
    toYmd   = ymdOf_(toYmd)   || String(toYmd || '').trim();
    if (!fromYmd || !toYmd) return { ok: false, error: 'from, to (yyyy-MM-dd) 가 모두 필요합니다' };

    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const last = sh.getLastRow();
    if (last < 2) return { ok: true, restored: 0, kept: 0 };

    const iInv = hdr[norm('Invoice')], iArch = hdr[norm('archived')], iArchAt = hdr[norm('archivedAt')];
    if (!iInv || !iArch) return { ok: false, error: 'Invoice/archived 컬럼을 찾을 수 없습니다' };

    const n = last - 1;
    const invCol  = sh.getRange(2, iInv, n, 1).getValues();
    const archCol = sh.getRange(2, iArch, n, 1).getValues();
    const atCol   = iArchAt ? sh.getRange(2, iArchAt, n, 1).getValues() : null;

    const restored = [], kept = [];
    for (let i = 0; i < n; i++) {
      const a = String(archCol[i][0] || '').trim().toLowerCase();
      if (!(a === 'true' || a === '1' || a === 'y' || a === 'yes')) continue;
      const at = atCol ? ymdOf_(atCol[i][0]) : '';
      if (!at || at < fromYmd || at > toYmd) continue;

      const invoice = String(invCol[i][0] || '').trim();
      if (!invoice) continue;
      const chk = jobArchiveCheck_(invoice);
      if (chk.eligible) { kept.push(invoice); continue; } // 규칙상 정당한 보관은 그대로 둠

      sh.getRange(i + 2, iArch).setValue('');
      if (iArchAt) sh.getRange(i + 2, iArchAt).setValue('');
      restored.push(invoice);
    }
    if (restored.length) bumpVersion_();
    Logger.log('restoreWronglyArchived: ' + restored.length + '건 복구, ' + kept.length + '건 유지');
    return { ok: true, restored: restored.length, kept: kept.length, restoredList: restored.slice(0, 50) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}
