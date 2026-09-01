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
// ★ 2026-07-22 신규 — 완료된 지 오래된 배치를 "삭제"가 아니라 "보관용 시트로 이동"
//   시킬 때 쓰는 짝지어진 Archive_ 시트 이름들. 메인 시트는 가볍게 유지하면서도
//   기록은 하나도 없어지지 않음(그냥 다른 탭으로 옮겨질 뿐).
const ARCHIVE_PREFIX = 'Archive_';
const BWORKERS_SHEET = 'BatchWorkers'; // ★ 2026-07-16 신규 — 총량피킹 "작업자 관리" 명단 서버 저장용
// ★ 2026-08-24 신규 — 패킹 검증 스캔 전용 로그. 검수(ScanLog)와 완전히 분리된
// 별도 감사기록. "검수에서 넘어온 물건이 실제로 이 고객사 것인지"를 패킹존에서
// 한 번 더 바코드로 확인하는 절차(오출고 방지)를 위해 신설.
const PACKSCAN_SHEET = 'PackScanLog';
// ★ 2026-08-25 신규 — 2차 검증(Pack Verify) 기능이 실제로 배포된 시점. 이보다
// 먼저 완료된 배치는 "검증"이라는 개념 자체가 없었으므로, getOpenBatches의
// "검증 안 되면 시간 무관 계속 보임" 규칙을 적용하면 안 됨(적용하면 몇 주 전
// 이미 정상 출고된 옛날 배치들까지 전부 되살아나는 사고로 이어짐 — 실제 발생).
const PACK_VERIFY_LAUNCH_MS = new Date(2026, 7, 24, 0, 0, 0).getTime(); // 2026-08-24 00:00 (월=0 기준이라 7=8월)

function batchTz_() { return Session.getScriptTimeZone(); }
function batchNow_() { return Utilities.formatDate(new Date(), batchTz_(), 'yyyy-MM-dd HH:mm:ss'); }

/* ===================== normBarcode_ (★ 2026-08-05 긴급 신규) =====================
 * ★★★ 매우 중요 — TV 현황판이 "스캔했는데 완료로 안 뜨는" 버그의 근본 원인 수정 ★★★
 *
 * 원인: BatchItems 시트는 Barcode 컬럼을 텍스트('@')로 고정해서 쓰기 때문에
 * "0"으로 시작하는 바코드(EAN-13/UPC 계열에 매우 흔함, 예: "0123456789012")도
 * 원본 그대로 보존됨. 그런데 ScanLog/IssueLog에 스캔·이슈를 appendRow로 쓸 때는
 * 이 텍스트 고정이 빠져 있었음 — 그 결과 순수 숫자로만 된 바코드를 구글시트가
 * 자동으로 "숫자" 타입으로 바꿔버리면서 앞자리 0이 통째로 사라짐
 * (예: "0123456789012" → 123456789012 → 다시 읽으면 "123456789012").
 *
 * 이러면 BatchItems 기준으로 만든 키("0123456789012|SKU001")와 ScanLog 기준으로
 * 만든 키("123456789012|SKU001")가 서로 달라져서, TV/웹의 진행률 계산이 그
 * 스캔을 "없는 것"으로 취급함 — 스캔 직후엔 클라이언트가 낙관적으로 화면을
 * 초록/완료로 보여주지만, 몇 초 뒤 서버 폴링이 이 어긋난 값(0)으로 덮어써서
 * 다시 미완료로 되돌아감. (2026-08-04 setPackingMoved 작업 시 발견된 정확히
 * 그 현상 — 여러 슬롯이 몇 개 SKU만 남기고 전부 진행중에 멈춰있던 이유)
 *
 * 수정 전략(이중 방어):
 *  1) 쓰기 시점 — logScan/logIssue가 이제 새 행을 쓰기 전에 Barcode/SKU
 *     컬럼을 텍스트로 먼저 고정함(BatchItems와 동일한 패턴). 이후로는 손상 자체가
 *     발생하지 않음.
 *  2) 읽기 시점(이 함수) — 이미 손상된 기존 데이터가 있어도 즉시 정상 작동하도록,
 *     바코드로 키를 만드는 모든 곳(getSlotProgress/getScanState/
 *     getInvoiceItemStatus/getOpenBatches 등)에서 이 함수로 정규화한 뒤 비교함.
 *     순수 숫자 문자열이면 앞자리 0을 제거해서 "0123..."과 "123..."이 항상 같은
 *     값으로 매칭되게 만듦. 문자가 섞인 바코드(알파벳 포함 등)는 원본 그대로 둠 —
 *     구글시트의 자동 숫자변환은 순수 숫자 문자열에만 적용되기 때문에, 정규화도
 *     그 경우에만 필요함. 배치.html(클라이언트)에도 동일한 로직의 normBarcode()
 *     함수가 있어 서버와 항상 같은 기준으로 키를 만듦.
 * ================================================================================ */
function normBarcode_(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return s;
  if (/^\d+$/.test(s)) {
    const stripped = s.replace(/^0+/, '');
    return stripped === '' ? '0' : stripped;
  }
  return s;
}

/* ===================== diagnoseInvoice (★ 2026-08-05 v2 — 문제 줄만 정밀 추적) =====================
 * v1에서 로그가 154줄 중간에 잘려서(구글 로그 출력 한도) 문제 있는 8개 줄을
 * 다 못 봤음 → v2는 "❌ 문제 있는 줄"만 출력하고, 그 바코드+SKU가 이 배치
 * 전체(다른 인보이스 포함) 어디에 스캔됐는지까지 추적해서 진짜 원인을 좁힘:
 *  - 배치 전체 어디에도 없음 → 스캔 자체가 서버에 한 번도 안 만들어짐(진짜 미스캔
 *    이거나, 스캔은 됐는데 저장 요청이 실패해서 유실됨 — gasCallWithRetry 3회
 *    실패 사례)
 *  - 다른 인보이스로 가 있음 → 잘못된 고객사에 배분된 것(다른 문제)
 *  - 같은 인보이스인데 result가 pass가 아니거나 status가 undone → 취소되거나
 *    스캔이 error/over로 잘못 기록된 것
 * 사용법은 v1과 동일 — DIAG_BATCH_ID, DIAG_INVOICE만 바꿔서 실행.
 * ================================================================================ */
function diagnoseInvoice() {
  const DIAG_BATCH_ID = 'B20260803-534B0F'; // ← 확인하려는 배치ID로 교체
  const DIAG_INVOICE = 'IN00462241';        // ← 확인하려는 인보이스로 교체 (예: 01번 슬롯)

  const batchId = DIAG_BATCH_ID, invoice = DIAG_INVOICE;

  // 1) BatchItems에서 이 인보이스가 필요로 하는 상품 줄 전체
  const bi = bitemsSheet_();
  const biLast = bi.getLastRow();
  const lines = [];
  const allBatchItemRows = []; // ★ v2: 배치 전체 BatchItems (바코드 중복/altVariants 점검용)
  if (biLast >= 2) {
    bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      allBatchItemRows.push({ invoice: String(r[1]), sku: String(r[2]), barcode: r[4] });
      if (String(r[1]) !== String(invoice)) return;
      lines.push({ sku: String(r[2]), name: String(r[3]), barcode: r[4], barcodeType: typeof r[4], reqQty: Number(r[5]) || 0 });
    });
  }

  // 2) ScanLog에서 "이 배치 전체"의 모든 스캔(인보이스 필터 없음 — v2 핵심)
  const sl = scanlogSheet_();
  const slLast = sl.getLastRow();
  const allScanRows = [];
  if (slLast >= 2) {
    sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      allScanRows.push({ barcode: r[4], barcodeType: typeof r[4], sku: String(r[5]), invoice: String(r[8]), result: r[9], status: r[10], qty: Number(r[11]) || 0, worker: r[3], time: String(r[2]) });
    });
  }
  const scanRows = allScanRows.filter(s => s.invoice === String(invoice));

  // 3) IssueLog에서 이 배치+인보이스의 활성 이슈
  const il = issuelogSheet_();
  const ilLast = il.getLastRow();
  const issueRows = [];
  if (ilLast >= 2) {
    il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      if (String(r[7]) !== String(invoice)) return;
      issueRows.push({ barcode: r[4], sku: String(r[5]), reason: r[9], qty: Number(r[10]) || 0, status: r[12] });
    });
  }

  // 4) 상품 줄마다 매칭 확인, 문제 있는 줄만 상세 추적
  const problems = [];
  let okCount = 0;
  lines.forEach(line => {
    const normKey = normBarcode_(line.barcode) + '|' + line.sku;
    let matchSum = 0;
    scanRows.forEach(s => {
      if (s.result !== 'pass' || s.status === 'undone') return;
      if (normBarcode_(s.barcode) + '|' + s.sku === normKey) matchSum += s.qty;
    });
    let issueQty = 0;
    issueRows.forEach(iss => {
      if (iss.status === 'undone') return;
      if (normBarcode_(iss.barcode) + '|' + iss.sku === normKey) issueQty += iss.qty;
    });
    const effectiveReq = Math.max(0, line.reqQty - issueQty);
    if (matchSum >= effectiveReq) { okCount++; return; }

    // ★ 문제 있는 줄 — 배치 전체에서 이 바코드+SKU가 어디 있는지 추적
    const elsewhere = allScanRows.filter(s => normBarcode_(s.barcode) + '|' + s.sku === normKey);
    const sameBarcodeOtherSku = allBatchItemRows.filter(r => normBarcode_(r.barcode) === normBarcode_(line.barcode) && r.sku !== line.sku);

    problems.push({
      SKU: line.sku, 상품명: line.name, 바코드: line.barcode,
      필요수량: line.reqQty, 이슈차감후필요: effectiveReq, 매칭된스캔합계: matchSum,
      이배치전체에서같은바코드SKU스캔기록: elsewhere.map(s => ({ 인보이스: s.invoice, 결과: s.result, 상태: s.status, 수량: s.qty, 작업자: s.worker, 시각: s.time })),
      같은바코드다른SKU존재: sameBarcodeOtherSku.map(r => ({ 인보이스: r.invoice, SKU: r.sku })),
    });
  });

  Logger.log('=== 진단 결과 v2: 배치 ' + batchId + ' / 인보이스 ' + invoice + ' ===');
  Logger.log('전체 ' + lines.length + '개 줄 중 정상 ' + okCount + '개 / 문제 ' + problems.length + '개');
  Logger.log(JSON.stringify(problems, null, 2));
  return { ok: true, totalLines: lines.length, okCount: okCount, problems: problems };
}

/* ===================== diagnoseBatchWide (★ 2026-08-05 신규 — 배치 전체 한 번에 진단) =====================
 * ★★★ 슬롯 하나씩 diagnoseInvoice 돌리는 대신, 배치 전체를 한 번에 훑어서 어느
 * 패턴이 얼마나 퍼져있는지 확인 ★★★
 *
 * 사용법: DIAG_BATCH_ID만 바꿔서 실행 → 실행 로그 확인 → 저에게 붙여넣기
 *
 * 배치 안의 모든 (인보이스, SKU) 줄 중 "필요수량을 못 채운" 줄을 전부 찾고,
 * 각각을 두 패턴으로 분류합니다:
 *  - 패턴A "다른 인보이스로는 배분됨" — 이 바코드는 배치 안 다른 고객사에게는
 *    정상적으로 스캔·배분됐는데, 유독 이 인보이스만 빠짐. 여러 인보이스에서
 *    반복되면 구조적 버그(특정 인보이스가 스캔 당시 대상 명단에서 누락되는 문제).
 *  - 패턴B "배치 전체에 스캔 기록이 아예 없음" — 이 상품은 이 배치 안 그 누구도
 *    스캔한 적이 없음. 실제로 아직 안 가져왔거나(진짜 미피킹), 스캔이 통째로
 *    누락된 것.
 * 요약에서 패턴A가 소수의 인보이스에 몰려있으면 그 인보이스(들)이 배치에
 * "나중에 추가"됐을 가능성이 매우 높습니다.
 * ================================================================================ */
function diagnoseBatchWide() {
  const DIAG_BATCH_ID = 'B20260803-534B0F'; // ← 확인하려는 배치ID로 교체
  const batchId = DIAG_BATCH_ID;

  const bi = bitemsSheet_();
  const biLast = bi.getLastRow();
  const custLines = []; // 고객사별 필요 줄만 (총량 행 제외)
  if (biLast >= 2) {
    bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      const inv = String(r[1]);
      if (!inv) return;
      custLines.push({ invoice: inv, sku: String(r[2]), name: String(r[3]), barcode: r[4], reqQty: Number(r[5]) || 0 });
    });
  }

  const sl = scanlogSheet_();
  const slLast = sl.getLastRow();
  const allScanRows = [];
  if (slLast >= 2) {
    sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      allScanRows.push({ barcode: r[4], sku: String(r[5]), invoice: String(r[8]), result: r[9], status: r[10], qty: Number(r[11]) || 0 });
    });
  }

  const il = issuelogSheet_();
  const ilLast = il.getLastRow();
  const allIssueRows = [];
  if (ilLast >= 2) {
    il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      allIssueRows.push({ barcode: r[4], sku: String(r[5]), invoice: String(r[7]), qty: Number(r[10]) || 0, status: r[12] });
    });
  }

  const patternA = []; // 다른 인보이스로는 배분됨
  const patternB = []; // 배치 전체 스캔기록 없음
  let okCount = 0;
  const invoiceCountInA = {}; // 패턴A에 몇 번 등장하는지 인보이스별 카운트 — 몰려있는 인보이스 찾기용

  custLines.forEach(line => {
    const normKey = normBarcode_(line.barcode) + '|' + line.sku;
    let matchSum = 0;
    allScanRows.forEach(s => {
      if (s.invoice !== line.invoice) return;
      if (s.result !== 'pass' || s.status === 'undone') return;
      if (normBarcode_(s.barcode) + '|' + s.sku === normKey) matchSum += s.qty;
    });
    let issueQty = 0;
    allIssueRows.forEach(iss => {
      if (iss.invoice !== line.invoice) return;
      if (iss.status === 'undone') return;
      if (normBarcode_(iss.barcode) + '|' + iss.sku === normKey) issueQty += iss.qty;
    });
    const effectiveReq = Math.max(0, line.reqQty - issueQty);
    if (matchSum >= effectiveReq) { okCount++; return; }

    const elsewhere = allScanRows.filter(s => normBarcode_(s.barcode) + '|' + s.sku === normKey && s.result === 'pass' && s.status !== 'undone');
    if (elsewhere.length > 0) {
      patternA.push({ 인보이스: line.invoice, SKU: line.sku, 상품명: line.name, 필요수량: line.reqQty, 매칭합계: matchSum, 다른곳배분횟수: elsewhere.length, 다른인보이스목록: [...new Set(elsewhere.map(s => s.invoice))] });
      invoiceCountInA[line.invoice] = (invoiceCountInA[line.invoice] || 0) + 1;
    } else {
      patternB.push({ 인보이스: line.invoice, SKU: line.sku, 상품명: line.name, 필요수량: line.reqQty });
    }
  });

  const invoiceCountSorted = Object.entries(invoiceCountInA).sort((a, b) => b[1] - a[1]);

  Logger.log('=== 배치 전체 진단: ' + batchId + ' ===');
  Logger.log('전체 상품줄 ' + custLines.length + '개 / 정상 ' + okCount + '개');
  Logger.log('패턴A(다른 곳엔 배분됐는데 이 인보이스만 빠짐) ' + patternA.length + '개');
  Logger.log('패턴B(배치 전체에 스캔기록 자체가 없음) ' + patternB.length + '개');
  Logger.log('--- 패턴A가 몰려있는 인보이스 순위(상위 10개) ---');
  Logger.log(JSON.stringify(invoiceCountSorted.slice(0, 10), null, 2));
  Logger.log('--- 패턴A 상세(최대 30개) ---');
  Logger.log(JSON.stringify(patternA.slice(0, 30), null, 2));
  Logger.log('--- 패턴B 상세(최대 30개) ---');
  Logger.log(JSON.stringify(patternB.slice(0, 30), null, 2));

  return { ok: true, total: custLines.length, okCount: okCount, patternACount: patternA.length, patternBCount: patternB.length, topInvoicesInA: invoiceCountSorted.slice(0, 10) };
}

/* ===================== bulkMarkAsShippedMiss (★ 2026-08-05 신규 — 일괄 정산 도구) =====================
 * ★★★ 실물 재고를 확인한 뒤에만 사용하세요 — 이 함수는 실제로 데이터를 씁니다 ★★★
 *
 * 목적: diagnoseBatchWide()로 찾은 "화면엔 미완료로 뜨지만 실제로는 이미 다
 * 출고된" 줄들을, 슬롯마다 일일이 "이슈 등록" 버튼을 누르지 않고 한 번에
 * MISS(스캔 누락, 실제 출고됨) 사유로 등록해서 정산. logIssue()를 그대로
 * 재사용하므로 IssueLog에 정상적으로 감사기록이 남고, 화면(TV/웹)도 바로
 * 완료로 바뀜.
 *
 * ⚠️ 반드시 실물(창고) 확인 후, "이 줄은 진짜로 이미 나갔다"고 확신하는 것만
 * LINES_TO_RESOLVE 배열에 넣어서 실행하세요. qty는 자동으로 "남은 부족분"만
 * 계산해서 등록하므로 직접 입력할 필요 없음(중복 이슈 방지 위해 이미 등록된
 * 이슈가 있으면 그만큼 빼고 계산함).
 *
 * 사용법:
 *   1) 아래 LINES_TO_RESOLVE 배열에 실물 확인 끝난 { invoice, sku } 쌍만 넣기
 *      (diagnoseBatchWide 결과의 "인보이스"/"SKU" 값 그대로 복사)
 *   2) 함수 목록에서 bulkMarkAsShippedMiss 선택 → ▶ 실행
 *   3) 실행 로그에서 몇 건 처리됐는지 확인
 *   4) TV 현황판 새로고침 → 해당 슬롯들이 초록으로 바뀌는지 확인
 * ================================================================================ */
function bulkMarkAsShippedMiss() {
  const DIAG_BATCH_ID = 'B20260803-534B0F'; // ← 배치ID
  const WORKER_NAME = '매니저(일괄정산)'; // ← 이슈 등록자로 표시될 이름, 원하면 실제 매니저 이름으로 교체

  // 🔴 실물 확인이 끝난 것만 여기 넣으세요. 확인 안 된 줄은 절대 넣지 마세요.
  const LINES_TO_RESOLVE = [
    // { invoice: 'IN00462241', sku: 'BODP04-M' },
    // { invoice: 'IN00462241', sku: 'JSMC02-FGUS' },
    // 여기에 실물 확인된 줄들을 계속 추가...
  ];

  if (LINES_TO_RESOLVE.length === 0) {
    Logger.log('⚠ LINES_TO_RESOLVE가 비어있습니다. 처리할 줄을 배열에 넣고 다시 실행하세요.');
    return { ok: false, error: 'LINES_TO_RESOLVE가 비어있음' };
  }

  const batchId = DIAG_BATCH_ID;

  // BatchItems에서 각 줄의 필요수량/상품정보 조회
  const bi = bitemsSheet_();
  const biLast = bi.getLastRow();
  const biRows = [];
  if (biLast >= 2) {
    bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      biRows.push({ invoice: String(r[1]), sku: String(r[2]), name: String(r[3]), barcode: r[4], reqQty: Number(r[5]) || 0 });
    });
  }

  const results = [];
  LINES_TO_RESOLVE.forEach(target => {
    const line = biRows.find(r => r.invoice === String(target.invoice) && r.sku === String(target.sku));
    if (!line) { results.push({ invoice: target.invoice, sku: target.sku, ok: false, error: 'BatchItems에서 해당 줄을 찾지 못함' }); return; }

    // 이미 스캔/이슈로 얼마나 채워졌는지 다시 계산해서, 정확히 "남은 부족분"만 등록
    const normKey = normBarcode_(line.barcode) + '|' + line.sku;
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    let scanned = 0;
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[8]) !== line.invoice) return;
        if (r[9] !== 'pass' || r[10] === 'undone') return;
        if (normBarcode_(r[4]) + '|' + String(r[5]) === normKey) scanned += Number(r[11]) || 0;
      });
    }
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    let existingIssueQty = 0;
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[7]) !== line.invoice) return;
        if (r[12] === 'undone') return;
        if (normBarcode_(r[4]) + '|' + String(r[5]) === normKey) existingIssueQty += Number(r[10]) || 0;
      });
    }
    const remaining = Math.max(0, line.reqQty - Math.max(0, scanned) - existingIssueQty);
    if (remaining <= 0) { results.push({ invoice: target.invoice, sku: target.sku, ok: true, skipped: true, reason: '이미 충분히 채워져 있어 등록 생략' }); return; }

    const res = logIssue({
      batchId: batchId, worker: WORKER_NAME, barcode: line.barcode, sku: line.sku, name: line.name,
      invoice: line.invoice, customer: '', reason: 'MISS', qty: remaining,
      note: '일괄 정산 도구로 등록됨 — 실물 확인 후 처리 (2026-08-05)',
    });
    results.push({ invoice: target.invoice, sku: target.sku, qty: remaining, ok: res.ok, issueId: res.issueId, error: res.error });
  });

  Logger.log('=== 일괄 MISS 정산 결과 ===');
  Logger.log(JSON.stringify(results, null, 2));
  const successCount = results.filter(r => r.ok && !r.skipped).length;
  Logger.log('성공: ' + successCount + '건 / 생략: ' + results.filter(r => r.skipped).length + '건 / 실패: ' + results.filter(r => !r.ok).length + '건');
  return { ok: true, results: results };
}

/* ===================== diagnoseFullBarcodeHistory (★ 2026-08-05 신규 — 상태 무관 전체 이력) =====================
 * ★★★ pass/over/error/undone 상태 전부 포함해서 이 바코드의 스캔 이력을 통째로 확인 ★★★
 * 목적: "분명히 스캔했는데 화면엔 안 잡힌다"는 현장 판단을 검증. 이전 진단들은
 * result==='pass'인 것만 "배분 기록"으로 쳤는데, 혹시 작업자가 재스캔했을 때
 * 시스템이 "이미 배분 완료됨"(over)으로 튕겨내서 그 시도 자체가 'pass'가 아닌
 * 다른 상태로 남아있을 수 있음 — 이 함수는 상태/결과 상관없이 이 바코드에 대한
 * ScanLog 전체 이력을 시간순으로 그대로 보여줌. 특정 인보이스로 한정하지 않고
 * "이 바코드"에 대해 이 배치 안에서 일어난 모든 일을 다 보여주는 것이 목적.
 *
 * 사용법: DIAG_BATCH_ID, DIAG_BARCODE만 바꿔서 실행 (SKU도 알면 정확도 위해 같이 입력)
 * ================================================================================ */
function diagnoseFullBarcodeHistory() {
  const DIAG_BATCH_ID = 'B20260803-534B0F';
  const DIAG_BARCODE = '8809937361060';  // ← 확인할 바코드
  const DIAG_SKU = 'BODP04-M';           // ← 확인할 SKU (비워두면 이 바코드의 전체 SKU 다 봄: '')

  const batchId = DIAG_BATCH_ID;
  const normTargetBarcode = normBarcode_(DIAG_BARCODE);

  // 1) BatchItems — 이 바코드(+SKU)를 필요로 하는 모든 고객사와 필요수량
  const bi = bitemsSheet_();
  const biLast = bi.getLastRow();
  const needers = [];
  if (biLast >= 2) {
    bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      if (normBarcode_(r[4]) !== normTargetBarcode) return;
      if (DIAG_SKU && String(r[2]) !== DIAG_SKU) return;
      const inv = String(r[1]);
      if (!inv) return; // 총량 행 제외
      needers.push({ invoice: inv, sku: String(r[2]), reqQty: Number(r[5]) || 0 });
    });
  }

  // 2) ScanLog — 상태/결과 상관없이 이 바코드에 대한 모든 행 (시간순)
  const sl = scanlogSheet_();
  const slLast = sl.getLastRow();
  const allScans = [];
  if (slLast >= 2) {
    sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      if (normBarcode_(r[4]) !== normTargetBarcode) return;
      if (DIAG_SKU && String(r[5]) !== DIAG_SKU) return;
      allScans.push({
        scanId: r[1], 시각: String(r[2]), 작업자: r[3], SKU: String(r[5]),
        슬롯: r[6], 고객사: r[7], 인보이스: String(r[8]) || '(없음)',
        결과: r[9], 상태: r[10], 수량: Number(r[11]) || 0,
      });
    });
  }
  allScans.sort((a, b) => String(a.시각).localeCompare(String(b.시각)));

  // 3) 이슈로그 — 이 바코드에 대한 이슈 등록 이력도 같이
  const il = issuelogSheet_();
  const ilLast = il.getLastRow();
  const allIssues = [];
  if (ilLast >= 2) {
    il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      if (normBarcode_(r[4]) !== normTargetBarcode) return;
      if (DIAG_SKU && String(r[5]) !== DIAG_SKU) return;
      allIssues.push({ 시각: String(r[2]), 작업자: r[3], SKU: String(r[5]), 인보이스: String(r[7]), 사유: r[9], 수량: Number(r[10]) || 0, 상태: r[12] });
    });
  }

  // 4) 어느 인보이스가 scan이든 issue든 "전혀" 흔적이 없는지 최종 정리
  const invoicesWithAnyTrace = new Set([
    ...allScans.map(s => s.인보이스),
    ...allIssues.map(i => i.인보이스),
  ]);
  const trulyUntouched = needers.filter(n => !invoicesWithAnyTrace.has(n.invoice));

  Logger.log('=== 바코드 전체 이력: ' + DIAG_BARCODE + (DIAG_SKU ? ' / SKU ' + DIAG_SKU : '') + ' (배치 ' + batchId + ') ===');
  Logger.log('이 바코드를 필요로 하는 고객사(BatchItems 기준) ' + needers.length + '곳: ' + JSON.stringify(needers.map(n => n.invoice + '(' + n.reqQty + ')')));
  Logger.log('--- ScanLog 전체 이력(상태/결과 무관, 시간순) ' + allScans.length + '건 ---');
  Logger.log(JSON.stringify(allScans, null, 2));
  Logger.log('--- IssueLog 이력 ' + allIssues.length + '건 ---');
  Logger.log(JSON.stringify(allIssues, null, 2));
  Logger.log('--- ScanLog에도 IssueLog에도 이 바코드 관련 흔적이 "전혀" 없는 고객사 ---');
  Logger.log(JSON.stringify(trulyUntouched, null, 2));

  return { ok: true, needers: needers, allScans: allScans, allIssues: allIssues, trulyUntouched: trulyUntouched };
}

/* ===================== diagnoseJobsInspectionStatus (★ 2026-08-05 신규) =====================
 * 목적: ScanLog에 흔적이 전혀 없는 인보이스들이, 혹시 총량피킹(batch.html)이
 * 아니라 구형 개별검수 앱(sk-worker)으로 별도 처리된 건 아닌지 확인.
 * sk-worker는 Jobs 시트의 Inspection/Inspector/Insp End 컬럼에 직접 기록하고
 * ScanLog와는 전혀 무관하므로, 이 인보이스들이 Jobs 시트에서 이미 PASS로
 * 검수완료 처리돼 있다면 "실제로는 다른 경로로 정상 처리됐다"는 뜻.
 *
 * 사용법: DIAG_INVOICES 배열에 확인할 인보이스 번호들 넣고 실행
 * ================================================================================ */
function diagnoseJobsInspectionStatus() {
  const DIAG_INVOICES = ['IN00462228', 'IN00462241', 'IN00462257', 'IN00461868', 'IN00462226'];

  const sh = SHEET_();
  const hm = headerMapCached_();
  const lastRow = sh.getLastRow();
  const invCol = hm['invoice'];
  if (!invCol) { Logger.log('❌ Jobs 시트에서 invoice 컬럼을 못 찾음'); return { ok: false }; }

  const results = [];
  if (lastRow >= 2) {
    const invColVals = sh.getRange(2, invCol, lastRow - 1, 1).getValues();
    DIAG_INVOICES.forEach(targetInv => {
      let rowIdx = -1;
      for (let i = 0; i < invColVals.length; i++) {
        if (String(invColVals[i][0]).trim() === String(targetInv).trim()) { rowIdx = i + 2; break; }
      }
      if (rowIdx < 0) { results.push({ invoice: targetInv, found: false }); return; }
      const row = sh.getRange(rowIdx, 1, 1, sh.getLastColumn()).getValues()[0];
      function jv(name) { const c = hm[name]; return c ? row[c - 1] : ''; }
      results.push({
        invoice: targetInv, found: true,
        검수결과: String(jv('inspection') || ''),
        검수자: String(jv('inspector') || ''),
        검수완료시각: String(jv('insp end') || ''),
        고객사: String(jv('remarks') || ''),
        트러킹: String(jv('trucking') || ''),
      });
    });
  }

  Logger.log('=== Jobs 시트(sk-worker 개별검수) 상태 확인 ===');
  Logger.log(JSON.stringify(results, null, 2));
  return { ok: true, results: results };
}

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
function bcustSheet_()    { return ensureBatchSheet_(BCUST_SHEET,    ['BatchId','Invoice','Customer','ShipDate','ShipVia','TotalQty','TotalSku','SlotNum','SlotSize','Cleared','MovedToPacking']); }
// ★ 2026-07-23 신규 — 이미 운영 중이던 시트는 10개 컬럼으로 만들어져 있어서,
//   위 headers 배열을 바꿔도 기존 시트엔 11번째 컬럼(MovedToPacking)이 자동으로
//   안 생김(ensureBatchSheet_는 신규 생성 시에만 헤더를 씀). 그래서 실제 사용
//   시점에 헤더가 비어있으면 한 번만 채워주는 안전장치.
function bcustSheetSafe_() {
  const bc = bcustSheet_();
  if (!bc.getRange(1, 11).getValue()) bc.getRange(1, 11).setValue('MovedToPacking');
  if (!bc.getRange(1, 12).getValue()) bc.getRange(1, 12).setValue('TakenOut'); // ★ 2026-08-04 신규 — 출고팀이 실제로 가져간 시각(파란색 상태)
  // ★ 2026-08-24 신규 — "최종 2차 검증완료"(주황, 파랑 다음 마지막 단계) 시각.
  //   K(핑크)/L(파랑)의 기존 의미는 절대 안 바꾸고, 그 뒤에 한 단계만 얹음.
  if (!bc.getRange(1, 13).getValue()) bc.getRange(1, 13).setValue('PackVerified');
  return bc;
}
function bitemsSheet_()   { return ensureBatchSheet_(BITEMS_SHEET,   ['BatchId','Invoice','SKU','Name','Barcode','ReqQty','Rack']); }
function scanlogSheet_()  { return ensureBatchSheet_(SCANLOG_SHEET,  ['BatchId','ScanId','Timestamp','Worker','Barcode','SKU','Slot','Customer','Invoice','Result','Status','Qty']); }
function picktimeSheet_() { return ensureBatchSheet_(PICKTIME_SHEET, ['BatchId','Worker','PageRange','PickStart','PickEnd','DurationMinutes','Note']); }
// ★ 2026-08-18 신규 — 이미 운영 중이던 시트는 6개 컬럼으로 만들어져 있어서,
//   위 headers 배열을 바꿔도 기존 시트엔 7번째 컬럼(Note)이 자동으로 안 생김
//   (ensureBatchSheet_는 신규 생성 시에만 헤더를 씀). bcustSheetSafe_()와 동일한
//   패턴으로, 실제 사용 시점에 헤더가 비어있으면 한 번만 채워주는 안전장치.
//   Note는 "종료를 안 누르고 다음날 강제종료된 세션" 같은 걸 감사(audit) 목적으로
//   표시하는 용도 — 소요시간 계산 자체(calcWorkMinutes_)와는 무관.
function picktimeSheetSafe_() {
  const pt = picktimeSheet_();
  if (!pt.getRange(1, 7).getValue()) pt.getRange(1, 7).setValue('Note');
  return pt;
}
// ★ 2026-08-18 신규 — 근무시간 기준 소요시간 계산 (예전 SK B2C/SK-NJ-MOIDA
//   프로젝트에서 이미 확정·검증했던 규칙과 동일하게 재사용).
//   근무시간: 08:30~12:00(오전 210분) + 13:00~17:30(오후 270분) = 하루 최대 480분.
//   점심시간(12:00~13:00)과 근무시간 외(퇴근 후~다음날 출근 전 등)는 자동 제외.
//   여러 날에 걸치면 하루 단위로 끊어서, 그날의 근무시간과 겹치는 구간만 합산.
//   (예: 어제 15:05 시작 → 오늘 08:31 종료 = 어제 145분 + 오늘 1분 = 146분)
//   입력: Date 객체 또는 new Date()로 파싱 가능한 값. 출력: 정수 분(잘못된 입력이면 0).
function calcWorkMinutes_(startVal, endVal) {
  const WORK_START_MIN = 8 * 60 + 30;   // 08:30
  const LUNCH_START_MIN = 12 * 60;      // 12:00
  const LUNCH_END_MIN = 13 * 60;        // 13:00
  const WORK_END_MIN = 17 * 60 + 30;    // 17:30

  const start = (startVal instanceof Date) ? startVal : new Date(startVal);
  const end = (endVal instanceof Date) ? endVal : new Date(endVal);
  if (isNaN(start) || isNaN(end) || end <= start) return 0;

  // 하루 안에서(분 단위 0~1440 기준) 근무시간과 겹치는 분만 계산
  function dayWorkMinutes(dayStartMin, dayEndMin) {
    const s = Math.max(dayStartMin, WORK_START_MIN);
    const e = Math.min(dayEndMin, WORK_END_MIN);
    if (e <= s) return 0;
    let mins = 0;
    if (s < LUNCH_START_MIN) mins += Math.min(e, LUNCH_START_MIN) - s; // 점심 전
    if (e > LUNCH_END_MIN) mins += e - Math.max(s, LUNCH_END_MIN);     // 점심 후
    return Math.max(0, mins);
  }

  // ★ 2026-08-18 신규 — 미국 연방공휴일 11개(회사 전체 휴무일). 고정일 5개
  //   (신년/준틴틴/독립기념일/베테랑데이/크리스마스)와 유동일 6개(요일 기준이라
  //   매년 날짜가 바뀜 — MLK/대통령의날/메모리얼데이/노동절/콜럼버스데이/
  //   추수감사절)를 연도 상관없이 자동 계산. 공휴일이 주말과 겹쳐도 별도로
  //   평일로 옮겨서 쉬는 "관찰일(observed)" 이동은 반영하지 않음(주말은 이미
  //   근무일이 아니라 계산에 영향 없음) — 필요하면 추후 요청.
  function isUsFederalHoliday_(dateObj) {
    const y = dateObj.getFullYear(), mo = dateObj.getMonth(), d = dateObj.getDate();

    function nthWeekdayOfMonth_(year, month, weekday, n) { // month: 0=1월, weekday: 0=일~6=토
      const firstWeekday = new Date(year, month, 1).getDay();
      return 1 + ((7 + weekday - firstWeekday) % 7) + (n - 1) * 7;
    }
    function lastWeekdayOfMonth_(year, month, weekday) {
      const last = new Date(year, month + 1, 0); // 그 달의 마지막 날짜
      return last.getDate() - ((7 + last.getDay() - weekday) % 7);
    }

    const holidays = [
      [0, 1],                                     // 신년(New Year's Day) 1/1
      [0, nthWeekdayOfMonth_(y, 0, 1, 3)],         // MLK Day: 1월 셋째 월요일
      [1, nthWeekdayOfMonth_(y, 1, 1, 3)],         // 대통령의날(Presidents Day): 2월 셋째 월요일
      [4, lastWeekdayOfMonth_(y, 4, 1)],           // 메모리얼데이(Memorial Day): 5월 마지막 월요일
      [5, 19],                                     // 준틴틴(Juneteenth) 6/19
      [6, 4],                                      // 독립기념일(Independence Day) 7/4
      [8, nthWeekdayOfMonth_(y, 8, 1, 1)],         // 노동절(Labor Day): 9월 첫째 월요일
      [9, nthWeekdayOfMonth_(y, 9, 1, 2)],         // 콜럼버스데이(Columbus Day): 10월 둘째 월요일
      [10, 11],                                    // 베테랑데이(Veterans Day) 11/11
      [10, nthWeekdayOfMonth_(y, 10, 4, 4)],       // 추수감사절(Thanksgiving): 11월 넷째 목요일
      [11, 25],                                    // 크리스마스(Christmas) 12/25
    ];
    return holidays.some(h => h[0] === mo && h[1] === d);
  }

  let total = 0;
  let cur = new Date(start);
  let guard = 0; // 무한루프 방지(최대 400일)
  while (cur < end && guard++ < 400) {
    const y = cur.getFullYear(), mo = cur.getMonth(), d = cur.getDate();
    const dow = cur.getDay(); // 0=일요일, 6=토요일. 회사 근무일은 주 5일(월~금)
    const dayEnd = new Date(y, mo, d + 1, 0, 0, 0);
    // ★ 2026-08-18 신규 — 주말(토/일)뿐 아니라 미국 연방공휴일(회사 전체 휴무)도 건너뜀
    if (dow !== 0 && dow !== 6 && !isUsFederalHoliday_(cur)) {
      const curMin = cur.getHours() * 60 + cur.getMinutes();
      const sameDayAsEnd = (end.getFullYear() === y && end.getMonth() === mo && end.getDate() === d);
      const endMin = sameDayAsEnd ? (end.getHours() * 60 + end.getMinutes()) : (24 * 60);
      total += dayWorkMinutes(curMin, endMin);
    }
    cur = dayEnd;
  }
  return Math.round(total);
}
// ★ 2026-07-16 신규: 고객사(Invoice) 하나에 대해 등록된 이슈 한 건 = 한 행
function issuelogSheet_() { return ensureBatchSheet_(ISSUELOG_SHEET, ['BatchId','IssueId','Timestamp','Worker','Barcode','SKU','Name','Invoice','Customer','Reason','Qty','Note','Status']); }

// ★ 2026-08-12 신규(매니저 요청) — ScanLog/IssueLog처럼 스캔마다 행이 계속
//   느는 시트는, 구글시트에 할당된 행이 다 차면 getRange(newRow,...)가 실패해서
//   스캔 저장 자체가 안 될 위험이 있음(시트 맨 아래 "더 보기 1000행" 버튼이
//   뜨는 게 바로 그 여유가 얼마 안 남았다는 신호). appendRow는 자동으로 늘려주지만
//   여기서는 텍스트 서식 고정 때문에 getRange+setValues를 쓰므로 직접 챙겨야 함.
//   매 스캔마다 검사하되, 실제로 늘리는 건 여유가 200행 이하로 줄었을 때만
//   (그것도 2000행씩 넉넉히) — 매번 늘리면 느려지고, 안 늘리면 위험하므로 절충.
function ensureSheetRoom_(sheet, neededRow) {
  try {
    const maxRows = sheet.getMaxRows();
    if (neededRow > maxRows - 200) {
      sheet.insertRowsAfter(maxRows, 2000);
    }
  } catch (e) {
    // 확장이 실패해도(권한 등) 원래 쓰기 시도는 그대로 진행 — best-effort 안전장치
  }
}
// ★ 2026-07-16 신규: 작업자 명단 — Id/Name/Status 한 명당 한 행. batch.html의 로컬 하드코딩을 대체.
function bworkersSheet_() { return ensureBatchSheet_(BWORKERS_SHEET, ['Id','Name','Status']); }
// ★ 2026-08-24 신규 — 패킹 검증 스캔 로그. 한 번의 스캔 시도(성공/오배송/초과)마다 한 행.
// pass만 "실제로 채워진 수량"으로 집계하고, wrong/over도 전부 기록해서 나중에
// "그때 뭘 잘못 스캔했는지" 감사 추적이 가능하게 함.
function packscanSheet_() { return ensureBatchSheet_(PACKSCAN_SHEET, ['BatchId','PackScanId','Timestamp','Worker','Barcode','SKU','Invoice','Result','Status','Qty']); }

// ★ 2026-08-25 신규 — Scan & Sort "작업자 선택" 중복 방지용 가벼운 하트비트.
// 피킹(PickTiming)은 시작/종료가 명확한 이벤트라 activePickers로 잠금이 가능했지만,
// 스캔 작업자 선택은 그런 이벤트가 없이 그냥 "지금 드롭다운에 뭐가 선택돼있나"뿐임.
// 그래서 기기마다 20초 간격으로 "나 지금 이 이름 쓰고 있다"를 계속 알리고(하트비트),
// 60초(3번 놓쳐도 여유 있게) 안에 신호가 없으면 더 이상 활성 아닌 것으로 간주함.
// 한 사람이 각자 자기 기기를 쓴다는 전제 하에, 다른 기기가 내 이름을 실수로
// 골라버리는 사고(스캔 기록이 엉뚱하게 섞이는 사고)를 막기 위한 안전장치.
function scanWorkerHeartbeatSheet_() { return ensureBatchSheet_('ScanWorkerHeartbeat', ['BatchId','DeviceId','Worker','LastSeen']); }

/* pingScanWorker — 기기가 주기적으로(20초마다) + 선택이 바뀔 때마다 호출.
 * worker가 빈 문자열이면 "이 기기는 지금 아무도 선택 안 함"으로 지움. */
function pingScanWorker(data) {
  // ★ 2026-08-31 긴급 성능 개선 — 이 하트비트는 20초마다, 배치가 열려있는 모든
  //   기기에서 전역으로 계속 돌아감. 예전엔 8초까지 무조건 락을 기다렸는데,
  //   그동안 스캔·2차검증확정 같은 진짜 중요한 작업이 이 하트비트 뒤에 밀려서
  //   "처리 중..."이 오래 지속되는 사고로 이어졌음(실제 현장에서 확인됨).
  //   하트비트는 "다른 기기가 같은 이름 쓰는지" 안내용일 뿐이라 한 번 놓쳐도
  //   20초 뒤 다음 주기에 다시 시도되면 그만 — 그래서 락을 짧게(1초)만
  //   시도하고, 못 잡으면 조용히 포기함(무조건 기다리지 않음). 이러면 이
  //   하트비트가 절대로 중요한 작업의 락 대기시간을 길게 늘리지 않음.
  const lock = LockService.getDocumentLock();
  const gotLock = lock.tryLock(1000);
  if (!gotLock) return { ok: true, skipped: true }; // 락을 못 잡으면 이번 주기는 조용히 건너뜀
  try {
    if (!data.batchId || !data.deviceId) return { ok: false, error: 'batchId, deviceId required' };
    const sh = scanWorkerHeartbeatSheet_();
    const last = sh.getLastRow();
    const now = batchNow_();
    if (last >= 2) {
      const rows = sh.getRange(2, 1, last - 1, 2).getValues();
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][0]) === String(data.batchId) && String(rows[i][1]) === String(data.deviceId)) {
          sh.getRange(i + 2, 3, 1, 2).setValues([[data.worker || '', data.worker ? now : '']]);
          return { ok: true };
        }
      }
    }
    if (!data.worker) return { ok: true }; // 처음부터 선택 안 함이면 새로 기록할 필요 없음
    const newRow = sh.getLastRow() + 1;
    ensureSheetRoom_(sh, newRow);
    sh.getRange(newRow, 1, 1, 4).setValues([[data.batchId, data.deviceId, data.worker, now]]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* getActiveScanWorkers — "지금 이 배치에서 어느 기기가 누구 이름을 쓰고 있는지" 조회.
 * 반환: { active: { "작업자명": ["deviceId1","deviceId2",...] } } (60초 이내만 포함) */
function getActiveScanWorkers(data) {
  try {
    if (!data.batchId) return { ok: false, error: 'batchId required' };
    const sh = scanWorkerHeartbeatSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: true, active: {} };
    const rows = sh.getRange(2, 1, last - 1, 4).getValues();
    const nowMs = Date.now();
    const active = {};
    rows.forEach(r => {
      if (String(r[0]) !== String(data.batchId)) return;
      const worker = String(r[2] || '').trim();
      if (!worker) return;
      const ts = parseBatchTs_(r[3]);
      if (isNaN(ts) || (nowMs - ts) > 60000) return; // 60초 넘으면 더 이상 활성 아님
      if (!active[worker]) active[worker] = [];
      active[worker].push(String(r[1]));
    });
    return { ok: true, active: active };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ★ 2026-08-24 재설계(매니저 요청) — 예전엔 날짜 뒤에 무작위 6자리(예: D03E5E)를
// 붙여서, 같은 날 배치가 여러 개 생겨도 작업자가 몇 번째·몇 시 배치인지 전혀
// 구분할 수 없었음. 이제 그 자리에 "생성 시각(HHmm) + 오늘 몇 번째인지(알파벳)"를
// 붙임 — 예: B20260824-1010A(오늘 오전 10:10, 1번째), B20260824-1300B(오늘 오후
// 1시, 2번째). 시각까지 있어서 자연스럽게 시간순 정렬도 되고, "아침 배치/점심
// 이후 배치"처럼 현장에서 실제로 쓰는 말과 바로 매칭됨.
// 26개(Z)를 넘어가면 AA, AB… 순으로 이어짐(하루에 26개 넘게 만드는 일은
// 사실상 없겠지만 안전하게 처리).
function seqToLetters_(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}
function nextBatchSeqForDate_(datePart) {
  const sh = batchesSheet_();
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  const prefix = 'B' + datePart + '-';
  let count = 0;
  ids.forEach(r => { if (String(r[0]).indexOf(prefix) === 0) count++; });
  return count + 1; // 오늘 이미 만들어진 배치(예전 방식 포함) 다음 순번
}
function generateBatchId_() {
  const datePart = Utilities.formatDate(new Date(), batchTz_(), 'yyyyMMdd');
  const timePart = Utilities.formatDate(new Date(), batchTz_(), 'HHmm'); // ★ 2026-08-24 신규(매니저 요청) — "몇 시에 만든 배치인지"까지 한눈에 보이도록 시:분(HHmm) 추가
  const seq = nextBatchSeqForDate_(datePart);
  return 'B' + datePart + '-' + timePart + seqToLetters_(seq);
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

/* ===================== ①-S 단독 오더 등록/조회/삭제 (★ 2026-08-31 신규) =====================
 * 목적: sk-worker 앱으로 개별 처리하던 "단독 오더"를, 총량피킹과 완전히 같은
 * 구조(BatchItems/BatchCustomers)로 관리해서 Pack Verify(스캔 기반 오출고
 * 방지)를 단독 오더에도 똑같이 적용할 수 있게 함.
 *
 * ★ 총량과 절대 안 섞이는 핵심 트릭: BatchId를 실제 배치ID(B{날짜}-{시간}{글자})
 * 대신 고정 문자열 'STANDALONE_ORDERS'로 씀. Batches 시트(배치 목록/이력)에는
 * 이 값으로 행을 아예 안 만들기 때문에, getOpenBatches/getBatch/다른배치
 * 목록 등 기존 "배치 목록" 관련 함수들은 이 존재 자체를 전혀 모름 —
 * 총량 쪽 화면·통계에 절대 끼어들 수 없는 구조.
 * ================================================================================ */
const STANDALONE_BATCH_ID = 'STANDALONE_ORDERS';

/* addStandaloneOrder — 단독 오더 PDF 파싱 결과(고객사명/상품목록)를 저장.
 * 이미 같은 인보이스로 등록된 게 있으면(재업로드) 깨끗이 지우고 새로 씀. */
function addStandaloneOrder(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };
    const customer = String((data && data.customer) || '').trim();
    const shipDate = String((data && data.shipDate) || '').trim();
    const shipVia = String((data && data.shipVia) || '').trim();
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) return { ok: false, error: '상품 목록이 비어 있습니다' };

    // 재업로드 대비 — 같은 인보이스의 예전 데이터가 있으면 먼저 지움
    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    if (bcLast >= 2) {
      const rows = bc.getRange(2, 1, bcLast - 1, 2).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]) === STANDALONE_BATCH_ID && String(rows[i][1]) === invoice) bc.deleteRow(i + 2);
      }
    }
    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    if (biLast >= 2) {
      const rows = bi.getRange(2, 1, biLast - 1, 2).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]) === STANDALONE_BATCH_ID && String(rows[i][1]) === invoice) bi.deleteRow(i + 2);
      }
    }

    const totalQty = items.reduce((a, it) => a + (Number(it.req_qty) || 0), 0);
    const totalSku = items.length;

    // BatchCustomers: SlotNum/SlotSize/Cleared는 해당없음(빈 값) — 단독은 랙 슬롯 개념이 없음
    bc.getRange(bc.getLastRow() + 1, 1, 1, 10).setValues([[
      STANDALONE_BATCH_ID, invoice, customer, shipDate, shipVia, totalQty, totalSku, '', '', ''
    ]]);

    const itemRows = items.map(it => [STANDALONE_BATCH_ID, invoice, it.sku || '', it.name || '', it.barcode || '', Number(it.req_qty) || 0, it.rack || '']);
    const startRow = bi.getLastRow() + 1;
    bi.getRange(startRow, 5, itemRows.length, 1).setNumberFormat('@'); // 바코드 텍스트 고정(자동 숫자변환 방지)
    bi.getRange(startRow, 1, itemRows.length, 7).setValues(itemRows);

    bumpVersion_();
    return { ok: true, invoice: invoice, totalSku: totalSku, totalQty: totalQty };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* getStandaloneOrders — 지금까지 등록된 단독 오더 전체 목록(진행상태 포함). */
function getStandaloneOrders() {
  try {
    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    if (bcLast < 2) return { ok: true, orders: [] };
    const rows = bc.getRange(2, 1, bcLast - 1, 13).getValues();
    const orders = [];
    rows.forEach(r => {
      if (String(r[0]) !== STANDALONE_BATCH_ID) return;
      orders.push({
        invoice: String(r[1] || ''),
        customer: String(r[2] || ''),
        shipDate: String(r[3] || ''),
        shipVia: String(r[4] || ''),
        totalQty: Number(r[5]) || 0,
        totalSku: Number(r[6]) || 0,
        movedToPacking: !!r[10],
        takenOut: !!r[11],
        packVerified: !!r[12],
      });
    });
    return { ok: true, orders: orders };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* removeStandaloneOrder — 잘못 올린 단독 오더 정리(등록 취소). */
function removeStandaloneOrder(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };
    let removed = 0;
    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    if (bcLast >= 2) {
      const rows = bc.getRange(2, 1, bcLast - 1, 2).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]) === STANDALONE_BATCH_ID && String(rows[i][1]) === invoice) { bc.deleteRow(i + 2); removed++; }
      }
    }
    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    if (biLast >= 2) {
      const rows = bi.getRange(2, 1, biLast - 1, 2).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]) === STANDALONE_BATCH_ID && String(rows[i][1]) === invoice) bi.deleteRow(i + 2);
      }
    }
    if (removed) bumpVersion_();
    return { ok: true, removed: removed };
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
    // ★ 2026-08-19 신규(긴급) — getSlotProgress/getOpenBatches와 동일한 이유.
    //   getActiveBatch가 매 폴링마다 이 함수를 호출하고, batch.html의
    //   ensureBatchItemsLoaded도 이슈 모달 열 때마다 호출함. 6초 캐시로 완화.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'getBatch_v1_' + (batchId || '_today_');
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

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

    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    let customers = [];
    if (bcLast >= 2) {
      // ★ 2026-08-07 수정 — 11개 컬럼만 읽어서 12번째인 TakenOut(파란)이
      //   배열에 아예 안 들어왔음. 그래서 batch.html은 항상 false를 받았고,
      //   TV 현황판에서 파란으로 바꿔도 계속 핵크로 보였음 — 색 불일치의 진짜 원인.
      const rows = bc.getRange(2, 1, bcLast - 1, 13).getValues();
      customers = rows.filter(r => String(r[0]) === String(resolvedId)).map(r => ({
        invoice: r[1], customer: r[2], shipDate: r[3], shipVia: r[4],
        totalQty: r[5], totalSku: r[6], slotNum: r[7], slotSize: r[8], cleared: r[9] || '',
        movedToPacking: !!r[10], // ★ 2026-07-23 신규: 패킹존 이동 체크 상태도 복원 시 같이 가져옴
        takenOut: !!r[11], // ★ 2026-08-07 신규: 출고팀이 가져간 파란 상태.
        //   TV 현황판은 이미 쓰고 있었지만 batch.html은 이 값을 받지 못해
        //   핵크에서 멈췄음 — 두 화면 색이 서로 달랐던 직접 원인.
        packVerified: !!r[12], // ★ 2026-08-24 신규: 최종 2차 검증완료(보라) — batch.html의 Pack Verify 탭이 사용
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

    const _result = { ok: true, batch: batch, sumItems: sumItems, customers: customers };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 6);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
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

/* ===================== ③b-1 setPackingMoved (★ 2026-07-23 신규) =====================
 * "패킹존 이동" 체크박스 — clearSlot(슬롯비우기/다른 고객사 자동교체)과는 완전히
 * 별개의, 순수 확인용 표시 상태. 체크해도 슬롯 번호는 그대로 유지되고, 다른
 * 배치/고객사가 자동으로 들어오지 않음. 그냥 "물리적으로 패킹존까지 옮겼다"는
 * 것만 다른 기기(TV·다른 작업자 폰)와 동기화해서 보여주기 위한 것.
 * ★ 2026-08-04 확장 — 2단계(켬/끔)에서 3단계로 확장:
 *   none(초록) → moved(핑크 "패킹존 이동 필요") → taken(파랑 "패킹존 이동 완료")
 *   새 클라이언트는 { stage:'none'|'moved'|'taken'|'verified' }로 호출하고,
 *   옛 클라이언트의 { moved:true|false } 호출도 그대로 동작함(하위호환).
 *   같은 op 이름을 쓰므로 Code.gs의 doPost 라우팅은 수정할 필요 없음.
 *   저장: K(11)=MovedToPacking 시각, L(12)=TakenOut 시각, M(13)=PackVerified 시각(★ 신규).
 *   - 'none'    : K,L,M 전부 비움 (초록으로 복귀)
 *   - 'moved'   : K에 시각(이미 있으면 처음 켠 시각 보존) + L,M 비움 (핑크)
 *   - 'taken'   : K 유지(없으면 지금 시각) + L에 시각 (파랑) — ★ 기존 의미·동작 그대로,
 *                 무조건 즉시 전환(검증 조건 없음). "패킹존으로 물리적으로 가져갔다"는
 *                 뜻은 절대 바뀌지 않음. M(검증)은 비움 — 다시 확인이 필요한 상태로.
 *   - 'verified': L(파랑)이 이미 있어야만 가능(먼저 물리적으로 가져간 다음에만 검증
 *                 가능) + M에 시각(항상 갱신) — 최종 "2차 검증완료"(주황) 단계.
 *                 패킹 검증 스캔(logPackScan)이 100% 끝나야만 전환 가능(오출고 방지
 *                 핵심 안전장치) — data.force===true(관리자 강제확정)면 건너뜀.
 * 입력: { batchId, invoice, stage } 또는 { batchId, invoice, moved }
 * ================================================================================ */
function setPackingMoved(data) {
  const lock = LockService.getDocumentLock();
  // ★ 2026-08-18 신규 — 15초→25초로 상향. TV 현황판에서 여러 슬롯을 짧은 시간에
  //   연달아 눌러(배치 막바지에 32개가 한꺼번에 완료되는 경우 자주 발생) 이
  //   함수 호출이 몰리면, 하나의 문서 락을 놓고 줄을 서다가 뒤쪽 순번은 15초
  //   안에 락을 못 잡고 예외로 실패했음. 클라이언트(board.html)가 "저장 실패
  //   확정" 판정을 내리기까지 기다려주는 시간이 30초(PENDING_PACK_MAX_MS)라,
  //   서버도 그 안에서 최대한 순서를 기다려 실제로 저장에 성공할 기회를 늘림.
  lock.waitLock(25000);
  try {
    const batchId = data.batchId, invoice = data.invoice;
    if (!batchId || !invoice) return { ok: false, error: 'batchId, invoice required' };

    // 신형(stage) / 구형(moved) 호출 모두 지원
    let stage;
    if (data.stage !== undefined && data.stage !== null && data.stage !== '') {
      stage = String(data.stage);
      if (stage !== 'none' && stage !== 'moved' && stage !== 'taken' && stage !== 'verified') {
        return { ok: false, error: 'stage must be none|moved|taken|verified' };
      }
    } else {
      stage = data.moved ? 'moved' : 'none';
    }

    const bc = bcustSheetSafe_();
    const last = bc.getLastRow();
    if (last < 2) return { ok: false, error: '해당 고객사 행을 찾지 못했습니다' };
    const rows = bc.getRange(2, 1, last - 1, 2).getValues();
    let found = false;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) !== String(batchId)) continue;
      if (String(rows[i][1]) !== String(invoice)) continue;
      const row = i + 2;
      if (stage === 'none') {
        bc.getRange(row, 11).setValue('');
        bc.getRange(row, 12).setValue('');
        bc.getRange(row, 13).setValue('');
      } else if (stage === 'moved') {
        // 핑크: "이동 필요"로 처음 켠 시각을 보존 (파랑/주황에서 되돌아와도 원래 시각 유지)
        if (!bc.getRange(row, 11).getValue()) bc.getRange(row, 11).setValue(batchNow_());
        bc.getRange(row, 12).setValue('');
        bc.getRange(row, 13).setValue('');
      } else if (stage === 'taken') {
        // ★ 파랑 — 기존 그대로. "패킹존으로 물리적으로 가져갔다"는 뜻이며,
        //   검증 여부와 무관하게 클릭 한 번에 즉시 전환됨(안전장치 없음, 원래 설계 그대로).
        //   여기로 다시 들어오면(주황에서 되돌아오는 경우 포함) 검증(M)은 초기화 —
        //   "아직 다시 확인 안 된 상태"로 정직하게 되돌림.
        if (!bc.getRange(row, 11).getValue()) bc.getRange(row, 11).setValue(batchNow_());
        bc.getRange(row, 12).setValue(batchNow_());
        bc.getRange(row, 13).setValue('');
        // ★ 2026-08-31 신규 — 단독 오더 1차 검수 지원. 총량피킹은 이 시점 이전에
        //   이미 Scan & Sort(logScan)에서 Jobs.Inspection이 채워지므로 이 동기화가
        //   필요 없다 — 그런데도 매번 돌리면, TV 현황판에서 배치 막바지에 슬롯
        //   여러 개가 짧은 시간에 연달아 파랑으로 바뀔 때마다(흔한 상황) 시트를
        //   여러 번 읽는 이 무거운 함수가 매번 같이 돌아서 불필요한 부하가
        //   쌓임(구글 앱스스크립트 "동시 요청 한도" 문제를 악화시킬 수 있음).
        //   그래서 반드시 단독 오더(STANDALONE_BATCH_ID)일 때만 실행되도록 좁힘 —
        //   총량피킹 호출 경로는 이 줄 자체를 아예 안 타서 예전과 완전히 동일한
        //   속도를 유지함.
        if (batchId === STANDALONE_BATCH_ID) {
          try { syncInspectionFromPicking_(batchId, invoice, data.worker || ''); } catch (eSync) { /* 무시 — 최종 확정 자체는 이미 성공했으므로 */ }
        }
      } else { // 'verified' — ★ 2026-08-24 신규: 최종 2차 검증완료(주황). 반드시 파랑(물리적 이동)부터.
        if (!bc.getRange(row, 12).getValue()) {
          return { ok: false, error: '먼저 패킹존 이동(파랑) 표시부터 완료해주세요' };
        }
        if (!data.force) {
          const pv = getPackScanState(batchId, invoice);
          if (!pv.ok || !pv.complete) {
            return {
              ok: false,
              error: '2차 검증이 완료되지 않았습니다' + (pv.ok ? ` (${pv.totalPacked}/${pv.totalReq}pcs)` : ''),
              needsVerification: true,
            };
          }
        }
        bc.getRange(row, 13).setValue(batchNow_());
      }
      found = true;
      break;
    }
    if (!found) return { ok: false, error: '해당 고객사 행을 찾지 못했습니다' };

    bumpVersion_();
    return { ok: true, stage: stage, moved: stage !== 'none' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ③c logPackScan / undoPackScan / getPackScanState (★ 2026-08-24 신규) =====================
 * ★★★ 오출고 방지 — 패킹 검증 스캔 ★★★
 *
 * 배경: 분류·검수(ScanLog)는 여러 고객사에게 물건을 나누는 과정이라 사람 실수나
 * 슬롯 간 혼입이 발생할 수 있음. 지금까지는 검수가 끝나면(핑크) 패킹 작업자가
 * 그 내용을 100% 믿고 바로 팔레타이징/박스패킹 → 출고했음. 이 함수들은 패킹존에서
 * "검수에서 넘어온 물건이 실제로 이 고객사 것이 맞는지"를 바코드로 한 번 더
 * 확인하는 마지막 관문. ScanLog와는 완전히 분리된 PackScanLog에 기록되므로
 * 검수 기록을 전혀 건드리지 않음(감사 추적 목적상 절대 섞으면 안 됨).
 *
 * 매칭 기준: SKU가 아니라 "바코드" 단위. 패킹 작업자는 SKU를 모르고 바코드만
 * 스캔하기 때문 — 같은 바코드가 그 인보이스 안에서 여러 줄(SKU)에 걸쳐 있으면
 * 합산해서 하나의 풀로 취급함(현장에서 바코드로만 구분 가능하므로 불가피한 단순화).
 * ================================================================================ */

/* logPackScan — 스캔 1번마다 호출. 이 인보이스가 필요로 하는 바코드인지,
 * 아예 다른 고객사 것인지(오배송 위험)를 즉시 판정.
 * ★ 2026-08-24 재설계(매니저 승인) — "스캔 1번 = 그 상품 전체 수량 채우기"로
 *   변경. 예전엔 스캔할 때마다 1개씩만 채워져서(qty:1), SKU 하나에 50개가
 *   있으면 50번을 스캔해야 했음. 이제 바코드를 한 번 스캔하면 그 줄(SKU)에
 *   남아있는 필요수량 전체가 한 번에 채워짐 — 실제 물류 현장 표준 방식
 *   그대로(바코드=신원 확인 담당, 수량=작업자 육안 확인 담당). 수량은 더
 *   이상 클라이언트가 지정하지 않고 서버가 "남은 만큼 전부"로 직접 계산함
 *   (data.qty는 이제 안 씀 — 혹시 옛 클라이언트가 보내도 무시됨).
 * 반환: { ok, result: 'pass'|'wrong'|'over', filled(이번 스캔으로 채워진 양),
 *         packed(누적), required, ownerInvoices(wrong일 때만) } */
function logPackScan(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    if (!data.batchId) return { ok: false, error: 'batchId required' };
    if (!data.invoice) return { ok: false, error: 'invoice required' };
    const barcode = String(data.barcode || '').trim();
    if (!barcode) return { ok: false, error: 'barcode required' };
    const normBc = normBarcode_(barcode);

    // 이 인보이스가 필요로 하는 줄(들) 중 이 바코드와 일치하는 것 찾기
    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    const matchLines = [];
    const biRows = biLast >= 2 ? bi.getRange(2, 1, biLast - 1, 7).getValues() : [];
    biRows.forEach(r => {
      if (String(r[0]) !== String(data.batchId)) return;
      if (String(r[1]) !== String(data.invoice)) return;
      if (normBarcode_(r[4]) !== normBc) return;
      matchLines.push({ sku: String(r[2]), name: String(r[3]), reqQty: Number(r[5]) || 0 });
    });

    const pl = packscanSheet_();

    if (matchLines.length === 0) {
      // ★ 이 인보이스 것이 아님 — 배치 안 다른 고객사 중 실제로 이 바코드가
      //   필요한 곳을 찾아서 "이 물건은 어디 것인지" 바로 안내해줌(오배송 예방 핵심)
      const owners = new Set();
      biRows.forEach(r => {
        if (String(r[0]) !== String(data.batchId)) return;
        if (!r[1]) return; // 총량 행 제외
        if (String(r[1]) === String(data.invoice)) return;
        if (normBarcode_(r[4]) !== normBc) return;
        owners.add(String(r[1]));
      });
      const packScanId = Utilities.getUuid();
      const newRow = pl.getLastRow() + 1;
      ensureSheetRoom_(pl, newRow);
      pl.getRange(newRow, 5, 1, 2).setNumberFormat('@'); // E:Barcode, F:SKU
      pl.getRange(newRow, 1, 1, 10).setValues([[
        data.batchId, packScanId, batchNow_(), data.worker || '', barcode, '',
        data.invoice, 'wrong', 'active', 0,
      ]]);
      return { ok: true, result: 'wrong', packScanId: packScanId, ownerInvoices: Array.from(owners) };
    }

    // 이미 이 바코드로 채운 수량(같은 배치+인보이스, pass만, undone 제외)
    const plLast = pl.getLastRow();
    let already = 0;
    if (plLast >= 2) {
      pl.getRange(2, 1, plLast - 1, 10).getValues().forEach(r => {
        if (String(r[0]) !== String(data.batchId)) return;
        if (String(r[6]) !== String(data.invoice)) return;
        if (r[7] !== 'pass' || r[8] === 'undone') return;
        if (normBarcode_(r[4]) !== normBc) return;
        already += Number(r[9]) || 0;
      });
    }
    const totalReq = matchLines.reduce((a, l) => a + l.reqQty, 0);
    // 검수 단계에서 이미 EXP/OOS 등으로 이슈 처리된 수량만큼 필요수량에서 제외
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    let issueQty = 0;
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(data.batchId)) return;
        if (String(r[7]) !== String(data.invoice)) return;
        if (r[12] === 'undone') return;
        if (normBarcode_(r[4]) !== normBc) return;
        issueQty += Number(r[10]) || 0;
      });
    }
    const effectiveReq = Math.max(0, totalReq - issueQty);
    const sku = matchLines.length === 1 ? matchLines[0].sku : matchLines.map(l => l.sku).join('+');
    const name = matchLines[0].name;

    // ★ 핵심 변경 — 남은 필요수량을 전부 채움. 이미 다 채워진 상태에서 또
    //   스캔하면(중복 스캔) 채울 게 없으므로 'over'로 판정하고 기록만 남김.
    //   ★ 추가 보완 — "이미 다 채워서 남은 게 없는 경우"와 "애초에 이슈
    //   처리(EXP/OOS 등)로 필요수량 자체가 0이 된 경우"는 원인이 다르므로
    //   note로 구분해서, 클라이언트가 헷갈리지 않는 메시지를 보여줄 수 있게 함.
    const remaining = effectiveReq - already;
    if (remaining <= 0) {
      const note = effectiveReq <= 0 ? 'excluded' : 'duplicate';
      const packScanId0 = Utilities.getUuid();
      const newRow0 = pl.getLastRow() + 1;
      ensureSheetRoom_(pl, newRow0);
      pl.getRange(newRow0, 5, 1, 2).setNumberFormat('@');
      pl.getRange(newRow0, 1, 1, 10).setValues([[
        data.batchId, packScanId0, batchNow_(), data.worker || '', barcode, sku,
        data.invoice, 'over', 'active', 0,
      ]]);
      return {
        ok: true, result: 'over', note: note, packScanId: packScanId0, sku: sku, name: name,
        filled: 0, packed: already, required: effectiveReq,
      };
    }

    const fillQty = remaining; // 한 번 스캔에 남은 수량 전부
    const packScanId = Utilities.getUuid();
    const newRow2 = pl.getLastRow() + 1;
    ensureSheetRoom_(pl, newRow2);
    pl.getRange(newRow2, 5, 1, 2).setNumberFormat('@');
    pl.getRange(newRow2, 1, 1, 10).setValues([[
      data.batchId, packScanId, batchNow_(), data.worker || '', barcode, sku,
      data.invoice, 'pass', 'active', fillQty,
    ]]);
    bumpVersion_();
    return {
      ok: true, result: 'pass', packScanId: packScanId, sku: sku, name: name,
      filled: fillQty, packed: already + fillQty, required: effectiveReq,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* undoPackScan — 잘못 스캔한 것을 취소(실제 삭제 대신 Status를 undone으로)
 * 입력: { packScanId } */
function undoPackScan(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const id = data.packScanId;
    if (!id) return { ok: false, error: 'packScanId required' };
    const sh = packscanSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: false, error: 'no pack scans' };
    const ids = sh.getRange(2, 2, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) {
        sh.getRange(i + 2, 9).setValue('undone');
        bumpVersion_();
        return { ok: true };
      }
    }
    return { ok: false, error: 'pack scan not found' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* getPackScanState — 패킹 검증 모달을 열 때(그리고 몇 초마다) 호출.
 * 이 인보이스가 필요로 하는 바코드별 체크리스트 + 진행률 + 최근 스캔 이력 반환.
 * 입력: batchId, invoice (둘 다 문자열) */
function getPackScanState(batchId, invoice) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };
    if (!invoice) return { ok: false, error: 'invoice required' };

    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    const rawLines = [];
    if (biLast >= 2) {
      bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[1]) !== String(invoice)) return;
        rawLines.push({ sku: String(r[2]), name: String(r[3]), barcode: String(r[4]), reqQty: Number(r[5]) || 0 });
      });
    }
    // 패킹검증은 바코드 단위로 매칭하므로, 같은 바코드를 쓰는 줄들을 하나로 합침
    const linesByBarcode = {};
    rawLines.forEach(l => {
      const k = normBarcode_(l.barcode);
      if (!linesByBarcode[k]) linesByBarcode[k] = { barcode: l.barcode, skus: [], names: [], reqQty: 0 };
      linesByBarcode[k].skus.push(l.sku);
      linesByBarcode[k].names.push(l.name);
      linesByBarcode[k].reqQty += l.reqQty;
    });

    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const issueQtyByBarcode = {};
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[7]) !== String(invoice)) return;
        if (r[12] === 'undone') return;
        const k = normBarcode_(r[4]);
        issueQtyByBarcode[k] = (issueQtyByBarcode[k] || 0) + (Number(r[10]) || 0);
      });
    }

    const pl = packscanSheet_();
    const plLast = pl.getLastRow();
    const packedByBarcode = {};
    const history = [];
    if (plLast >= 2) {
      pl.getRange(2, 1, plLast - 1, 10).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[6]) !== String(invoice)) return;
        const entry = { packScanId: r[1], time: String(r[2]), worker: r[3], barcode: String(r[4]), sku: String(r[5]), result: r[7], status: r[8], qty: Number(r[9]) || 0 };
        history.push(entry);
        if (r[8] === 'undone') return;
        if (r[7] !== 'pass') return;
        const k = normBarcode_(r[4]);
        packedByBarcode[k] = (packedByBarcode[k] || 0) + entry.qty;
      });
    }
    history.sort((a, b) => String(b.time).localeCompare(String(a.time)));

    const lines = Object.entries(linesByBarcode).map(([k, l]) => {
      const issueQty = issueQtyByBarcode[k] || 0;
      const effectiveReq = Math.max(0, l.reqQty - issueQty);
      const packed = Math.min(packedByBarcode[k] || 0, effectiveReq);
      return {
        barcode: l.barcode, sku: l.skus.join('+'), name: l.names[0],
        reqQty: l.reqQty, issueQty: issueQty, effectiveReq: effectiveReq,
        packed: packed, complete: packed >= effectiveReq,
      };
    });
    lines.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const totalReq = lines.reduce((a, l) => a + l.effectiveReq, 0);
    const totalPacked = lines.reduce((a, l) => a + l.packed, 0);
    const complete = lines.length > 0 && lines.every(l => l.complete);
    const wrongCount = history.filter(h => h.result === 'wrong' && h.status !== 'undone').length;

    return {
      ok: true, lines: lines, totalReq: totalReq, totalPacked: totalPacked,
      complete: complete, history: history.slice(0, 40), wrongCount: wrongCount,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
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

    // ★ 2026-08-03 설계 변경(매니저 요청) — 예전엔 슬롯이 비워지는 즉시 다른
    //   대기 고객사를 자동으로 그 번호에 채워 넣었음(아래 옛 로직 참고). 그런데
    //   이게 "완료(핑크)되면 그 오더 정보가 TV에서 사라지고 다른 고객사로
    //   바뀌어버린다"는 문제로 이어졌음 — 패킹/출고 작업자가 핑크로 바뀐 뒤에도
    //   그 오더 정보를 계속 보면서 물건을 챙겨가야 하는데, 자동교체 때문에
    //   화면에서 없어져버렸음. 이제 슬롯비우기를 눌러도 그 자리는 원래 고객사
    //   정보를 그대로 유지하고("Cleared" 시각만 기록), 이 배치 안에서는 어떤
    //   슬롯도 자동으로 다른 고객사로 바뀌지 않음. 배치 전체를 바꾸고 싶으면
    //   "다른 배치" 버튼으로 완전히 다른 배치를 불러오는 것으로만 가능함.
    const autoFilled = null;

    // ★ 2026-07-23 신규 — 기존 검수 시스템(sk-worker 앱, Jobs 시트) 자동 반영.
    //   총량피킹 스캔+이슈등록 = 사실상 검수와 같은 작업인데, 지금까지는
    //   작업자가 sk-worker 앱에서 같은 송장에 대해 또 PASS/이슈를 중복
    //   입력해야 했음. "패킹완료·슬롯비우기"는 사람이 마지막으로 눈으로
    //   확인하고 누르는 확정 동작이라(스캔만으로 뜨는 "완료"보다 신뢰도가
    //   높음 — 스캔 실수로 잠깐 완료 떴다 취소되는 경우가 있어서 그 시점엔
    //   반영하지 않기로 함), 이 시점에 saveInspection()을 그대로 호출해서
    //   sk-worker와 완전히 동일한 방식(PASS / ⚠ ISSUES(N))으로 Jobs 시트에
    //   자동 기록함 — 작업자가 sk-worker 앱에 따로 또 입력할 필요 없어짐.
    //   (Invoice가 Jobs 시트에 없는 경우 saveInspection이 조용히 ok:false만
    //   반환하고 끝나서, 총량피킹 전용 주문이어도 슬롯비우기 자체는 영향 없음)
    try {
      const activeIssues = slot.issues || [];
      saveInspection({
        invoice: invoice,
        pass: activeIssues.length === 0,
        issues: activeIssues.map(i => ({ type: i.reason, barcode: i.barcode, qty: i.qty })),
        memo: '총량피킹에서 자동 반영됨' + (data.worker ? (' · 작업자: ' + data.worker) : ''),
        inspector: data.worker || '',
        inspectedAt: batchNow_(),
        inspEndAt: batchNow_(),
      });
    } catch (syncErr) {
      // 검수 시스템 반영이 실패해도 슬롯비우기 자체는 정상 진행되도록 조용히 무시하고 로그만 남김
      Logger.log('saveInspection 자동 반영 실패 (invoice=' + invoice + '): ' + String(syncErr));
    }

    bumpVersion_();
    return { ok: true, autoFilled: autoFilled };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ①-2 setActiveBatch / getActiveBatch (★ 2026-07-23 신규) =====================
 * 목적: 매니저가 PC에서 배치를 "이어서 작업"하면, 그건 그 PC 화면에만
 *       적용되고 서버엔 아무 기록이 안 남아서 다른 기기(작업자 폰 등)는
 *       여전히 "완료 처리 안 된 배치" 확인 화면을 각자 따로 클릭해야 했음.
 *       → 매니저가 배치를 선택하면 서버에 "지금 활성 배치는 이거다"라고
 *       기록해두고, 다른 기기들은 페이지를 열 때 이 기록을 확인해서
 *       클릭 없이 자동으로 같은 배치를 불러오게 함.
 *       (PropertiesService는 시트가 아니라 스크립트에 딸린 간단한
 *       키-값 저장소라, 값 하나 저장하기엔 이게 훨씬 가볍고 빠름)
 * ============================================================ */
function setActiveBatch(data) {
  try {
    if (!data.batchId) return { ok: false, error: 'batchId required' };
    PropertiesService.getScriptProperties().setProperty('activeBatchId', String(data.batchId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function clearActiveBatch() {
  try {
    PropertiesService.getScriptProperties().deleteProperty('activeBatchId');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function getActiveBatch() {
  try {
    const id = PropertiesService.getScriptProperties().getProperty('activeBatchId');
    if (!id) return { ok: true, batch: null };
    const res = getBatch(id);
    // 활성으로 기록된 배치가 이미 완료 처리됐거나 삭제된 경우, 기록을 정리하고 없다고 응답
    if (!res.ok || !res.batch || res.batch.status === 'completed') {
      PropertiesService.getScriptProperties().deleteProperty('activeBatchId');
      return { ok: true, batch: null };
    }
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
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
/* ===================== ④-0 syncInspectionFromPicking_ (★ 2026-07-24 신규) =====================
 * 목적: 원래 개별오더 관리 시스템(fulfillment 대시보드 + sk-worker 앱)에서 하던
 * "검수(Inspection)"를, 요즘 현장에서는 sk-worker 앱을 건너뛰고 총량피킹
 * (batch.html) 스캔으로 대체하고 있어서, 그 스캔 결과가 자동으로 같은
 * 스프레드시트의 Jobs 탭 Inspection 컬럼(PASS/ISSUES)에도 반영되도록 연결.
 *
 * 동작: 이 인보이스의 "실제 필요수량(effectiveTotal = 총수량 - 활성 이슈수량)"과
 * "실제 스캔 통과 수량"을 다시 계산해서, 지금 이 순간 완료 상태인지 판정.
 * Jobs 시트에 이미 기록된 값과 다르면(=방금 상태가 바뀌었으면)만 saveInspection()을
 * 호출해서 갱신 — 스캔마다 매번 시트에 쓰지 않고, 실제로 상태가 바뀔 때만 씀.
 *
 * 호출 시점: logScan (스캔이 완료를 만들 수 있음), logIssue/undoIssue/editIssue
 * (이슈 등록·취소·수정으로 필요수량 자체가 바뀌어 완료 여부가 뒤집힐 수 있음).
 *
 * ⚠ 이 연동은 100% best-effort임 — 여기서 에러가 나도 원래 스캔/이슈 처리
 * 자체는 절대 실패하면 안 되므로, 호출부에서 항상 try/catch로 감싸서 씀.
 * 입력: { batchId, invoice, worker }
 * ================================================================================ */
function syncInspectionFromPicking_(batchId, invoice, worker, force) {
  if (!batchId || !invoice) return;

  // 1) 이 인보이스의 총 필요수량(BatchCustomers) 찾기
  const bc = bcustSheetSafe_();
  const bcLast = bc.getLastRow();
  if (bcLast < 2) return;
  const bcRows = bc.getRange(2, 1, bcLast - 1, 12).getValues(); // ★ 2026-08-07: TakenOut(12번째) 포함
  let totalQty = null;
  for (let i = 0; i < bcRows.length; i++) {
    if (String(bcRows[i][0]) === String(batchId) && String(bcRows[i][1]) === String(invoice)) {
      totalQty = Number(bcRows[i][5]) || 0;
      break;
    }
  }
  if (totalQty === null) return; // 이 배치에 없는 인보이스면 아무것도 안 함

  // 2) 활성 이슈 수량 합계 + 이슈 목록 (saveInspection의 issues 형식으로 변환)
  const il = issuelogSheet_();
  const ilLast = il.getLastRow();
  let issueQty = 0;
  const issues = [];
  if (ilLast >= 2) {
    il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      if (String(r[7]) !== String(invoice)) return;
      if (r[12] === 'undone') return;
      issueQty += Number(r[10]) || 0;
      issues.push({ type: r[9] || 'ETC', barcode: r[4] || '', qty: Number(r[10]) || 0 });
    });
  }
  const effectiveTotal = Math.max(0, totalQty - issueQty);

  // 3) 실제 스캔 통과 수량 합계 (undone 제외, pass만) — 초과분도 그대로 인정
  //    (batch.html 슬롯 완료 판정과 동일한 기준: q.doneRaw 합산과 동일 개념)
  // ★ 2026-07-24 긴급 수정 — getSlotProgress/getScanState와 똑같은 버그가 여기도
  //   있었음: 이슈 취소(undoIssue) 시 상쇄용 ADJ 기록은 일부러 안 지우는데(재스캔
  //   유도 목적), 이 함수는 그 마이너스를 SKU별로 걸러내지 않고 인보이스 전체를
  //   그냥 통째로 더해버려서, 취소된 이슈의 옛 상쇄기록이 계속 진행량을 깎아먹었음.
  //   그래서 "완료"가 안 되는 것으로 잘못 계산되어, fulfillment 대시보드
  //   Inspection 동기화 자체가 조용히 안 되는 사고로 이어졌음(예: 이슈 2건→1건
  //   취소했는데 구글시트엔 계속 2건으로 남음). SKU(바코드)별로 순 스캔량을
  //   먼저 구해서 0 밑으로 안 내려가게 고정한 뒤에 합산하도록 수정.
  // ★ 2026-08-31 긴급 수정 — 단독오더 1차 검수(04 Standalone Scan)는 logScan이
  //   아니라 logPackScan(Pack Verify와 같은 스캔 엔진)을 재사용하므로 실제
  //   스캔 기록이 ScanLog가 아니라 PackScanLog에 쌓임. 이 함수는 원래
  //   ScanLog만 읽었기 때문에, 단독오더는 스캔을 100% 다 채워도 scanned가
  //   항상 0으로 계산되어 isComplete가 절대 true가 될 수 없었고, 결과적으로
  //   Jobs.Inspection이 영원히 갱신 안 되는 사고로 이어졌음(index.html/
  //   sales.html에 검수 다 끝난 오더가 계속 "Not Inspected"/"Pending"으로
  //   표시되는 증상). 총량피킹(ScanLog)과 단독오더(PackScanLog)는 기록되는
  //   시트 자체가 다르므로, batchId로 분기해서 실제로 스캔이 쌓이는 시트를 읽는다.
  const scannedByKey = {}; // ★ 2026-07-28 수정: "바코드"만이 아니라 "바코드|SKU"로 키 변경
  if (batchId === STANDALONE_BATCH_ID) {
    const pl = packscanSheet_();
    const plLast = pl.getLastRow();
    if (plLast >= 2) {
      pl.getRange(2, 1, plLast - 1, 10).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[6]) !== String(invoice)) return; // PackScanLog: G=Invoice
        if (r[8] === 'undone') return;                // Status
        if (r[7] !== 'pass') return;                  // Result
        const key = normBarcode_(r[4]) + '|' + String(r[5]); // barcode|sku
        scannedByKey[key] = (scannedByKey[key] || 0) + (Number(r[9]) || 0); // Qty
      });
    }
  } else {
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[8]) !== String(invoice)) return;
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return;
        const key = normBarcode_(r[4]) + '|' + String(r[5]); // barcode|sku ★ 2026-08-05: normBarcode_로 앞자리0 손실 방어
        scannedByKey[key] = (scannedByKey[key] || 0) + (Number(r[11]) || 0);
      });
    }
  }
  let scanned = 0;
  Object.keys(scannedByKey).forEach(key => {
    scanned += Math.max(0, scannedByKey[key]); // SKU별로 0 밑으로 안 내려가게 고정한 뒤 합산
  });

  const isComplete = effectiveTotal > 0 && scanned >= effectiveTotal;
  const isIssueOnly = issueQty > 0 && !isComplete && effectiveTotal === 0; // 전량이 이슈로 빠진 경우도 "검수 끝(이슈)"로 취급

  // 4) Jobs 시트에서 이 인보이스가 이미 어떤 값인지 확인 → 다를 때만 씀 (불필요한 반복 저장 방지)
  const jobsSS = ss_();
  const jobsSheet = jobsSS.getSheetByName(JOBS_SHEET);
  if (!jobsSheet) return;
  const jobsLast = jobsSheet.getLastRow();
  if (jobsLast < 2) return;
  const jobsInvoiceCol = jobsSheet.getRange(2, 1, jobsLast - 1, 1).getValues();
  let jobsRow = -1;
  for (let i = 0; i < jobsInvoiceCol.length; i++) {
    if (String(jobsInvoiceCol[i][0]).trim() === String(invoice).trim()) { jobsRow = i + 2; break; }
  }
  if (jobsRow === -1) return; // fulfillment 대시보드에 없는 인보이스(예: 오더 관리 시스템에 등록 안 된 경우)는 그냥 넘어감

  const currentVal = String(jobsSheet.getRange(jobsRow, 19).getValue() || '').trim();
  const shouldBePass = isComplete && issues.length === 0;
  const shouldBeIssues = isComplete && issues.length > 0; // 완료는 됐지만 그 안에 이슈가 섞여 있으면 PASS 대신 ISSUES로

  // ★ 2026-07-24 긴급 수정 — "상태 문구가 이전과 같으면 저장 생략"하는 최적화가,
  //   담당자(Inspector) 이름만 고쳐야 하는 강제 재동기화(forceSyncInspection) 때도
  //   똑같이 걸려서 아예 아무것도 안 써지는 사고가 있었음(상태는 그대로인데
  //   담당자만 잘못돼 있던 경우). force=true면 문구가 같아도 무조건 다시 씀.
  if (shouldBePass && (force || currentVal !== '✓ PASS')) {
    saveInspection({ invoice: invoice, pass: true, issues: [], inspector: worker || '', inspEndAt: new Date().toISOString() });
  } else if (shouldBeIssues) {
    const expectedVal = '⚠ ISSUES(' + issues.length + ')';
    if (force || currentVal !== expectedVal) {
      saveInspection({ invoice: invoice, pass: false, issues: issues, inspector: worker || '', inspEndAt: new Date().toISOString() });
    }
  }
  // isComplete가 false면(아직 덜 채워짐) 아무것도 안 씀 — 이미 PASS/ISSUES로 찍혀있던 걸
  // "미완료"로 되돌리는 것까지는 하지 않음 (검수 결과를 함부로 지우는 위험 방지, 필요하면 매니저가 clearInspection 사용)
}

function logScan(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    if (!data.batchId) return { ok: false, error: 'batchId required' };
    const scanId = Utilities.getUuid();
    const sl = scanlogSheet_();
    // ★ 2026-08-05 긴급 수정 — appendRow로 그냥 쓰면 순수 숫자 바코드(0으로
    //   시작하는 경우가 흔함)가 구글시트에 의해 자동으로 숫자로 변환되어 앞자리
    //   0이 사라짐(BatchItems엔 이미 적용돼 있던 텍스트 고정이 여기 빠져있었음).
    //   새로 추가될 행 번호를 먼저 계산해서, 그 행의 Barcode(E)/SKU(F) 컬럼을
    //   텍스트로 고정한 뒤에 값을 씀 — appendRow 대신 getRange+setValues 사용.
    const newRow = sl.getLastRow() + 1;
    ensureSheetRoom_(sl, newRow); // ★ 2026-08-12 신규 — 시트 행 부족 시 자동으로 미리 늘려둠
    sl.getRange(newRow, 5, 1, 2).setNumberFormat('@'); // E:Barcode, F:SKU
    sl.getRange(newRow, 1, 1, 12).setValues([[
      data.batchId, scanId, batchNow_(), data.worker || '', data.barcode || '',
      data.sku || '', data.slot || '', data.customer || '', data.invoice || '',
      data.result || 'pass', 'active', Number(data.qty) || 1
      // ★ 2026-07-13: '스캔 1번 = 낱개 1개'가 아니라 '스캔 1번 = 그 순간 배정된
      //   고객사가 필요한 수량 전체를 분류 완료'로 워크플로우를 변경함에 따라
      //   추가된 컬럼. 총량피킹에서 스캔의 목적은 개수 검수가 아니라 "이 상품을
      //   어느 고객사로 보낼지 분류"하는 것이므로, 스캔 1번에 여러 개가 한번에
      //   해당 고객사 몫으로 카운트되어야 함.
    ]]);
    // ★ 2026-07-24 신규 — 원래 sk-worker 앱에서 하던 "검수"를 총량피킹 스캔이
    //   대신하고 있으므로, 이 스캔으로 그 고객사가 방금 완료됐다면 Jobs 시트
    //   Inspection에도 자동 반영. best-effort라 실패해도 스캔 자체는 성공 처리.
    try { syncInspectionFromPicking_(data.batchId, data.invoice, data.worker); } catch (e) { /* 무시 */ }
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
    const il = issuelogSheet_();
    // ★ 2026-08-21 긴급 신규 — 이중 등록 방지 안전장치.
    //   실제 현장에서 같은 이슈(바코드·사유·수량·작업자 전부 동일)가 몇 초 안에
    //   3번 연속 등록되는 사고가 발생함(원인: 등록 성공 후에도 폼이 초기화되지
    //   않아, 작업자가 "등록됐나?" 헷갈려서 같은 값 그대로 다시 눌렀을 가능성이
    //   높음 — board.html 쪽 폼 초기화는 별도로 같이 수정함). 원인이 다중 클릭이든
    //   네트워크 재전송이든 상관없이, 서버 쪽에서 마지막 방어선으로 한 번 더 막음.
    //   최근 50행만 확인 — 그 이상 오래된 항목까지 매번 전수 스캔하면 이슈가
    //   많이 쌓인 배치에서 등록 자체가 느려짐(성능 부담 최소화).
    const ilLastRow = il.getLastRow();
    if (ilLastRow >= 2) {
      const scanFrom = Math.max(2, ilLastRow - 49);
      const recent = il.getRange(scanFrom, 1, ilLastRow - scanFrom + 1, 13).getValues();
      const nowMs = Date.now();
      const DUP_WINDOW_MS = 120000; // 2분 — 정말 짧은 시간 안의 실수성 중복만 잡고, 나중에 실제로 또 같은 문제가 생긴 경우는 정상 등록되게 함
      for (let i = recent.length - 1; i >= 0; i--) {
        const r = recent[i];
        if (String(r[12]) !== 'active') continue;
        if (String(r[0]) !== String(data.batchId)) continue;
        if (String(r[7]) !== String(data.invoice)) continue;
        if (String(r[4]||'') !== String(data.barcode||'')) continue;
        if (String(r[9]||'ETC') !== String(data.reason||'ETC')) continue;
        if (Number(r[10]) !== qty) continue;
        if (String(r[3]||'') !== String(data.worker||'')) continue;
        const rowTime = new Date(String(r[2]).replace(' ', 'T'));
        if (isNaN(rowTime.getTime())) continue;
        if (nowMs - rowTime.getTime() > DUP_WINDOW_MS) continue;
        // 2분 이내에 완전히 동일한 이슈가 이미 등록돼 있음 — 새로 만들지 않고 그 이슈를 그대로 반환
        return { ok: true, issueId: String(r[1]), duplicate: true };
      }
    }
    const issueId = Utilities.getUuid();
    // ★ 2026-08-05 긴급 수정 — logScan과 동일한 이유로, IssueLog의 Barcode(E)/
    //   SKU(F) 컬럼도 appendRow 전에 텍스트로 먼저 고정해서 숫자 자동변환(앞자리
    //   0 소실)을 막음.
    const ilNewRow = il.getLastRow() + 1;
    ensureSheetRoom_(il, ilNewRow); // ★ 2026-08-12 신규
    il.getRange(ilNewRow, 5, 1, 2).setNumberFormat('@'); // E:Barcode, F:SKU
    il.getRange(ilNewRow, 1, 1, 13).setValues([[
      data.batchId, issueId, batchNow_(), data.worker || '',
      data.barcode || '', data.sku || '', data.name || '',
      data.invoice, data.customer || '', data.reason || 'ETC',
      qty, data.note || '', 'active'
    ]]);
    // ★ 2026-07-22 신규 — 매우 중요한 버그 수정:
    //   총량피킹은 "스캔 = 그 SKU를 필요로 하는 모든 고객사가 즉시 전량 pass
    //   처리"되는 구조라서, 이슈를 나중에 등록해도 그 전에 이미 서버에는
    //   "287개 pass"라는 기록이 그대로 남아있었음. 그래서 이슈를 취소(undone)
    //   해도 이 phantom pass 기록 때문에 현황판이 계속 "완료"로 잘못 표시됨
    //   (실제 사례: EXP 287개 이슈 취소했는데 TV엔 계속 287/287 완료로 남음).
    //   → 이슈 등록과 동시에 그 수량만큼 상쇄하는 마이너스 pass 기록을 남겨서
    //   실제 "확인된 처리량"이 정확해지도록 함. 이 보정 기록은 이슈를 나중에
    //   취소해도 그대로 유지됨 — "이슈 취소"는 "필요수량에 다시 포함시킨다"는
    //   뜻이지 "이미 스캔된 걸로 자동 확정한다"는 뜻이 아니기 때문
    //   (다시 필요하다고 표시된 이상, 실제로 다시 스캔해서 확인해야 정확함).
    // ★ 2026-08-05 긴급 수정 — 이 ADJ 상쇄기록도 같은 이유로 텍스트 고정.
    const sl2 = scanlogSheet_();
    const sl2NewRow = sl2.getLastRow() + 1;
    ensureSheetRoom_(sl2, sl2NewRow); // ★ 2026-08-12 신규
    sl2.getRange(sl2NewRow, 5, 1, 2).setNumberFormat('@'); // E:Barcode, F:SKU
    sl2.getRange(sl2NewRow, 1, 1, 12).setValues([[
      data.batchId, 'ADJ-' + issueId, batchNow_(), data.worker || '',
      data.barcode || '', data.sku || '', '', data.customer || '',
      data.invoice, 'pass', 'active', -qty
    ]]);
    bumpVersion_();
    // ★ 2026-07-24 신규: 이슈 등록으로 필요수량이 줄어들어 방금 완료로 바뀌었을 수 있음
    try { syncInspectionFromPicking_(data.batchId, data.invoice, data.worker); } catch (e) { /* 무시 */ }
    return { ok: true, issueId: issueId };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== ④-3 undoIssue (★ 2026-07-16 신규) =====================
 * 잘못 등록한 이슈를 취소 (삭제 대신 Status를 'undone'으로 변경)
 * ★ 2026-07-22: logIssue가 같이 남긴 상쇄용 보정 스캔 기록(ADJ-이슈ID)은
 *   여기서 일부러 건드리지 않음 — "이슈 취소"는 "다시 필요수량에 포함시킨다"
 *   는 뜻이지 "그 수량이 이미 정상적으로 스캔된 걸로 자동 확정한다"는 뜻이
 *   아니기 때문. 다시 필요하다고 표시된 이상, 실제로 재스캔해서 확인해야 함.
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
        // ★ 2026-07-24 신규: 이슈 취소로 필요수량이 다시 늘어나 완료 상태가
        //   풀릴 수도, 반대로(다른 이슈 겹침 등) 그대로 완료일 수도 있음 — 재확인
        const rowVals = sh.getRange(i + 2, 1, 1, 8).getValues()[0]; // A~H
        try { syncInspectionFromPicking_(rowVals[0], rowVals[7], rowVals[3]); } catch (e) { /* 무시 */ }
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
        // ★ 2026-07-22 신규: 수량을 고치면, logIssue가 같이 남겨둔 상쇄용
        //   보정 스캔 기록(ADJ-이슈ID)의 수량도 같이 맞춰줘야 정확함.
        const sl = scanlogSheet_();
        const slLast = sl.getLastRow();
        if (slLast >= 2) {
          const scanIds = sl.getRange(2, 2, slLast - 1, 1).getValues();
          const adjTarget = 'ADJ-' + issueId;
          for (let j = 0; j < scanIds.length; j++) {
            if (String(scanIds[j][0]) === adjTarget) {
              sl.getRange(j + 2, 12).setValue(-qty); // L: Qty
              break;
            }
          }
        }
        bumpVersion_();
        // ★ 2026-07-24 신규: 수량/사유를 고치면 완료 여부가 바뀔 수 있음 — 재확인
        const rowVals = sh.getRange(row, 1, 1, 8).getValues()[0]; // A~H
        try { syncInspectionFromPicking_(rowVals[0], rowVals[7], rowVals[3]); } catch (e) { /* 무시 */ }
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
    const sh = picktimeSheetSafe_();

    if (data.action === 'start') {
      // ★ 2026-07-22 신규: 두 기기에서 거의 동시에 같은 작업자로 "피킹 시작"을
      //   누르는 경합 상황을 서버단에서 완전히 차단 — 이미 종료 안 된(진행중인)
      //   세션이 있으면 새로 시작하지 못하게 막음. LockService로 감싸져 있어
      //   이 체크와 appendRow 사이에 다른 요청이 끼어들 수 없음(원자적 처리).
      const last0 = sh.getLastRow();
      if (last0 >= 2) {
        const rows0 = sh.getRange(2, 1, last0 - 1, 7).getValues();
        for (let i = 0; i < rows0.length; i++) {
          const hasEnd = (rows0[i][4] !== '' && rows0[i][4] !== null && rows0[i][4] !== undefined);
          if (String(rows0[i][0]) === String(data.batchId) && String(rows0[i][1]) === String(data.worker) && !hasEnd) {
            if (!data.force) {
              return { ok: false, error: 'already_picking', startedAt: rows0[i][3] };
            }
            // ★ 2026-08-03 신규 — 강제 시작: 태블릿이 새로고침되는 등으로 원래
            //   기기가 "종료"를 누를 방법이 없어져 버린 orphan(고아) 세션을
            //   지금 시각으로 자동 종료 처리한 뒤, 새 세션을 시작함. 작업자/매니저가
            //   명시적으로 "강제 종료 후 새로 시작"을 선택했을 때만 이 경로를 탐.
            // ★ 2026-08-18 수정 — 예전엔 (지금시각−시작시각)을 그대로 분으로
            //   써서, 전날 퇴근 후 종료를 안 누르고 다음날 강제종료하면 17시간
            //   넘는 값이 그대로 찍혔음. 근무시간 기준 계산(calcWorkMinutes_)으로
            //   바꿔서, 실제 근무시간에 해당하는 만큼만 정확히 반영되게 함.
            //   또한 Note 컬럼에 강제종료 사실을 남겨 감사(audit) 시 구분 가능하게 함.
            const forceEndTs = batchNow_();
            const forceMins = calcWorkMinutes_(rows0[i][3], forceEndTs);
            sh.getRange(i + 2, 5).setValue(forceEndTs);
            sh.getRange(i + 2, 6).setValue(forceMins);
            sh.getRange(i + 2, 7).setValue('⚠ force-closed · 전날(이전) 세션 미종료 상태에서 강제종료됨 · 시간은 근무시간 기준 자동계산');
            break; // 한 작업자당 열린 세션은 최대 1개이므로 찾으면 종료 처리 후 계속 진행
          }
        }
      }
      // ★ 2026-08-07 수정(현장 발견) — 담당페이지가 KPI에 날짜로 표시되던 문제.
      //   구글시트는 "1-3", "4-6", "7-9" 같은 값을 날짜로 자동 변환함(1-3 → 1월 3일).
      //   그래서 담당페이지가 2026-01-03T07:00:00.000Z 처럼 저장됐음.
      //   Kevin Kim의 "13-17"만 멀쥰했던 건 13월이 없어 변환이 안 됐기 때문.
      //   → 저장할 칸의 서식을 '텍스트'로 고정해서 입력값이 그대로 남게 함.
      const _ptRow = sh.getLastRow() + 1;
      try { sh.getRange(_ptRow, 3).setNumberFormat('@'); } catch (e) { /* 서식 실패해도 저장은 진행 */ }
      sh.appendRow([data.batchId, data.worker, data.pageRange || '', batchNow_(), '', '', '']);
      // ★ 2026-08-06 신규 — 작업자가 "▶ 피킹 시작"을 누른 이 순간이 실제 피킹 시작.
      //   스캔은 분류 단계일 뿐이라 스캔 유무로 판단하면 안 됨(매니저 확인 사항).
      //   배치에 속한 모든 오더를 한꺼번에 Started로 만들어, 메인 대시보드·영업
      //   화면이 창고 실제 상황과 같은 값을 보이게 함. 이미 시작/완료된 건과
      //   사람이 직접 배정한 건은 건드리지 않음.
      try { syncBatchJobsStart(data.batchId); } catch (e) { Logger.log('syncBatchJobsStart 실패: ' + e); }
      return { ok: true };
    }
    if (data.action === 'end') {
      const last = sh.getLastRow();
      if (last >= 2) {
        const rows = sh.getRange(2, 1, last - 1, 6).getValues();
        for (let i = rows.length - 1; i >= 0; i--) {
          if (String(rows[i][0]) === String(data.batchId) && String(rows[i][1]) === String(data.worker) && !rows[i][4]) {
            // ★ 2026-08-18 수정 — 근무시간 기준 계산으로 교체(위 force-close와 동일 함수).
            //   평소(당일 종료) 케이스는 근무시간 안에서 끝나므로 예전 계산과 결과가 같음.
            const endTs = batchNow_();
            const mins = calcWorkMinutes_(rows[i][3], endTs);
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
    // ★ 2026-08-19 신규(긴급) — 작업자 6명 이상이 각자 10초마다 이 함수를
    //   호출해서 서버 부담이 큼. 다른 함수보다 짧게(4초) 캐싱 — 피킹 시작/종료
    //   확인은 좀 더 즉각적이어야 하므로.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'activePickers_v1_' + batchId;
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

    const sh = picktimeSheetSafe_();
    const last = sh.getLastRow();
    const active = {};
    const STALE_MS = 4 * 60 * 60 * 1000; // 4시간
    const nowMs = Date.now();
    // ★ 2026-08-19 신규 — 작업자별 "이 배치에서 가장 최근에 담당했던 페이지
    //   범위"도 같이 계산. 시간순으로 훑으면서 매번 최신 것으로 덮어씀(시트가
    //   시간순 append라 순서대로 훑으면 마지막에 남는 게 최신).
    //   batch.html에서 "전날 담당페이지 이어서 시작할까요?" 확인창에 씀.
    const lastPageRange = {};
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 6).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const worker = r[1];
        const pageRange = fixPageRange_(r[2]);
        const startTs = r[3], endTs = r[4];
        const hasStart = (Object.prototype.toString.call(startTs) === '[object Date]' && !isNaN(startTs));
        const hasEnd = (endTs !== '' && endTs !== null && endTs !== undefined);
        if (hasStart && !hasEnd) {
          const age = nowMs - startTs.getTime();
          if (age < STALE_MS) {
            active[worker] = Utilities.formatDate(startTs, batchTz_(), 'HH:mm');
          }
        }
        if (worker && pageRange) {
          lastPageRange[worker] = { pageRange: pageRange, ended: hasEnd };
        }
      });
    }
    const _result = { ok: true, active: active, lastPageRange: lastPageRange };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 4);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
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

    // ★ 2026-08-19 신규(긴급) — Scan Log 탭 열 때마다(그리고 자동 새로고침 때마다)
    //   부르는 무거운 함수(ScanLog/PickTiming/IssueLog 조합 계산)라 6초 캐시로 완화.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'batchKPI_v1_' + batchId;
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

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
        passScans.push({ worker: w, workerKey: String(w || '').trim().toUpperCase(), sku: r[5], qty: qty, timeMs: timeMs });
        if (!scanByWorker[w]) scanByWorker[w] = { worker: w, pass: 0 };
        scanByWorker[w].pass++;
        totalPass++;
      });
    }

    // ① 피킹 세션 목록
    const pt = picktimeSheetSafe_();
    const ptLast = pt.getLastRow();
    // ★ 2026-08-07 재설계 — SKU/PCS 집계 구간을 바꿈.
    //   예전: 피킹 시작 ~ 피킹 종료 사이만 집계.
    //   문제: 총량피킹은 "집기 → 분류 → 집기 → 분류"를 반복하고, 작업자는
        //   담당 페이지를 다 집은 순간 종료를 누른 뒤에도 분류 스캔을 계속함.
    //   그래서 JAMES PARK처럼 140분 일했는데 SKU/PCS가 0으로 나왔음.
    //   새 기준: 이 세션 시작 ~ 같은 사람의 다음 세션 시작 직전까지.
    //   다음 세션이 없으면 지금까지. 구간이 겹치지 않아 중복 집계도 없음.
    const rawSessions = [];
    if (ptLast >= 2) {
      pt.getRange(2, 1, ptLast - 1, 7).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const worker = r[1];
        const workerKey = String(worker || '').trim().toUpperCase();
        const startTs = r[3], endTs = r[4];
        const startMs = (Object.prototype.toString.call(startTs) === '[object Date]' && !isNaN(startTs)) ? startTs.getTime() : NaN;
        const endMs = (Object.prototype.toString.call(endTs) === '[object Date]' && !isNaN(endTs)) ? endTs.getTime() : NaN;

        rawSessions.push({
          worker: worker,
          workerKey: workerKey,
          pageRange: fixPageRange_(r[2]),
          start: !isNaN(startMs) ? Utilities.formatDate(startTs, batchTz_(), 'HH:mm') : '-',
          end: !isNaN(endMs) ? Utilities.formatDate(endTs, batchTz_(), 'HH:mm') : '진행중',
          durationMinutes: Number(r[5]) || 0,
          note: String(r[6] || ''), // ★ 2026-08-18 신규 — 강제종료(전날 미종료) 등 감사용 메모
          totalSku: 0, totalQty: 0,
          _startMs: startMs,
          _sortMs: isNaN(startMs) ? 0 : startMs,
        });
      });
    }
    // 같은 작업자의 세션을 시간순으로 줄 세워, 각 세션의 집계 끝을
    // "다음 세션 시작 직전"으로 잡음. 마지막 세션은 지금까지.
    const byWorker = {};
    rawSessions.forEach(s2 => {
      if (isNaN(s2._startMs)) return;
      if (!byWorker[s2.workerKey]) byWorker[s2.workerKey] = [];
      byWorker[s2.workerKey].push(s2);
    });
    const nowMs2 = Date.now();
    Object.keys(byWorker).forEach(k => {
      const list = byWorker[k].sort((a, b) => a._startMs - b._startMs);
      list.forEach((s2, i) => {
        const from = s2._startMs;
        const to = (i + 1 < list.length) ? list[i + 1]._startMs : nowMs2;
        const skuSet = {};
        let qty = 0;
        passScans.forEach(sc => {
          if (sc.workerKey !== k) return;
          if (isNaN(sc.timeMs) || sc.timeMs < from || sc.timeMs >= to) return;
          skuSet[String(sc.sku)] = true;
          qty += sc.qty;
        });
        s2.totalSku = Object.keys(skuSet).length;
        s2.totalQty = qty;
      });
    });
    const sessions = rawSessions;
    sessions.sort((a, b) => b._sortMs - a._sortMs); // 최신순
    sessions.forEach(s => delete s._sortMs);

    // ② 작업자별 이슈(EXP/NF/Damaged/OOS) 집계
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const issueByWorker = {};
    const issueTotalsByReason = {};
    // ★ 2026-08-19 신규 — 이슈 "건수"만이 아니라 실제 내역(어떤 고객사의
    //   어떤 상품이 무슨 사유로 등록됐는지)도 작업자별로 모아둠. KPI 표에서
    //   이슈 건수를 클릭하면 팝업으로 상세를 바로 보여주기 위함.
    const issueItemsByWorker = {};
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

        if (!issueItemsByWorker[w]) issueItemsByWorker[w] = [];
        const tsVal = r[2];
        const timeStr = (Object.prototype.toString.call(tsVal) === '[object Date]' && !isNaN(tsVal))
          ? Utilities.formatDate(tsVal, batchTz_(), 'MM-dd HH:mm') : String(tsVal || '');
        issueItemsByWorker[w].push({
          time: timeStr, barcode: r[4], sku: r[5], name: r[6],
          invoice: r[7], customer: r[8], reason: reason, qty: qty, note: r[11] || ''
        });
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

    const _result = {
      ok: true,
      batch: batchInfo,
      pickSessions: sessions,
      scanStats: scanStats,
      issueItemsByWorker: issueItemsByWorker, // ★ 2026-08-19 신규 — 이슈 클릭 팝업용
      totals: {
        pass: totalPass,
        issueCount: totalIssueCount,
        issueQty: totalIssueQty,
        byReason: issueTotalsByReason,
      }
    };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 6);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
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
/* ===================== ③d getInvoiceItemStatus (★ 2026-07-24 신규) =====================
 * 목적: "이 고객사(인보이스) 중 어떤 SKU가 아직 안 채워졌는지 모르겠다"는
 * 현장 피드백 반영 — 이슈 등록 팝업의 SKU 목록에서, 각 상품이 얼마나
 * 스캔됐는지(완료/부족)를 같이 보여줘서 미완료 SKU를 목록만 보고 바로
 * 찾을 수 있게 함. TV(board.html)가 이 함수를 씀 (웹은 이미 로컬 데이터로 계산 가능).
 * 입력: batchId, invoice / 출력: { ok, items:[{sku,name,barcode,reqQty,scannedQty,issueQty,short}] }
 * ================================================================================ */
function getInvoiceItemStatus(batchId, invoice) {
  try {
    if (!batchId || !invoice) return { ok: false, error: 'batchId, invoice required' };

    // ★ 2026-08-19 신규(긴급) — 슬롯 클릭 시(이슈 모달 열 때)마다 부르는 함수라
    //   6초 캐시로 서버 부담 완화. 여러 사람이 같은 슬롯을 거의 동시에 봐도
    //   첫 번째만 실제 계산.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'invItemStatus_v1_' + batchId + '_' + invoice;
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

    // ★ 2026-07-28 긴급 수정 — 이 함수 전체를 "바코드" 단독 키에서
    //   "바코드|SKU" 조합 키로 변경. 같은 바코드가 서로 다른 SKU 2개에
    //   중복으로 쓰이는 경우(실제 사고 사례: Flower Park 12개 / Flower Shop
    //   24개), 예전엔 이 팝업에서도 두 상품이 하나로 합쳐져서 보였음.
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const scannedByKey = {};
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[8]) !== String(invoice)) return;
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return;
        const key = normBarcode_(r[4]) + '|' + String(r[5]); // barcode|sku ★ 2026-08-05: normBarcode_ 적용
        scannedByKey[key] = (scannedByKey[key] || 0) + (Number(r[11]) || 1);
      });
      // ★ 2026-07-24 긴급 수정 — 같은 버그: 상쇄용 ADJ 기록 때문에 순 스캔량이
      //   음수가 되면 "이슈로 이미 처리된 상품"이 "스캔 안 된 상품"처럼 잘못
      //   보였음(예: "-10/10 (10개 부족)"). SKU별 순 스캔량은 0 밑으로 안 내려가게 고정.
      Object.keys(scannedByKey).forEach(key => { if (scannedByKey[key] < 0) scannedByKey[key] = 0; });
    }
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const issueByKey = {};
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[7]) !== String(invoice)) return;
        if (r[12] === 'undone') return;
        const key = normBarcode_(r[4]) + '|' + String(r[5]); // ★ 2026-08-05: normBarcode_ 적용
        issueByKey[key] = (issueByKey[key] || 0) + (Number(r[10]) || 0);
      });
    }

    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    const reqByKey = {}; // "바코드|SKU" 같은 조합 여러 줄이면 합산(분할입고 등)
    const infoByKey = {};
    if (biLast >= 2) {
      bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (String(r[1]) !== String(invoice)) return;
        const skuCode = String(r[2]);
        const bc = String(r[4]); // 원본 표시용(정규화 안 함 — 앞자리 0 그대로 화면에 보여줌)
        const key = normBarcode_(r[4]) + '|' + skuCode; // ★ 2026-08-05: 키는 정규화, 표시는 원본
        reqByKey[key] = (reqByKey[key] || 0) + (Number(r[5]) || 0);
        infoByKey[key] = { sku: r[2], name: r[3], barcode: bc };
      });
    }

    const items = Object.keys(reqByKey).map(key => {
      const reqQty = reqByKey[key];
      const scannedQty = scannedByKey[key] || 0;
      const issueQty = issueByKey[key] || 0;
      const info = infoByKey[key] || {};
      return {
        barcode: info.barcode || key.split('|')[0], sku: info.sku || '', name: info.name || '',
        reqQty: reqQty, scannedQty: scannedQty, issueQty: issueQty,
        short: Math.max(0, reqQty - scannedQty - issueQty),
      };
    });
    const _result = { ok: true, invoice: invoice, items: items };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 6);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function getSlotProgress(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };

    // ★ 2026-08-19 신규(긴급) — TV가 12초, batch.html이 8~10초마다 이 함수를
    //   부르는데, 그때마다 ScanLog/IssueLog 등 여러 시트를 통째로 훑는 무거운
    //   계산을 매번 새로 함. 오늘 여러 기기(TV+작업자 6명+폰)가 동시에 몰리면서
    //   Apps Script 동시 실행 한도에 부딪혀 fetch/XHR/JSONP 전부 실패하는 사고로
    //   이어짐. 6초짜리 짧은 캐시를 둬서, 그 사이 여러 기기가 물어봐도 첫
    //   번째만 실제 계산하고 나머지는 캐시를 즉시 돌려줌(계산 자체가 없어서
    //   실행시간이 거의 0에 가까움 → 동시 실행 슬롯을 훨씬 빨리 비워줌).
    //   데이터가 실제로 바뀌면(logScan 등) 최대 6초의 지연만 감수하면 됨.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'slotProgress_v1_' + batchId;
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

    // 고객사별 스캔 통과(pass) 수량 집계 (undone 제외) — 전체 QTY용, 그리고
    // invoice+바코드+SKU 조합별로도 따로 집계 — SKU 단위 완료 판정용
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const scannedByKey = {}; // "invoice|barcode|sku"
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return; // over/error는 완료 카운트에 안 넣음
        // ★ 2026-07-13: 스캔 1건 = +1이 아니라, 그 스캔으로 분류된 실제 수량(Qty
        //   컬럼)만큼 더함. 예전 데이터(Qty 컬럼 없음)는 1로 취급해 하위호환.
        const qty = Number(r[11]) || 1;
        const inv = r[8];
        // ★ 2026-07-28 긴급 수정 — 심각한 사고 발견: 같은 바코드가 서로 다른
        //   두 SKU에 중복으로 쓰이는 경우(예: 동일 바코드로 "Flower Park"
        //   12개와 "Flower Shop" 24개), 예전엔 키가 invoice+바코드뿐이라 두
        //   SKU의 스캔량이 하나로 합쳐져서(36개) 서로 다른 상품인데 진행률을
        //   나눠 갖는 사고가 있었음. 이제 SKU까지 포함해 완전히 분리 추적.
        const key = inv + '|' + normBarcode_(r[4]) + '|' + String(r[5]); // invoice|barcode|sku ★ 2026-08-05: normBarcode_ 적용
        //   이슈 등록 시 남기는 상쇄 기록(scanId가 'ADJ-'로 시작, 마이너스 수량)은
        //   "이 SKU를 스캔 안 했는데 총량 스캔 한 번에 모든 고객사가 자동으로
        //   pass 처리되는 phantom pass"를 되돌리기 위한 것이었음. 그런데 애초에
        //   phantom pass가 안 생겼던 경우(=그 SKU를 실제로 한 번도 스캔 안 하고
        //   바로 이슈부터 등록한 경우, 흔한 정상 흐름), 상쇄할 게 없는데 마이너스만
        //   남아서 그 SKU의 순수 스캔량이 영구적으로 음수가 됨. 이 음수가 "완료
        //   판정 기준"에서 이슈 수량(effectiveTotal 계산)과 별개로 스캔량(scanned)
        //   에서도 또 한 번 빠져서, 이슈로 이미 해결된 수량이 "진행량 부족"으로
        //   이중으로 잡히는 사고가 있었음(예: 21번 슬롯이 실제로는 다 채워졌는데
        //   계속 미완료로 표시됨). 해결: SKU 하나(=바코드+SKU+인보이스)의 순
        //   스캔량은 절대 0 밑으로 안 내려가게(음수는 0으로) 고정한 뒤에 합산함.
        scannedByKey[key] = (scannedByKey[key] || 0) + qty;
      });
    }
    // 위에서 구한 SKU별 순 스캔량을 0 밑으로 안 내려가게 고정 (인보이스 합계는
    // skuLinesByKey를 구한 뒤 "각 줄의 필요수량으로 캡핑"해서 계산함 — 아래 참고)
    Object.keys(scannedByKey).forEach(key => {
      if (scannedByKey[key] < 0) scannedByKey[key] = 0;
    });

    // ★ 2026-07-16 신규: EXP/NF/Damaged/OOS 등으로 등록된 이슈 수량 집계.
    //   이 수량만큼은 애초에 "필요하지 않았던 것"처럼 그 고객사(Invoice)의
    //   완료 판정 기준(totalQty)에서 빼준다 — 100% 못 채워도 완료로 표시되도록.
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const issueQtyByInvoice = {};
    const issueQtyByKey = {}; // "invoice|barcode|sku"
    const issuesByInvoice = {};
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[12] === 'undone') return;
        const inv = r[7];
        const qty = Number(r[10]) || 0;
        issueQtyByInvoice[inv] = (issueQtyByInvoice[inv] || 0) + qty;
        // ★ 2026-07-28 수정 — SKU까지 포함한 키로 변경 (scannedByKey와 동일 기준)
        const key = inv + '|' + normBarcode_(r[4]) + '|' + String(r[5]); // ★ 2026-08-05: normBarcode_ 적용
        issueQtyByKey[key] = (issueQtyByKey[key] || 0) + qty;
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
    // ★ 2026-07-24 긴급 수정(유지) — 같은 바코드가 고객사 PDF에 두 줄로 나뉘어
    //   있으면(예: 분할 입고로 700개+570개) 여기서 그걸 합치지 않고 각 줄을
    //   "별도의 SKU"처럼 취급해서 각각 완료 판정을 내렸던 문제 — 같은
    //   invoice+바코드+SKU는 먼저 필요수량을 합산해서 "하나의 상품 줄"로 묶은
    //   뒤에 완료 여부를 판정함.
    // ★ 2026-07-28 긴급 수정 — 여기에 SKU를 안 넣으면 정반대의 사고가 남:
    //   바코드는 같지만 SKU가 다른 두 "진짜 다른 상품"(Flower Park/Shop)이
    //   하나로 합쳐져서 둘 중 하나만 스캔해도 둘 다 완료로 잘못 카운트됨.
    //   그래서 이제 "invoice|바코드|SKU"까지 다 같아야만 진짜 같은 줄로 병합함.
    const skuLinesByKey = {}; // "invoice|barcode|sku" -> { invoice, reqQty(합산) }
    if (biLast >= 2) {
      bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const inv = r[1];
        if (!inv) return; // 총량 행(Invoice 빈값)은 제외 — 고객사 행만 집계
        const bcKey = inv + '|' + normBarcode_(r[4]) + '|' + String(r[2]); // invoice|barcode|sku ★ 2026-08-05: normBarcode_ 적용
        if (!skuLinesByKey[bcKey]) skuLinesByKey[bcKey] = { invoice: inv, reqQty: 0 };
        skuLinesByKey[bcKey].reqQty += Number(r[5]) || 0;
      });
    }

    // ★ 2026-07-29 설계 변경 — 예전엔 스캔량을 인보이스 단위로 그냥 다 더해서,
    //   SKU 한 줄이 필요수량보다 많이 찍혀도 그 초과분까지 합계에 그대로
    //   반영됐음. 그 결과 "SKU 30/30(전부 완료)"인데 "수량 767/731"처럼 분자가
    //   분모를 넘는 앞뒤 안 맞는 숫자가 노출되는 사고가 있었음. 현장에서는
    //   작업자가 정확한 수량만 가져오는 게 원칙이라(초과가 있으면 안 됨), 이제
    //   SKU 한 줄의 기여분을 "그 줄의 필요수량(이슈 반영)"으로 캡핑한 뒤에만
    //   인보이스 합계에 더함 — 이러면 수학적으로 분자가 분모를 절대 못 넘고,
    //   "SKU 전부 완료"와 "수량 100%"가 항상 정확히 일치하게 됨.
    const scannedByInvoice = {};
    Object.entries(skuLinesByKey).forEach(([key, line]) => {
      const inv = line.invoice;
      const scannedQty = scannedByKey[key] || 0;
      const issueQty = issueQtyByKey[key] || 0;
      const lineCap = Math.max(0, line.reqQty - issueQty); // 이 줄이 실제로 채워야 할 몫
      const cappedContribution = Math.min(scannedQty, lineCap); // 초과분은 버림
      scannedByInvoice[inv] = (scannedByInvoice[inv] || 0) + cappedContribution;
    });
    const skuStatsByInvoice = {}; // invoice -> {totalSku, doneSku}
    Object.entries(skuLinesByKey).forEach(([key, line]) => {
      const inv = line.invoice;
      if (!skuStatsByInvoice[inv]) skuStatsByInvoice[inv] = { totalSku: 0, doneSku: 0 };
      skuStatsByInvoice[inv].totalSku++; // invoice+바코드+SKU 기준 고유 상품 1개로 카운트
      const scannedQty = scannedByKey[key] || 0;
      const issueQty = issueQtyByKey[key] || 0;
      // 병합된(=진짜) 필요수량 기준으로, 스캔+이슈 합계가 그걸 채웠을 때만 완료로 카운트
      // (완료 판정 로직 scanned>=effectiveTotal과 같은 원칙을 SKU 단위로도 적용).
      if (scannedQty + issueQty >= line.reqQty) skuStatsByInvoice[inv].doneSku++;
    });

    // ★ 2026-08-24 신규 — 패킹검증 진행률 집계(오출고 방지 신기능). 검수 진행률과는
    //   완전히 별개로, PackScanLog(패킹존 재검증 스캔)를 바코드 단위로 집계함.
    //   패킹 작업자는 SKU를 모르고 바코드만 스캔하므로 SKU가 아니라 바코드로 매칭.
    const pl = packscanSheet_();
    const plLast = pl.getLastRow();
    const packedByInvBarcode = {}; // "invoice|바코드"
    if (plLast >= 2) {
      pl.getRange(2, 1, plLast - 1, 10).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[8] === 'undone') return;
        if (r[7] !== 'pass') return;
        const key = String(r[6]) + '|' + normBarcode_(r[4]);
        packedByInvBarcode[key] = (packedByInvBarcode[key] || 0) + (Number(r[9]) || 0);
      });
    }
    const packReqByInvBarcode = {}; // "invoice|바코드" -> 필요수량(합산)
    if (biLast >= 2) {
      bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const inv = r[1];
        if (!inv) return;
        const key = String(inv) + '|' + normBarcode_(r[4]);
        packReqByInvBarcode[key] = (packReqByInvBarcode[key] || 0) + (Number(r[5]) || 0);
      });
    }
    const packIssueByInvBarcode = {}; // 검수 단계 이슈 반영(같은 바코드 기준으로 재집계)
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[12] === 'undone') return;
        const key = String(r[7]) + '|' + normBarcode_(r[4]);
        packIssueByInvBarcode[key] = (packIssueByInvBarcode[key] || 0) + (Number(r[10]) || 0);
      });
    }
    const packStatsByInvoice = {}; // invoice -> {totalReq, packed, totalLines, doneLines}
    Object.entries(packReqByInvBarcode).forEach(([key, reqQty]) => {
      const inv = key.slice(0, key.lastIndexOf('|'));
      const issueQty = packIssueByInvBarcode[key] || 0;
      const effReq = Math.max(0, reqQty - issueQty);
      const packedQty = Math.min(packedByInvBarcode[key] || 0, effReq);
      if (!packStatsByInvoice[inv]) packStatsByInvoice[inv] = { totalReq: 0, packed: 0, totalLines: 0, doneLines: 0 };
      const st = packStatsByInvoice[inv];
      st.totalReq += effReq;
      st.packed += packedQty;
      st.totalLines++;
      if (packedQty >= effReq) st.doneLines++;
    });

    // 고객사별 슬롯 정보 + 목표 수량
    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    const slots = [];
    if (bcLast >= 2) {
      // ★ 2026-08-24 확장 — 13번째 컬럼(PackVerified, 주황/최종 2차 검증완료)까지 읽음
      bc.getRange(2, 1, bcLast - 1, 13).getValues().forEach(r => {
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
        // ★ 2026-07-29 긴급 수정 — 심각한 사고 발견: "완료(초록)" 판정이 예전엔
        //   전체 수량 합계(scanned>=effectiveTotal)만 보고 있었음. 그런데 SKU가
        //   여러 개인 슬롯에서 어떤 SKU는 덜 스캔되고 다른 SKU는 초과 스캔되면,
        //   합계 수량은 우연히 딱 맞아떨어져도 실제로는 특정 SKU가 하나도 안
        //   채워진 채로 "완료"라고 잘못 표시되는 사고가 있었음(실제 사례: SKU
        //   148/156인데 카드가 초록색으로 뜸). 이제 수량 조건과 "SKU 단위로도
        //   전부 채워졌는지(doneSku>=totalSku)"를 둘 다 만족해야만 완료로 판정.
        const skuComplete = skuStat.totalSku > 0 ? (skuStat.doneSku >= skuStat.totalSku) : true;
        let status = 'waiting';
        if (scanned > 0 && scanned < effectiveTotal) status = 'active';
        if (effectiveTotal >= 0 && totalQty > 0 && scanned >= effectiveTotal) {
          status = skuComplete ? 'done' : 'active'; // 수량은 찼는데 SKU가 덜 끝났으면 진행중으로 유지
        }
        // ★ 2026-08-24 신규 — 패킹 단계(오출고 방지). K/L/M 컬럼 값을 그대로 신뢰.
        //   none: 검수완료 전 / moved(핑크): 이동대기 / taken(파랑): 패킹존 이동완료
        //   (★ 기존 의미·동작 그대로, 검증과 무관하게 즉시 전환됨)
        //   verified(주황): 최종 2차 검증완료 — 파랑 다음의 마지막 단계
        const packStat = packStatsByInvoice[invoice] || { totalReq: 0, packed: 0, totalLines: 0, doneLines: 0 };
        let packStage = 'none';
        if (r[12]) { packStage = 'verified'; }
        else if (r[11]) { packStage = 'taken'; }
        else if (r[10]) { packStage = 'moved'; }
        // ★ 매니저가 "임시A" 같은 문자 라벨로 수동 배정한 슬롯도 있을 수 있어
        //   숫자로 안 바뀌면 원래 값을 그대로 씀 (화면 정렬은 숫자만 우선순위로)
        const rawSlot = r[7];
        const numericSlot = Number(rawSlot);
        slots.push({
          slotNum: isNaN(numericSlot) ? rawSlot : numericSlot,
          slotSize: r[8], invoice: invoice,
          customer: r[2], shipVia: r[4], totalQty: totalQty,
          effectiveTotal: effectiveTotal, // ★ 2026-07-23 신규: 이슈 반영된 실제 필요수량 — TV가 웹(batch.html)과 같은 기준으로 보여주도록
          scanned: scanned, status: status,
          totalSku: skuStat.totalSku, doneSku: skuStat.doneSku,
          cleared: r[9] || '', // ★ 2026-07-14 신규: 비어있으면 "패킹완료·슬롯비우기" 버튼 표시 대상
          movedToPacking: !!r[10], // ★ 2026-07-23 신규: 패킹존 이동 체크(순수 표시용, clearSlot과 무관) — 기존 그대로
          takenOut: !!r[11], // ★ 2026-08-04 신규: 출고팀이 실제로 가져감(파란색 "패킹존 이동 완료" 상태) — 기존 그대로, 절대 안 바뀜
          packVerified: !!r[12], // ★ 2026-08-24 신규: 최종 2차 검증완료(주황) — 파랑 다음의 별도 마지막 단계
          issueQty: issueQty, // ★ 2026-07-16 신규: 현황판 "⚠ N" 뱃지용
          issues: issuesByInvoice[invoice] || [], // ★ 2026-07-16 신규: 뱃지 클릭 시 상세 목록
          // ★ 2026-08-24 신규 — 패킹검증(오출고 방지) 진행 상태
          packStage: packStage, packScanned: packStat.packed, packRequired: packStat.totalReq,
          packDoneLines: packStat.doneLines, packTotalLines: packStat.totalLines,
        });
      });
    }
    slots.sort((a, b) => {
      const an = Number(a.slotNum), bn = Number(b.slotNum);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return String(a.slotNum).localeCompare(String(b.slotNum));
    });

    const doneCount = slots.filter(s => s.status === 'done').length;
    // ★ 2026-08-06 신규 — 슬롯이 100% 찬 오더를 Jobs에 자동으로 완료 처리.
    //   여기 얹은 이유: 완료 판정에 필요한 계산이 바로 위에서 이미 끝났으므로
    //   따로 다시 계산할 필요가 없음. 다만 이 API는 TV가 8초, batch.html이 5초마다
    //   부르므로, "완료된 슬롯 목록이 지난번과 같으면 즉시 빠져나가기"로 막아둠.
    maybeSyncBatchJobsDone_(batchId, slots);
    const _result = { ok: true, slots: slots, doneCount: doneCount, totalCount: slots.length };
    // ★ 2026-08-19 신규 — 위 캐시 조회와 짝을 이루는 저장. 6초 후 자동 만료.
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 6);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== getUnfulfilledSkuAlerts (★ 2026-08-05 신규 — 재발 방지 핵심 기능) =====================
 * ★★★ "한쪽 고객사엔 배분됐는데 다른 고객사는 완전히 0인" 패턴을 실시간 감지 ★★★
 *
 * 배경: 총량피킹은 "스캔 1번 = 그 순간 대기 중인 모든 고객사 동시 배분" 방식이라,
 * 어떤 이유로든(정확한 원인 불명 — 조사 결과 클라이언트 화면 상태 문제로 추정)
 * 일부 고객사가 그 스캔 순간에 빠지면, 그 이후로 아무도 다시 스캔하지 않는 한
 * 영원히 "미완료"로 숨어있다가 TV 화면이 안 채워져야만 뒤늦게 발견됐음
 * (2026-08-05 실제 사고: BODP04-M 등 여러 상품이 9곳 중 4곳에게만 배분되고
 * 나머지 5곳은 스캔·이슈 기록이 전혀 없이 방치됨 — 지난주·이전에도 반복 발생).
 *
 * 이 함수는 그 패턴을 "TV가 안 채워지는 걸 사람이 알아챌 때까지" 기다리지 않고
 * 매 폴링마다 서버가 직접 찾아서 경보를 띄우기 위한 것. 배치 안의 모든
 * (인보이스, SKU) 줄 중, 같은 바코드+SKU가 배치 안 다른 고객사에게는 이미
 * 정상적으로 스캔(pass)됐는데 이 줄만 스캔·이슈 기록이 전혀 없는(matchSum=0)
 * 경우를 찾아서 반환한다. board.html이 이걸 주기적으로 조회해서 눈에 띄는
 * 배너로 보여줌 — 매니저가 실물을 확인하고 재피킹하거나 MISS로 정산하면 됨.
 * ================================================================================ */
function getUnfulfilledSkuAlerts(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };

    // ★ 2026-08-19 신규(긴급) — 오늘 확인된 서버 혼잡("Too many simultaneous
    //   invocations: Spreadsheets") 완화 조치를 이 함수까지 확대. 45초 폴링
    //   주기보다 짧은 15초 캐시라 실시간성 저하는 거의 없음.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'unfulfilledAlerts_v1_' + batchId;
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    const custLines = [];
    if (biLast >= 2) {
      bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        const inv = String(r[1]);
        if (!inv) return;
        custLines.push({ invoice: inv, sku: String(r[2]), name: String(r[3]), barcode: r[4], reqQty: Number(r[5]) || 0 });
      });
    }
    if (!custLines.length) return { ok: true, alerts: [] };

    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const allScanRows = [];
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[9] !== 'pass' || r[10] === 'undone') return;
        allScanRows.push({ barcode: r[4], sku: String(r[5]), invoice: String(r[8]), qty: Number(r[11]) || 0 });
      });
    }

    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const allIssueRows = [];
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[12] === 'undone') return;
        allIssueRows.push({ barcode: r[4], sku: String(r[5]), invoice: String(r[7]), qty: Number(r[10]) || 0 });
      });
    }

    // 슬롯 배정 정보(고객사명 표시용)
    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    const custNameByInvoice = {}, slotByInvoice = {};
    if (bcLast >= 2) {
      bc.getRange(2, 1, bcLast - 1, 8).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        custNameByInvoice[String(r[1])] = r[2];
        slotByInvoice[String(r[1])] = r[7];
      });
    }

    const alerts = [];
    custLines.forEach(line => {
      const normKey = normBarcode_(line.barcode) + '|' + line.sku;
      let matchSum = 0;
      allScanRows.forEach(s => { if (s.invoice === line.invoice && normBarcode_(s.barcode) + '|' + s.sku === normKey) matchSum += s.qty; });
      let issueQty = 0;
      allIssueRows.forEach(iss => { if (iss.invoice === line.invoice && normBarcode_(iss.barcode) + '|' + iss.sku === normKey) issueQty += iss.qty; });
      if (matchSum > 0 || issueQty > 0) return; // 조금이라도 처리된 흔적 있으면 경보 대상 아님
      if (matchSum >= line.reqQty) return;

      // 배치 안 다른 고객사에게는 이 바코드+SKU가 정상 스캔됐는지 확인
      const scannedElsewhere = allScanRows.some(s => s.invoice !== line.invoice && normBarcode_(s.barcode) + '|' + s.sku === normKey);
      if (!scannedElsewhere) return; // 배치 전체에 아무도 안 스캔했으면(진짜 미피킹 가능성) 이 경보 대상 아님 — 슬롯 카드의 기존 미완료 표시로 충분

      alerts.push({
        invoice: line.invoice, customer: custNameByInvoice[line.invoice] || '', slotNum: slotByInvoice[line.invoice] || '',
        sku: line.sku, name: line.name, barcode: String(line.barcode), reqQty: line.reqQty,
      });
    });

    const _result = { ok: true, alerts: alerts, count: alerts.length };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 15);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
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
          // ★ 2026-07-28 긴급 수정 — 심각한 사고 발견: 같은 바코드가 서로 다른
          //   두 SKU에 중복으로 쓰이는 경우(예: 동일 바코드로 "Flower Park"
          //   12개와 "Flower Shop" 24개가 서로 다른 상품인데), 예전엔 키가
          //   invoice+바코드뿐이라 두 SKU의 스캔량이 하나로 합쳐져서(36개)
          //   서로 다른 상품인데 같은 진행률을 나눠 갖는 사고가 있었음.
          //   이제 SKU까지 포함한 키로 완전히 분리 추적함.
          const key = r[8] + '|' + normBarcode_(r[4]) + '|' + r[5]; // invoice|barcode|sku ★ 2026-08-05: normBarcode_ 적용 — TV/웹이 "스캔했는데 완료 안 됨" 버그의 근본 수정
          doneMap[key] = (doneMap[key] || 0) + qty;
        }
      });
      // ★ 2026-07-24 긴급 수정 — getSlotProgress와 같은 버그: 이슈 등록 시 남는
      //   상쇄 기록(ADJ-, 마이너스 수량)이 상쇄할 phantom pass가 없으면 그 SKU의
      //   순 스캔량이 영구적으로 음수가 되어, 이미 이슈로 해결된 수량이 웹
      //   화면(batch.html)에서도 "진행량 부족"으로 이중으로 잡히는 문제가 있었음.
      //   SKU 하나(=인보이스+바코드+SKU)의 순 스캔량은 0 밑으로 안 내려가게 고정.
      Object.keys(doneMap).forEach(key => { if (doneMap[key] < 0) doneMap[key] = 0; });
    }

    scans.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)); // 최신순

    // ★ 2026-07-16 신규: 이슈 맵도 함께 반환 — invoice|barcode|sku 키로 누적 수량 집계
    const issueMap = {};
    const issues = [];
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        if (String(r[0]) !== String(batchId)) return;
        if (r[12] === 'undone') return;
        const inv = r[7], bc = String(r[4]), skuCode = String(r[5]);
        const qty = Number(r[10]) || 0;
        // ★ 2026-07-28 수정 — doneMap과 동일하게 SKU까지 포함한 키로 변경
        // ★ 2026-08-05 수정 — 키는 normBarcode_로 정규화, bc(표시용)는 원본 그대로 유지
        const key = inv + '|' + normBarcode_(r[4]) + '|' + skuCode;
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

// ★ 2026-08-19 신규(긴급, 요청 합치기) — batch.html이 8초·10초마다 따로따로
//   getScanState/getActivePickers 두 번 물어보던 걸 한 요청으로 합침. 폴링
//   주기는 그대로 유지하면서(느려지지 않음), 실제 네트워크 요청 개수 자체를
//   줄이는 게 목적. 기존 getScanState/getActivePickers는 그대로 남겨둠(다른
//   화면·기존 코드가 개별적으로 계속 쓸 수 있음) — 이 함수는 그 둘을 그대로
//   호출해서 한 응답에 담아줄 뿐, 계산 로직 자체는 중복 작성하지 않음.
function getScanAndPickers(batchId) {
  try {
    if (!batchId) return { ok: false, error: 'batchId required' };
    const scanRes = getScanState(batchId);
    const pickersRes = getActivePickers(batchId);
    return {
      ok: true,
      scanState: scanRes,
      activePickers: pickersRes,
    };
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
/* getBatchHistoryList — ★ 2026-08-25 신규(매니저 요청)
 * TV 현황판에서 "지난 배치"를 볼 수 있게 하는 전체 이력 조회. getOpenBatches()는
 * 일부러 "미완료 배치"만 보여주도록 설계돼 있어서(완료된 배치는 정상적으로
 * 목록에서 빠짐 — 이건 원래 의도된 동작), 몇 주 전에 이미 정상적으로 끝난
 * 배치의 고객사별 진행상황을 다시 보고 싶을 때 볼 방법이 없었음. 이 함수는
 * 완료 여부와 무관하게 전체 배치를 최신순으로 돌려줌(가벼운 요약 정보만 —
 * getOpenBatches처럼 스캔량까지 집계하면 무거워지므로 기본 정보만).
 * ★ 2026-08-25 수정(매니저 요청) — 계속 쌓이면 목록이 지저분해지니, 기본은
 * 최근 14일(2주)치만 보여줌. "지난주 배치"는 요일과 무관하게 항상 이 안에
 * 들어옴(7일이면 주 초반 조회 시 애매하게 걸릴 수 있어서 여유를 둠).
 * 더 예전 것이 필요하면 클라이언트가 data.days를 크게(예: 365) 넘겨서 요청.
 * 입력: { days (기본 14) } */
function getBatchHistoryList(data) {
  try {
    const days = (data && data.days) ? Number(data.days) : 14;
    const bSh = batchesSheet_();
    const last = bSh.getLastRow();
    if (last < 2) return { ok: true, batches: [] };
    const rows = bSh.getRange(2, 1, last - 1, 7).getValues();
    let list = rows.map(r => ({
      batchId: String(r[0]), date: r[1], status: String(r[2] || ''),
      totalSku: r[3], totalQty: r[4], createdAt: r[5], completedAt: r[6],
    }));
    if (days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = Utilities.formatDate(cutoff, batchTz_(), 'yyyy-MM-dd');
      list = list.filter(b => {
        let dStr = b.date;
        if (Object.prototype.toString.call(dStr) === '[object Date]') {
          dStr = Utilities.formatDate(dStr, batchTz_(), 'yyyy-MM-dd');
        } else {
          dStr = String(dStr || '').slice(0, 10);
        }
        return dStr >= cutoffStr;
      });
    }
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { ok: true, batches: list.slice(0, 90), days: days };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function getOpenBatches() {
  try {
    // ★ 2026-08-19 신규(긴급) — getSlotProgress와 동일한 이유. "다른 배치"
    //   드롭다운·초기 배치 감지 등에서 자주 불리는데 시트 여러 개를 훑는
    //   무거운 함수라, 여러 기기가 동시에 부르면 부담이 큼. 6초 캐시로 완화.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'openBatches_v1';
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

    const bSh = batchesSheet_();
    const last = bSh.getLastRow();
    if (last < 2) return { ok: true, batches: [] };

    const rows = bSh.getRange(2, 1, last - 1, 7).getValues();
    const open = [];
    const openIds = {};

    // ★ 2026-08-07 수정(매니저 지적) — 배치가 목록에서 사라지는 기준을 바꿈.
    //   예전: 모든 상품 스캔이 끝난 시점(completeBatch)부터 1시간.
    //   문제: 그 시점엔 물건이 아직 분류존에 그대로 있음(TV 현황판 전부 핵크).
    //   실제로 18/18이 전부 핵크인데 목록에서 사라져 당황하는 일이 생겼음.
    //   중간 기준: 출고팀이 전부 가져가서 파랑(TakenOut)이 된 뒤부터 1시간.
    // ★ 2026-08-24 재수정(매니저 지적) — 오출고 방지용 "최종 2차 검증"(보라)
    //   기능이 새로 생기면서, 위 "파랑 기준"이 또 낡아버렸음. 파랑은 이제
    //   "물리적으로 옮겼다"는 뜻일 뿐 진짜 끝난 게 아닌데, 이 기준대로면
    //   2차 검증이 채 끝나기도 전에 배치가 "다른 배치" 목록에서 사라질 수
    //   있었음(실제로 이 문제가 발생해서 TV에서 지난 배치를 못 찾는 일이 있었음).
    //   최종 기준: 전부 보라(PackVerified)가 된 뒤부터 1시간. 하나라도 아직
    //   검증 전이면(파랑에 머물러 있어도) 시간과 무관하게 계속 보임.
    const verifiedInfo = {}; // batchId -> { total, verified, lastMs }
    try {
      const bc = bcustSheetSafe_();
      const bcLast = bc.getLastRow();
      if (bcLast >= 2) {
        const bcRows = bc.getRange(2, 1, bcLast - 1, 13).getValues();
        bcRows.forEach(r2 => {
          const bid = String(r2[0] || '').trim();
          if (!bid) return;
          if (!verifiedInfo[bid]) verifiedInfo[bid] = { total: 0, verified: 0, lastMs: 0 };
          const info = verifiedInfo[bid];
          info.total++;
          const v = r2[12]; // M열: PackVerified
          if (v) {
            info.verified++;
            const ms = parseBatchTs_(v);
            if (!isNaN(ms) && ms > info.lastMs) info.lastMs = ms;
          }
        });
      }
    } catch (e) { /* 집계 실패해도 목록 조회는 계속 */ }
    // ★ 2026-08-05 신규(매니저 요청) — 예전엔 status==='completed'면 무조건
    //   목록에서 제외했음. 그런데 batch.html이 스캔 100% 완료 시 자동으로
    //   completeBatch를 호출하는 순간, 배치가 "미완료 목록"에서 바로 사라지면서
    //   동시에 배지/TV의 다른배치 드롭다운에서도 그 배치번호가 안 보이던 게 아니라
    //   (그건 그대로 남아있음) — 오히려 이 목록에서만 조용히 빠져서 "번호는
    //   남아있는데 목록에서만 갑자기 사라진다"는 일관성 문제가 있었음.
    //   이제 완료된 지 1시간이 안 된 배치는 "완료됨"으로 표시해서 그대로 보여주고,
    //   1시간이 지나야 목록에서 완전히 빠짐 — 완료 트리거 자체(스캔 100%)는
    //   그대로 유지하고, 화면 표시만 1시간 유예를 둠.
    const RECENT_COMPLETE_GRACE_MS = 60 * 60 * 1000; // 1시간
    const nowMs = Date.now();
    rows.forEach(r => {
      const status = String(r[2] || '');
      let recentlyCompleted = false, completedMinutesAgo = null, pendingTakeOut = 0;
      if (status === 'completed') {
        const completedAtRaw = r[6];
        if (!completedAtRaw) return; // 완료시각 기록 자체가 없는 오래된 배치는 제외
        // ★ 2026-08-25 재수정(2차 버그) — 위에서 "시간 무관하게 계속 보임"으로
        //   고쳤더니, 이번엔 정반대 사고가 남: 2차 검증(Pack Verify) 기능 자체가
        //   8/24에 처음 생겼기 때문에, 그 이전에 완료된 배치들(7월 것들까지 전부)은
        //   애초에 "검증"이라는 개념 자체가 없어서 전부 "검증 0/N"으로 걸려서
        //   무한정 살아나버렸음(실제로 7월 배치까지 전부 목록에 되살아난 사고
        //   발생). 이런 오래된 배치는 이미 몇 주 전에 정상적으로 출고 완료된
        //   것들이라 재검증이 필요 없음 — 그래서 "2차 검증 기능이 실제로 생긴
        //   시점(PACK_VERIFY_LAUNCH_MS) 이후에 완료된 배치"에만 이 규칙을 적용함.
        //   그 전에 완료된 배치는 예전 그대로 "완료 후 1시간"만 보여주고 사라짐.
        const _cMs = parseBatchTs_(completedAtRaw);
        const _vi = verifiedInfo[String(r[0] || '').trim()];
        const _isPostVerifyLaunch = !isNaN(_cMs) && _cMs >= PACK_VERIFY_LAUNCH_MS;
        if (_isPostVerifyLaunch && _vi && _vi.total > 0 && _vi.verified < _vi.total) {
          // ★ 2026-08-24 수정 — "아직 안 가져간 고객사" 대신 "아직 2차 검증 안 된
          //   고객사"가 남아 있으면 시간과 무관하게 계속 보임(파랑까지만 되고
          //   검증 전인 경우도 여기 포함됨 — 정확히 매니저가 지적한 부분).
          recentlyCompleted = true;
          completedMinutesAgo = null;
          pendingTakeOut = _vi.total - _vi.verified;
          const b0 = { batchId: String(r[0]), date: r[1], status: status, totalSku: r[3], totalQty: r[4], createdAt: r[5], recentlyCompleted: true, completedMinutesAgo: null, pendingTakeOut: pendingTakeOut };
          open.push(b0); openIds[b0.batchId] = true; return;
        }
        // 전부 검증 완료됐다면 마지막으로 검증된 시각부터 1시간을 셀
        const _lastVerifyMs = (_vi && _vi.lastMs) ? _vi.lastMs : 0;
        const completedMs = (_lastVerifyMs && !isNaN(_cMs)) ? Math.max(_lastVerifyMs, _cMs) : (_lastVerifyMs || _cMs);
        // ★ 2026-08-06 긴급 수정 — 1시간 유예가 처음부터 한 번도 작동하지 않던 버그.
        //   완료시각을 batchNow_()가 'yyyy-MM-dd HH:mm:ss' 문자열로 저장하지만,
        //   구글시트가 이를 날짜 값으로 자동 변환해서 getValues()는 Date 객체를 돌려줌.
        //   그런데 예전 코드는 문자열이라고 가정하고 String(raw).replace(' ','T')를 했고,
        //   Date 객체의 문자열은 "Thu Aug 06 2026 13:01:48 ..." 형태라 첫 공백이 바뀌어
        //   "ThuTAug 06 ..."라는 깨진 값이 되어 파싱이 항상 실패(NaN)했음.
        //   그리고 NaN이면 곧바로 return으로 목록에서 제외해버려서, 완료 즉시
        //   배치가 사라지는(=매니저가 "자동 삭제됐다"고 느낀) 현상이 생겼음.
        //   이제 Date 객체·문자열 양쪽을 모두 제대로 읽고, 혹시 못 읽더라도
        //   조용히 숨기지 않고 "완료됨"으로 계속 보여줌(숨기는 쪽이 훨씬 위험).
        if (isNaN(completedMs)) {
          recentlyCompleted = true;
          completedMinutesAgo = null;
        } else {
          if ((nowMs - completedMs) > RECENT_COMPLETE_GRACE_MS) return; // 1시간 지나면 목록에서 제외
          recentlyCompleted = true;
          completedMinutesAgo = Math.max(0, Math.round((nowMs - completedMs) / 60000));
        }
      }
      const b = { batchId: String(r[0]), date: r[1], status: status, totalSku: r[3], totalQty: r[4], createdAt: r[5], recentlyCompleted: recentlyCompleted, completedMinutesAgo: completedMinutesAgo };
      open.push(b);
      openIds[b.batchId] = true;
    });
    if (!open.length) return { ok: true, batches: [] };

    // 배치별 대략적인 진행률(통과 스캔 수량 합계) 계산 — 얼마나 진행됐는지 매니저가 판단할 수 있게
    const sl = scanlogSheet_();
    const slLast = sl.getLastRow();
    const passByBatch = {};
    // ★ 2026-08-03 신규 — SKU 줄 단위 완료 계산용: "batchId|invoice|barcode|sku" 키로
    //   스캔량 집계(오늘 다른 함수들과 동일한 원칙 — 초과분은 그 줄 자체 몫만 인정)
    const scannedByKey = {};
    if (slLast >= 2) {
      sl.getRange(2, 1, slLast - 1, 12).getValues().forEach(r => {
        const bid = String(r[0]);
        if (!openIds[bid]) return;
        if (r[10] === 'undone') return;
        if (r[9] !== 'pass') return;
        const qty = Number(r[11]) || 1;
        passByBatch[bid] = (passByBatch[bid] || 0) + qty;
        const key = bid + '|' + r[8] + '|' + normBarcode_(r[4]) + '|' + String(r[5]); // ★ 2026-08-05: normBarcode_ 적용
        scannedByKey[key] = (scannedByKey[key] || 0) + qty;
      });
    }
    Object.keys(scannedByKey).forEach(k => { if (scannedByKey[k] < 0) scannedByKey[k] = 0; });
    open.forEach(b => { b.scannedPass = passByBatch[b.batchId] || 0; });

    // ★ 2026-08-03 신규 — 요청: "이어서 작업하기" 목록에서 고객사 몇 건 중 몇 건
    //   완료, SKU 몇 건 중 몇 건 완료인지 한눈에 보이게. BatchItems(필요수량 줄)
    //   + IssueLog(이슈 수량) + 위 scannedByKey로 계산.
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const issueByKey = {};
    if (ilLast >= 2) {
      il.getRange(2, 1, ilLast - 1, 13).getValues().forEach(r => {
        const bid = String(r[0]);
        if (!openIds[bid]) return;
        if (r[12] === 'undone') return;
        const qty = Number(r[10]) || 0;
        const key = bid + '|' + r[7] + '|' + normBarcode_(r[4]) + '|' + String(r[5]); // ★ 2026-08-05: normBarcode_ 적용
        issueByKey[key] = (issueByKey[key] || 0) + qty;
      });
    }

    const bi = bitemsSheet_();
    const biLast = bi.getLastRow();
    const skuLinesByKey = {}; // "batchId|invoice|barcode|sku" -> reqQty(합산)
    const linesByInvoiceKey = {}; // "batchId|invoice" -> [key,...] (고객사별 완료판정용)
    if (biLast >= 2) {
      bi.getRange(2, 1, biLast - 1, 7).getValues().forEach(r => {
        const bid = String(r[0]);
        if (!openIds[bid]) return;
        const inv = r[1];
        if (!inv) return; // 총량 행(Invoice 빈값) 제외 — 고객사 행만 집계
        const key = bid + '|' + inv + '|' + normBarcode_(r[4]) + '|' + String(r[2]); // ★ 2026-08-05: normBarcode_ 적용
        if (!skuLinesByKey[key]) {
          skuLinesByKey[key] = 0;
          const ik = bid + '|' + inv;
          if (!linesByInvoiceKey[ik]) linesByInvoiceKey[ik] = [];
          linesByInvoiceKey[ik].push(key);
        }
        skuLinesByKey[key] += Number(r[5]) || 0;
      });
    }

    // SKU 줄 완료 개수 (배치 전체 기준)
    const doneSkuByBatch = {}, totalSkuByBatch = {};
    Object.entries(skuLinesByKey).forEach(([key, reqQty]) => {
      const bid = key.split('|')[0];
      totalSkuByBatch[bid] = (totalSkuByBatch[bid] || 0) + 1;
      const scanned = scannedByKey[key] || 0;
      const issue = issueByKey[key] || 0;
      if (scanned + issue >= reqQty) doneSkuByBatch[bid] = (doneSkuByBatch[bid] || 0) + 1;
    });

    // 고객사 단위 완료 개수 (그 고객사 소속 모든 SKU줄이 다 채워졌는지)
    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    const doneCustByBatch = {}, totalCustByBatch = {};
    if (bcLast >= 2) {
      bc.getRange(2, 1, bcLast - 1, 6).getValues().forEach(r => {
        const bid = String(r[0]);
        if (!openIds[bid]) return;
        const inv = String(r[1]);
        totalCustByBatch[bid] = (totalCustByBatch[bid] || 0) + 1;
        const ik = bid + '|' + inv;
        const lines = linesByInvoiceKey[ik] || [];
        const allLinesDone = lines.length > 0 && lines.every(key => {
          const reqQty = skuLinesByKey[key] || 0;
          const scanned = scannedByKey[key] || 0;
          const issue = issueByKey[key] || 0;
          return (scanned + issue) >= reqQty;
        });
        if (allLinesDone) doneCustByBatch[bid] = (doneCustByBatch[bid] || 0) + 1;
      });
    }

    open.forEach(b => {
      b.doneSku = doneSkuByBatch[b.batchId] || 0;
      b.totalSkuActual = totalSkuByBatch[b.batchId] || b.totalSku;
      b.totalCustomers = totalCustByBatch[b.batchId] || 0;
      b.doneCustomers = doneCustByBatch[b.batchId] || 0;
    });

    // 최신 생성순
    open.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const _result = { ok: true, batches: open };
    try {
      const _payload = JSON.stringify(_result);
      // ★ 2026-08-25 수정(속도 개선) — 6초→20초로 확대. 이 목록은 "훑어보고 고르는"
      //   용도라 살짝 오래된 숫자가 보여도 안전에 전혀 영향 없음 — 실제로 "전환"을
      //   누르는 순간에는 항상 getBatch/getScanState로 100% 최신 데이터를 다시
      //   받아오므로(안전장치 그대로 유지), 목록 자체만 좀 더 오래 캐시해서
      //   반복적으로 여는 속도를 개선함.
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 20);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ===================== ⑬ archiveOldBatches (★ 2026-07-22 신규) =====================
 * 목적: 메인 시트(Batches/BatchCustomers/BatchItems/ScanLog/PickTiming/IssueLog)가
 *       계속 쌓여서 느려지는 걸 막기 위해, "완료(completed)된 지 daysOld일이
 *       지난 배치"의 데이터를 삭제하는 대신 Archive_ 접두사가 붙은 별도 시트로
 *       옮김. 기록은 하나도 안 없어지고(Archive_ 시트에 그대로 있음), 매일
 *       쓰는 메인 시트만 가벼워짐.
 *
 * 사용법 1) 수동 실행: Apps Script 에디터에서 함수 목록 archiveOldBatches 선택
 *          → ▶ 실행 (기본 14일 지난 완료 배치를 옮김)
 * 사용법 2) 자동 실행(매일 새벽): 함수 목록에서 setupArchiveTrigger 선택
 *          → ▶ 실행 (한 번만 하면 그 뒤로 매일 새벽 자동으로 정리됨)
 *          끄고 싶으면 removeArchiveTrigger 실행
 * ===================================================================== */
function archiveOldBatches(daysOld) {
  daysOld = daysOld || 14; // 기본값: 완료된 지 14일 지난 배치부터 이동
  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const cutoffMs = Date.now() - daysOld * 24 * 60 * 60 * 1000;

    // 1) 옮길 대상 배치ID 목록 뽑기 — 완료 상태 + CompletedAt이 기준일보다 오래된 것만
    const bSh = batchesSheet_();
    const bLast = bSh.getLastRow();
    if (bLast < 2) { Logger.log('Batches: 데이터 없음'); return { ok: true, archived: [] }; }
    const bRows = bSh.getRange(2, 1, bLast - 1, 7).getValues();
    const targetBatchIds = [];
    bRows.forEach(r => {
      const status = String(r[2] || '');
      const completedAt = r[6];
      const isDate = Object.prototype.toString.call(completedAt) === '[object Date]' && !isNaN(completedAt);
      if (status === 'completed' && isDate && completedAt.getTime() < cutoffMs) {
        targetBatchIds.push(String(r[0]));
      }
    });

    if (targetBatchIds.length === 0) {
      Logger.log('보관 대상 없음 (완료된 지 ' + daysOld + '일 넘은 배치 없음)');
      return { ok: true, archived: [] };
    }

    // 2) 시트 6개 각각에 대해: 대상 배치 행은 Archive_ 시트로 복사 후 메인에서 제거
    const sheetsToArchive = [
      { name: BATCHES_SHEET,  get: batchesSheet_,  headers: ['BatchId','Date','Status','TotalSku','TotalQty','CreatedAt','CompletedAt'] },
      { name: BCUST_SHEET,    get: bcustSheet_,     headers: ['BatchId','Invoice','Customer','ShipDate','ShipVia','TotalQty','TotalSku','SlotNum','SlotSize','Cleared','MovedToPacking','TakenOut'] }, // ★ 2026-08-04: TakenOut 추가
      { name: BITEMS_SHEET,   get: bitemsSheet_,    headers: ['BatchId','Invoice','SKU','Name','Barcode','ReqQty','Rack'] },
      { name: SCANLOG_SHEET,  get: scanlogSheet_,   headers: ['BatchId','ScanId','Timestamp','Worker','Barcode','SKU','Slot','Customer','Invoice','Result','Status','Qty'] },
      { name: PICKTIME_SHEET, get: picktimeSheet_,  headers: ['BatchId','Worker','PageRange','PickStart','PickEnd','DurationMinutes'] },
      { name: ISSUELOG_SHEET, get: issuelogSheet_,  headers: ['BatchId','IssueId','Timestamp','Worker','Barcode','SKU','Name','Invoice','Customer','Reason','Qty','Note','Status'] },
    ];

    const summary = [];
    sheetsToArchive.forEach(({ name, get, headers }) => {
      const sh = get();
      const last = sh.getLastRow();
      const lastCol = sh.getLastColumn();
      if (last < 2) { summary.push(name + ': 데이터 없음'); return; }

      const allRows = sh.getRange(2, 1, last - 1, lastCol).getValues();
      const toArchive = allRows.filter(r => targetBatchIds.indexOf(String(r[0])) !== -1);
      const toKeep = allRows.filter(r => targetBatchIds.indexOf(String(r[0])) === -1);

      if (toArchive.length > 0) {
        const archiveSh = ensureBatchSheet_(ARCHIVE_PREFIX + name, headers);
        archiveSh.getRange(archiveSh.getLastRow() + 1, 1, toArchive.length, lastCol).setValues(toArchive);
      }

      sh.getRange(2, 1, last - 1, lastCol).clearContent();
      if (toKeep.length > 0) {
        sh.getRange(2, 1, toKeep.length, lastCol).setValues(toKeep);
      }

      summary.push(name + ': ' + toArchive.length + '행 보관 이동, ' + toKeep.length + '행 유지');
      Logger.log(name + ': ' + toArchive.length + '행 보관 이동, ' + toKeep.length + '행 유지');
    });

    Logger.log('✅ 보관 완료 — 배치 ' + targetBatchIds.length + '개 (' + targetBatchIds.join(', ') + ')');
    return { ok: true, archived: targetBatchIds, summary: summary };
  } catch (e) {
    Logger.log('❌ archiveOldBatches 오류: ' + String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

// 트리거는 인자를 못 넘기므로, 기본값(14일)으로 실행하는 래퍼 함수
function archiveOldBatchesDaily() {
  archiveOldBatches(14);
}

function setupArchiveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'archiveOldBatchesDaily') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('archiveOldBatchesDaily')
    .timeBased()
    .atHour(2) // 새벽 2시~3시 사이 자동 실행 (한산한 시간대)
    .everyDays(1)
    .create();
  Logger.log('✅ 트리거 설정 완료 — 매일 새벽 2시경, 완료된 지 14일 지난 배치를 Archive_ 시트로 자동 이동합니다.');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '매일 새벽 완료된 지 14일 지난 배치를 자동으로 보관 시트로 옮깁니다.',
    '✅ 자동 보관 트리거 설정 완료',
    5
  );
}

function removeArchiveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'archiveOldBatchesDaily') {
      ScriptApp.deleteTrigger(t);
    }
  });
  Logger.log('자동 보관 트리거 삭제됨');
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
    // ★ 2026-08-19 신규(긴급) — 작업자 명단은 자주 안 바뀌므로 30초로 여유있게 캐싱.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'batchWorkers_v1';
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

    const sh = bworkersSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: true, workers: [] }; // 비어있으면 클라이언트가 기본값 사용
    const rows = sh.getRange(2, 1, last - 1, 3).getValues();
    const workers = rows
      .filter(r => r[1]) // 이름 없는 빈 행 제외
      .map(r => ({ id: Number(r[0]) || 0, name: String(r[1]), status: r[2] || 'active' }));
    const _result = { ok: true, workers: workers };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 30);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
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
    // ★ 2026-08-19 신규 — getBatchWorkers 캐시를 즉시 무효화(작업자 추가/수정이
    //   30초 캐시 때문에 늦게 반영되는 것 방지)
    try { CacheService.getScriptCache().remove('batchWorkers_v1'); } catch (eCache) {}
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
/* =====================================================================
 * ★★★ 영업 공유 — 오더 검수 상세 조회 + 배송 디멘션 (신규 추가) ★★★
 * 목적: 카톡(이슈 공유)+슬랙(디멘션 공유) 두 채널을 이 페이지 하나로 통합.
 * 이 블록 전체를 BatchPicking.gs 맨 끝에 붙여넣으세요.
 * ===================================================================== */

const DIMENSIONS_SHEET = 'Dimensions';
function dimensionsSheet_() {
  return ensureBatchSheet_(DIMENSIONS_SHEET, ['Invoice','BoxIndex','L','W','H','Weight','EnteredBy','EnteredAt']);
}

/* ---------------------------------------------------------------------
 * buildDimsExistsMap_() — Dimensions 시트를 한 번만 읽어서
 * {invoice: {count, totalWt}} 맵으로 만듦. 여러 인보이스를 한꺼번에
 * 조회할 때(오늘 목록, 시트 미리보기) 인보이스마다 따로 뒤지지 않도록.
 * ------------------------------------------------------------------- */
function buildDimsExistsMap_() {
  const map = {};
  try {
    const sh = dimensionsSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      // ★ 2026-08-06 확장 — H컬럼(EnteredAt, 저장 시각)까지 읽어서 메인 대시보드
      //   (index.html)의 자동보관 규칙이 "디멘션 저장 시각 기준 영업일 2일"을
      //   판단할 수 있게 함. saveDimensions()는 한 인보이스의 모든 팔렛/박스 행에
      //   똑같은 저장 시각(now)을 쓰므로, 아무 행에서나 값을 가져오면 됨(최신값 유지).
      sh.getRange(2, 1, last - 1, 8).getValues().forEach(r => {
        const inv = String(r[0] || '').trim();
        if (!inv) return;
        if (!map[inv]) map[inv] = { count: 0, totalWt: 0, enteredAt: '' };
        map[inv].count++;
        map[inv].totalWt += Number(r[5]) || 0;
        const ea = String(r[7] || '').trim();
        if (ea && (!map[inv].enteredAt || ea > map[inv].enteredAt)) map[inv].enteredAt = ea;
      });
    }
  } catch (e) { /* best-effort */ }

  // ★ 2026-08-06 신규 — 디멘션 합산(대표 인보이스 + 포함 오더).
  //   DimLinks에 "추가오더 → 대표오더"로 묶여 있으면, 추가 오더도 대표의
  //   디멘션 건수/저장시각을 그대로 물려받게 함. 이 함수 하나만 고치면
  //   listJobs(메인 대시보드 자동보관) · getSalesTodayList · getSalesOverview가
  //   전부 같이 적용되므로, 한 그룹이 항상 같은 날 같이 보관 처리됨.
  try {
    const links = buildDimLinksMap_();
    Object.keys(links.childToPrimary).forEach(child => {
      const p = links.childToPrimary[child];
      const pd = map[p];
      if (pd && pd.count > 0) {
        map[child] = { count: pd.count, totalWt: pd.totalWt, enteredAt: pd.enteredAt, linkedTo: p, inherited: true };
      } else if (!map[child]) {
        map[child] = { count: 0, totalWt: 0, enteredAt: '', linkedTo: p, inherited: true };
      }
    });
  } catch (e) { /* best-effort — DimLinks 시트가 아직 없어도 정상 동작 */ }

  return map;
}

/* ---------------------------------------------------------------------
 * getDimensions_(invoice) — 내부 헬퍼. 인보이스 하나의 팔렛/박스 목록 조회.
 * ------------------------------------------------------------------- */
function getDimensions_(invoice) {
  const sh = dimensionsSheet_();
  const last = sh.getLastRow();
  const dims = [];
  let enteredBy = '', enteredAt = '';
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 8).getValues().forEach(r => {
      if (String(r[0]).trim() !== String(invoice).trim()) return;
      dims.push({ idx: Number(r[1]) || 0, l: r[2] || null, w: r[3] || null, h: r[4] || null, wt: Number(r[5]) || 0 });
      if (r[6]) enteredBy = String(r[6]);
      if (r[7]) enteredAt = String(r[7]);
    });
    dims.sort((a, b) => a.idx - b.idx);
  }
  return { dims: dims, enteredBy: enteredBy, enteredAt: enteredAt };
}

/* ---------------------------------------------------------------------
 * saveDimensions(data) — 패킹 작업자가 팔렛/박스 치수+무게 저장.
 * data: { invoice, dims: [{l,w,h,wt}, ...], enteredBy }
 * 기존 이 인보이스의 행을 전부 지우고 새로 씀(전체 교체 방식 — 목록이
 * 짧아서 부분수정보다 통째로 다시 쓰는 게 더 단순하고 버그가 적음).
 * ------------------------------------------------------------------- */
function saveDimensions(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };
    const list = Array.isArray(data.dims) ? data.dims : [];
    const enteredBy = String((data && data.enteredBy) || '').trim();

    // ★ 2026-08-06 신규 — 다른 오더에 디멘션이 포함된(child) 인보이스에는
    //   직접 저장하지 못하게 막음. 안 막으면 대표 쪽과 추가 오더 쪽에 각각
    //   따로 숫자가 생겨서 어느 쪽이 진짜인지 알 수 없게 됨.
    try {
      const linkCheck = buildDimLinksMap_();
      const myPrimary = linkCheck.childToPrimary[invoice];
      if (myPrimary) {
        return { ok: false, error: '이 오더는 ' + myPrimary + ' 에 디멘션이 포함되어 있습니다. 대표 오더에서 수정하거나, 먼저 연결을 해제하세요.', linkedTo: myPrimary };
      }
    } catch (e) { /* DimLinks가 아직 없으면 예전과 동일하게 그냥 저장 */ }

    const sh = dimensionsSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      const rows = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0]).trim() === invoice) sh.deleteRow(i + 2);
      }
    }
    const now = batchNow_();
    const newRows = list
      .filter(d => d && (Number(d.wt) > 0))
      .map((d, idx) => [invoice, idx + 1, d.l || '', d.w || '', d.h || '', Number(d.wt) || 0, enteredBy, now]);
    if (newRows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, newRows.length, 8).setValues(newRows);
    }
    bumpVersion_();
    return { ok: true, count: newRows.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------------
 * autoDeleteOldDimensions() — ★ 2026-08-04 신규
 * 목적: 창고에서 디멘션(치수/무게)을 입력한 날로부터 "2일이 지나면" 자동으로
 * 삭제. 영업팀이 디멘션·이슈를 전부 확인해서 최종 인보이스를 발행하기까지
 * 시간이 필요해서(하루면 놓치는 경우가 생김), 검수완료 오더 자체는 메인
 * 대시보드 기준으로 1일 뒤 삭제되지만 디멘션은 2일 뒤로 더 여유를 둠.
 *
 * 왜 서버(GAS) 트리거 방식인가: 메인 대시보드(index.html)의 자동삭제는
 * 브라우저가 열려있어야만 작동하는 클라이언트 타이머 방식이라, 아무도 그
 * 페이지를 안 열어둔 날엔 삭제가 안 일어날 수 있음. 디멘션은 이보다 더
 * 안정적으로, 브라우저와 무관하게 매일 정확히 실행되는 GAS 자체 시간 기반
 * 트리거로 구현함.
 *
 * 기준: EnteredAt(입력 시각)의 날짜 부분이 "오늘 - 2일" 이하인 행은 삭제.
 *   예) 8/4에 입력 → 8/4, 8/5 동안 남아있고 → 8/6 새벽 1시경 삭제됨(2일 보관).
 *
 * ★ Apps Script 트리거 등록 방법 (직접 한번만 설정하면 매일 자동 실행됨):
 *   1) Apps Script 에디터 왼쪽 시계 아이콘(트리거) 클릭
 *   2) 함수 목록에서 setupDimensionsCleanupTrigger 선택 → ▶ 실행
 *      (한 번만 실행하면 그 뒤로 매일 새벽 1시경 자동 실행됨)
 * ------------------------------------------------------------------- */
function autoDeleteOldDimensions() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    // ★ 2026-08-07 수정 — 예전 2일은 위험했음.
    //   오더 보관(index.html AutoDelete)은 "디멘션이 저장돼 있을 것"을 조건으로 하는데,
    //   디멘션이 먼저 지워지면 그 조건이 영원히 충족되지 않아 TK/UPS 오더가 목록에
    //   계속 쌓이게 됨. 실제로 금요일에 디멘션을 넣으면 일요일에 지워져서
    //   월요일엔 이미 조건 불충족 상태가 됐음.
    //   오더 보관 기준이 영업일 3일(주말·연휴 끼면 달력으로 5~6일)이므로,
    //   디멘션은 그보다 넉넉히 오래 남겨야 함. 8일로 둠.
    const RETENTION_DAYS = 8;
    const tz = batchTz_();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
    const cutoffStr = Utilities.formatDate(cutoffDate, tz, 'yyyy-MM-dd');

    const sh = dimensionsSheet_();
    const last = sh.getLastRow();
    if (last < 2) { Logger.log('Dimensions: 데이터 없음'); return { ok: true, deleted: 0 }; }

    const lastCol = sh.getLastColumn();
    const rows = sh.getRange(2, 1, last - 1, lastCol).getValues();
    const keepRows = [];
    let deletedCount = 0;
    rows.forEach(r => {
      const enteredAtRaw = r[7]; // H열: EnteredAt
      let enteredDateStr = '';
      if (enteredAtRaw instanceof Date && !isNaN(enteredAtRaw)) {
        enteredDateStr = Utilities.formatDate(enteredAtRaw, tz, 'yyyy-MM-dd');
      } else {
        enteredDateStr = String(enteredAtRaw || '').slice(0, 10);
      }
      // 날짜를 못 읽으면(비어있거나 형식이상) 안전하게 보관 쪽으로 처리(삭제 안 함)
      if (enteredDateStr && enteredDateStr <= cutoffStr) {
        deletedCount++;
      } else {
        keepRows.push(r);
      }
    });

    if (deletedCount > 0) {
      sh.getRange(2, 1, last - 1, lastCol).clearContent();
      if (keepRows.length > 0) sh.getRange(2, 1, keepRows.length, lastCol).setValues(keepRows);
      Logger.log('autoDeleteOldDimensions: ' + deletedCount + '건 삭제 (기준일 ' + cutoffStr + ' 이하), ' + keepRows.length + '건 유지');
      // ★ 2026-08-06 신규 — 대표 쪽 디멘션이 사라졌는데 연결 정보만 남는 것 정리
      cleanupOrphanDimLinks_();
    } else {
      Logger.log('autoDeleteOldDimensions: 삭제 대상 없음');
    }
    return { ok: true, deleted: deletedCount };
  } catch (e) {
    Logger.log('autoDeleteOldDimensions 오류: ' + String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

function setupDimensionsCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'autoDeleteOldDimensions') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('autoDeleteOldDimensions')
    .timeBased()
    .atHour(1) // 새벽 1시~2시 사이 자동 실행
    .everyDays(1)
    .create();
  Logger.log('✅ 트리거 설정 완료 — 매일 새벽 1시경, 입력한 지 2일 지난 디멘션을 자동 삭제합니다.');
}

function removeDimensionsCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'autoDeleteOldDimensions') {
      ScriptApp.deleteTrigger(t);
    }
  });
  Logger.log('디멘션 자동삭제 트리거 삭제됨');
}

/* ---------------------------------------------------------------------
 * getSalesInvoiceDetail(invoice) — 영업팀 상세조회 페이지 전용 API.
 * Jobs(검수결과) + BatchCustomers(패킹존이동) + IssueLog(빠진 상품 상세)
 * + Dimensions(치수)를 한 번에 묶어서 반환. 영업팀에게 필요 없는 정보
 * (작업자 실적, 다른 배치 현황 등)는 애초에 응답에 포함하지 않음.
 * ★ 2026-07-28 추가 — pickStart(작업/피킹 시작일) 필드 추가.
 * ------------------------------------------------------------------- */
function getSalesInvoiceDetail(invoice) {
  try {
    invoice = String(invoice || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };

    // ★ 2026-08-19 신규(긴급) — "Too many simultaneous invocations: Spreadsheets"
    //   실제로 발생 확인됨. 이 함수도 여러 시트(Jobs/BatchItems/IssueLog/Dims)를
    //   조합해 계산하는 무거운 함수라, 6초 캐시로 스프레드시트 동시 접근 자체를 줄임.
    const _cache = CacheService.getScriptCache();
    const _cacheKey = 'salesInvDetail_v1_' + invoice;
    const _cached = _cache.get(_cacheKey);
    if (_cached) return JSON.parse(_cached);

    // 1) Jobs 시트에서 기본 정보 + 검수결과
    // ★ 2026-08-03 성능 개선 — 예전엔 인보이스 하나 찾으려고 Jobs 시트 전체
    //   (모든 행 × 모든 컬럼)를 통째로 읽었음. 시트가 계속 커지면서 이게
    //   느려져서 상세조회가 무한 로딩처럼 보이는 원인이 됐음. 이제 인보이스
    //   컬럼 하나만 먼저 좁게 읽어서 행 위치를 찾고, 그 한 행만 읽도록 변경.
    const sh = SHEET_();
    const hm = headerMapCached_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: false, error: 'no jobs data' };
    const invCol = hm['invoice'];
    if (!invCol) return { ok: false, error: 'invoice column not found' };

    const invColVals = sh.getRange(2, invCol, lastRow - 1, 1).getValues();
    let jobRowIndex = -1;
    for (let i = 0; i < invColVals.length; i++) {
      if (String(invColVals[i][0]).trim() === invoice) { jobRowIndex = i + 2; break; }
    }
    if (jobRowIndex < 0) return { ok: false, error: 'Invoice not found: ' + invoice };
    const jobRow = sh.getRange(jobRowIndex, 1, 1, sh.getLastColumn()).getValues()[0];

    function jv(name) { const c = hm[name]; return c ? jobRow[c - 1] : ''; }
    const customer = String(jv('remarks') || '');
    const shipDateRaw = jv('ship date');
    const shipDate = shipDateRaw instanceof Date
      ? Utilities.formatDate(shipDateRaw, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(shipDateRaw || '');
    const method = String(jv('trucking') || '');
    const amount = jv('amount');
    const inspectionRaw = String(jv('inspection') || '').trim();
    const inspector = String(jv('inspector') || '').trim();
    const inspEndRaw = String(jv('insp end') || '');
    // ★ 2026-07-28 신규 — 작업(피킹) 시작일. StartAtISO의 날짜 부분만 추출.
    const startISORaw = jv('startatiso');
    let pickStart = '';
    if (startISORaw instanceof Date && !isNaN(startISORaw)) {
      pickStart = Utilities.formatDate(startISORaw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else {
      const s = String(startISORaw || '').trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) pickStart = s.slice(0, 10);
    }

    // 2) BatchCustomers에서 패킹존 이동 여부 (가장 최근 매치를 사용)
    // ★ 2026-08-03 성능 개선 — 11개 컬럼 전체 대신 인보이스 컬럼만 먼저 좁게 읽음
    const bc = bcustSheetSafe_();
    const bcLast = bc.getLastRow();
    let movedToPacking = false;
    let packStage = 'none'; // ★ 2026-08-24 신규 — none/moved/taken/verified (K/L/M 컬럼을 그대로 신뢰)
    if (bcLast >= 2) {
      const bcInvVals = bc.getRange(2, 2, bcLast - 1, 1).getValues();
      for (let i = bcInvVals.length - 1; i >= 0; i--) {
        if (String(bcInvVals[i][0]).trim() === invoice) {
          // ★ 2026-08-05 수정(매니저 요청) — K컬럼(핑크, "이동 필요" 표시 시각) 대신
          //   L컬럼(TakenOut, 파랑 "이동 완료" 시각)을 기준으로 판단. 검수팀이
          //   핑크로 바꿔도 출고팀이 실제로 가져가기 전까지는 "이동 완료"가 아님.
          movedToPacking = !!bc.getRange(i + 2, 12).getValue();
          const kVal = bc.getRange(i + 2, 11).getValue();
          const mVal = bc.getRange(i + 2, 13).getValue(); // ★ 2026-08-24 신규: PackVerified(주황, 최종 2차 검증완료)
          if (mVal) packStage = 'verified';
          else if (movedToPacking) packStage = 'taken';
          else if (kVal) packStage = 'moved';
          break;
        }
      }
    }

    // ★ 2026-08-06 긴급 수정 — 예전엔 "BatchCustomers 고객사 명단에 이름이
    //   한 번이라도 올라간 적 있는가"로 hasBatchRecord를 판단했음. 그런데
    //   배치를 만들 때 업로드한 고객사 PDF 목록에는 있었지만, 실제로는 총량
    //   피킹으로 스캔되지 않고 나중에 개별로 처리된 오더도 많음(그런 오더는
    //   TV가 절대 관리 못 하는데도 "배치 소속"으로 잘못 분류돼서 수동 버튼을
    //   영원히 볼 수 없었음). 이제 "실제로 이 인보이스에 대한 스캔(pass) 기록이
    //   ScanLog에 있는가"로 기준을 바꿈 — 진짜 총량피킹으로 처리된 것만
    //   TV 전용으로 분류하고, 나머지는 전부 수동 버튼을 볼 수 있게 함.
    let hasBatchRecord = false;
    try {
      const sl = scanlogSheet_();
      const slLast = sl.getLastRow();
      if (slLast >= 2) {
        const slInvCol = sl.getRange(2, 9, slLast - 1, 1).getValues(); // I열: Invoice
        for (let i = 0; i < slInvCol.length; i++) {
          if (String(slInvCol[i][0]).trim() !== invoice) continue;
          const rowFull = sl.getRange(i + 2, 1, 1, 11).getValues()[0]; // Result(J,10), Status(K,11)
          if (rowFull[9] === 'pass' && rowFull[10] !== 'undone') { hasBatchRecord = true; break; }
        }
      }
    } catch (e) { /* best-effort */ }

    // ★ 2026-08-06 신규(매니저 요청) — 디멘션이 저장됐다는 건 물리적으로 이미
    //   패킹존에서 박스를 재고 무게를 달았다는 뜻이므로, 논리적으로 "이동 완료"가
    //   당연히 전제됨. 별도 클릭 없이 디멘션 저장 자체를 이동완료의 증거로 인정함
    //   — "디멘션은 저장됐는데 Moved는 No"인 앞뒤 안 맞는 상태를 원천적으로 방지.
    //   (아래 dimsResult 계산이 이 시점엔 아직 안 끝났으므로, 여기선 우선
    //   BatchCustomers/수동표시만 반영하고 디멘션 반영은 함수 맨 끝에서 한 번 더 함)

    // ★ 2026-08-06 신규 — 단독 오더(=실제 스캔 기록 없는 오더)는 위에서 절대
    //   true가 될 수 없으므로, Jobs 시트의 수동 표시(PackingMovedManual)를
    //   OR로 합침.
    let manualMovedAt = '', manualMovedBy = '';
    try {
      const hmManual = headerMapCached_();
      const iManualFlag = hmManual[normalizeHeaderName_('PackingMovedManual')];
      const iManualBy = hmManual[normalizeHeaderName_('PackingMovedManualBy')];
      if (iManualFlag) {
        const v = jobRow[iManualFlag - 1];
        if (v) { movedToPacking = true; manualMovedAt = String(v); packStage = 'taken'; } // ★ 2026-08-24: 수동표시도 taken으로 취급(총량피킹 배치가 없는 단독오더라 검증스캔 대상 자체가 아님)
      }
      if (iManualBy) manualMovedBy = String(jobRow[iManualBy - 1] || '');
    } catch (e) { /* best-effort */ }

    // 3) IssueLog에서 이 인보이스의 활성 이슈 상세 (SKU/상품명/바코드/사유/수량)
    // ★ 2026-08-03 성능 개선 — 13개 컬럼 전체를 모든 행에서 읽던 것을, 인보이스
    //   컬럼(H, 8번째)만 먼저 좁게 스캔해서 매칭 행 위치를 찾고, 그 몇 안 되는
    //   매칭 행만 전체 컬럼으로 읽도록 변경 (보통 한 인보이스당 이슈는 몇 건 안 됨).
    const il = issuelogSheet_();
    const ilLast = il.getLastRow();
    const items = [];
    if (ilLast >= 2) {
      const ilInvVals = il.getRange(2, 8, ilLast - 1, 1).getValues();
      for (let i = 0; i < ilInvVals.length; i++) {
        if (String(ilInvVals[i][0]).trim() !== invoice) continue;
        const r = il.getRange(i + 2, 1, 1, 13).getValues()[0];
        if (r[12] === 'undone') continue;
        items.push({
          sku: r[5] || '', name: r[6] || '', barcode: r[4] || '',
          reason: r[9] || '', qty: Number(r[10]) || 0, note: r[11] || ''
        });
      }
    }
    // ★ 2026-07-28 신규 — IssueLog에서 못 찾았는데 검수결과는 "⚠ ISSUES"인 경우
    //   (archiveOldBatches로 오래된 배치의 IssueLog가 Archive_IssueLog로 옮겨진
    //   경우 등) — Jobs 시트 검수결과 셀에 남아있는 메모(saveInspection이 검수
    //   시점에 한 번 적어둔 것, 절대 안 지워짐)를 대신 파싱해서 최소한의 상세
    //   (사유/바코드/수량)라도 보여줌. SKU/상품명은 BatchItems에서 바코드로
    //   역으로 찾아봄(없으면 바코드만 표시).
    if (items.length === 0 && inspectionRaw.indexOf('ISSUES') >= 0 && jobRowIndex > 0) {
      try {
        const noteCol = hm['inspection'];
        const noteText = noteCol ? sh.getRange(jobRowIndex, noteCol).getNote() : '';
        if (noteText) {
          const lineRe = /^([A-Za-z]+):\s*Barcode\s+(\S+)\s+x\s+(\d+)\s*pcs/;
          noteText.split('\n').forEach(line => {
            const m = line.trim().match(lineRe);
            if (!m) return;
            const reason = m[1].toUpperCase();
            const barcode = m[2];
            const qty = Number(m[3]) || 0;
            items.push({ sku: '', name: '', barcode: barcode, reason: reason, qty: qty, note: '(reconstructed from the saved inspection note — this order was inspected via the manual screen, not total-picking)' });
          });
          // 바코드로 SKU/상품명 역추적. TV 현황판(board.html)도 결국 같은
          // BatchItems 원본을 보고 정확히 표시하므로, 이 인보이스 한정으로
          // 좁혀서 못 찾는 경우가 있어(다른 고객사 행에만 이름이 채워져
          // 있거나 하는 경우) 바코드 하나로 시트 전체에서 매칭하도록 넓힘.
          if (items.length) {
            const nameByBarcode = {};
            function scanForNames_(sh) {
              if (!sh) return;
              const last = sh.getLastRow();
              if (last < 2) return;
              sh.getRange(2, 1, last - 1, 7).getValues().forEach(r => {
                const bc = String(r[4] || '').trim();
                if (!bc) return;
                const existing = nameByBarcode[bc];
                const name = String(r[3] || '').trim();
                if (!existing || (!existing.name && name)) {
                  nameByBarcode[bc] = { sku: r[2], name: r[3] };
                }
              });
            }
            scanForNames_(bitemsSheet_());
            // ★ 2026-07-28 신규 — 라이브 시트에서 못 찾으면, archiveOldBatches로
            //   옮겨진 보관 시트(Archive_BatchItems)까지 같이 찾아봄. 이 이슈가
            //   붙은 오더의 원본 배치가 이미 정리(보관)됐을 경우를 대비.
            const stillMissing = items.some(it => !nameByBarcode[String(it.barcode).trim()]);
            if (stillMissing) {
              try {
                const archiveSh = ss_().getSheetByName(ARCHIVE_PREFIX + BITEMS_SHEET);
                scanForNames_(archiveSh);
              } catch (e) { /* 보관 시트가 없거나 읽기 실패해도 나머지 응답은 진행 */ }
            }
            items.forEach(it => {
              const found = nameByBarcode[String(it.barcode).trim()];
              if (found && (found.sku || found.name)) { it.sku = found.sku || it.barcode; it.name = found.name || '(no product name on file)'; }
              else { it.sku = it.barcode; it.name = '(product name not available — this issue was recorded through the manual inspection screen, before item detail tracking existed)'; }
            });
          }
        }
      } catch (e) { /* best-effort — 못 읽어도 나머지 응답은 그대로 진행 */ }
    }

    // 4) 디멘션
    // ★ 2026-08-06 신규 — 디멘션 합산. 이 오더가 다른 오더에 "포함"되어 있으면
    //   자기 디멘션이 아니라 대표 오더의 디멘션을 대신 보여줌(읽기 전용).
    const dimGroup = getDimGroupDetail_(invoice);
    const dimsOwner = dimGroup.dimsLinkedTo || invoice;
    const dimsResult = getDimensions_(dimsOwner);

    // ★ 2026-08-06 신규(매니저 요청) — "디멘션이 저장됐는데 Moved는 No"인
    //   앞뒤 안 맞는 상태를 원천 차단. 디멘션(치수/무게)이 하나라도 저장돼
    //   있다면, 물리적으로 이미 패킹존에서 측정된 것이므로 이동완료로 간주.
    if (dimsResult.dims.length > 0) { movedToPacking = true; packStage = 'taken'; }

    const _result = {
      ok: true,
      invoice: invoice,
      customer: customer,
      shipDate: shipDate,
      pickStart: pickStart,
      method: method,
      amount: amount,
      inspectionRaw: inspectionRaw,
      inspector: inspector,
      inspEnd: inspEndRaw,
      movedToPacking: movedToPacking,
      packStage: packStage, // ★ 2026-08-24 신규 — none/moved/taken/verified
      hasBatchRecord: hasBatchRecord, // ★ 2026-08-06 신규 — false면 단독 오더(수동 버튼 노출 대상)
      manualMovedAt: manualMovedAt,
      manualMovedBy: manualMovedBy,
      items: items,
      dims: dimsResult.dims,
      dimsBy: dimsResult.enteredBy,
      dimsAt: dimsResult.enteredAt,
      dimsCount: dimsResult.dims.length,
      // ★ 2026-08-06 신규 — 디멘션 합산 관련 필드
      dimsOwner: dimsOwner,                                 // 실제로 디멘션이 저장된 인보이스(자기 자신이거나 대표)
      dimsLinkedTo: dimGroup.dimsLinkedTo,                  // 내가 포함된 대표 인보이스('' 이면 단독/대표)
      dimsLinkedToCustomer: '',                             // 화면이 getDimCandidates로 따로 채움
      dimsChildren: dimGroup.dimsChildren,                  // 내 디멘션에 포함된 추가 오더 목록
      dimsJoinTargets: null,                                // null = 아직 안 불러옴(화면이 비동기로 채움)
      dimsAddCandidates: null
    };
    try {
      const _payload = JSON.stringify(_result);
      if (_payload.length < 95000) CacheService.getScriptCache().put(_cacheKey, _payload, 6);
    } catch (eCache) { /* 캐시 저장 실패해도 정상 응답은 그대로 나감 */ }
    return _result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* =====================================================================
 * ★★★ 2026-08-06 신규 — 디멘션 합산(대표 인보이스 + 포함 오더) ★★★
 *
 * [왜 필요한가]
 * 같은 고객사가 하루에 오더를 나눠서 내는 경우(원 오더 + 추가 오더)가 잦은데,
 * 실제 출고는 팔렛/박스에 같이 실려 나감. 그런데 예전 구조는 Dimensions 시트가
 * "인보이스 1개 = 디멘션 1세트"로만 묶여 있어서, 작업자가 같은 팔렛 정보를
 * 인보이스마다 중복 입력하거나 한쪽만 입력하고 빠뜨리는 문제가 있었음.
 *
 * [해결 방식]
 * Dimensions 시트는 그대로 두고(기존 로직 영향 0), DimLinks 시트를 새로 만들어
 * "추가 오더 → 대표 오더" 관계만 저장함. 디멘션 실물 데이터는 항상 대표
 * 인보이스 한 곳에만 저장되고, 추가 오더는 조회 시점에 대표 것을 물려받음.
 *
 * [중요 — 자동보관 규칙과의 연결]
 * buildDimsExistsMap_()에 상속 로직을 넣었기 때문에, listJobs(메인 대시보드
 * 자동보관), getSalesTodayList, getSalesOverview 전부 자동으로 같이 적용됨.
 * 즉 추가 오더도 대표 오더의 "디멘션 저장 시각"을 그대로 물려받아서, 한 그룹이
 * 같은 날 같이 보관 처리됨(한쪽만 남거나 한쪽만 사라지는 사고 방지).
 * ===================================================================== */

const DIMLINKS_SHEET = 'DimLinks';
function dimLinksSheet_() {
  return ensureBatchSheet_(DIMLINKS_SHEET, ['Invoice', 'PrimaryInvoice', 'LinkedBy', 'LinkedAt']);
}

/* ---------------------------------------------------------------------
 * dimMethodKey_(method) — 배송방법 정규화.
 * 매니저 확인 사항: "배송방법이 다른 오더끼리는 묶을 수 없음".
 * TRUCKING과 TK는 같은 것(팔렛)이므로 하나로 취급.
 * ------------------------------------------------------------------- */
function dimMethodKey_(method) {
  const m = String(method || '').trim().toUpperCase();
  if (m === 'TRUCKING' || m === 'TK') return 'TK';
  return m;
}

/* ---------------------------------------------------------------------
 * dimCustomerKey_(name) — 고객사명 비교용 정규화(대소문자/공백/쉼표·마침표 무시).
 * "Blooming Cosmetics"와 "BLOOMING COSMETICS,"를 같은 곳으로 보기 위함.
 * ------------------------------------------------------------------- */
function dimCustomerKey_(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* ---------------------------------------------------------------------
 * buildDimLinksMap_() — DimLinks 시트를 한 번 읽어서 양방향 맵으로.
 * childToPrimary: { 추가오더: 대표오더 }
 * primaryToChildren: { 대표오더: [추가오더, ...] }
 * ------------------------------------------------------------------- */
function buildDimLinksMap_() {
  const childToPrimary = {};
  const primaryToChildren = {};
  try {
    const sh = dimLinksSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 4).getValues().forEach(r => {
        const child = String(r[0] || '').trim();
        const primary = String(r[1] || '').trim();
        if (!child || !primary || child === primary) return;
        childToPrimary[child] = primary;
        if (!primaryToChildren[primary]) primaryToChildren[primary] = [];
        if (primaryToChildren[primary].indexOf(child) < 0) primaryToChildren[primary].push(child);
      });
    }
  } catch (e) { /* best-effort */ }
  return { childToPrimary: childToPrimary, primaryToChildren: primaryToChildren };
}

/* ---------------------------------------------------------------------
 * resolveDimPrimary_(invoice, links) — 이 인보이스가 속한 그룹의 대표를 반환.
 * 단독이면 자기 자신. 2단 체인은 애초에 만들지 않지만, 혹시 생겨도
 * 무한루프 없이 끝까지 따라가도록 최대 5단계까지만 추적.
 * ------------------------------------------------------------------- */
function resolveDimPrimary_(invoice, links) {
  let cur = String(invoice || '').trim();
  for (let i = 0; i < 5; i++) {
    const next = links.childToPrimary[cur];
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

/* ---------------------------------------------------------------------
 * dimJobsSnapshot_() — Jobs 시트에서 후보 추천에 필요한 최소 필드만 읽음.
 * 인보이스 상세조회를 열 때마다 매번 전체를 다시 읽으면 느려지므로 60초 캐시.
 * ------------------------------------------------------------------- */
function dimJobsSnapshot_() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get('dimJobsSnapshot_v2');
    if (cached) { try { return JSON.parse(cached); } catch (e) { /* 파싱 실패 시 새로 조회 */ } }
  } catch (e) { /* 캐시 없어도 계속 진행 */ }

  const out = [];
  try {
    const sh = SHEET_();
    const hdr = headerMapCached_();
    const norm = normalizeHeaderName_;
    const last = sh.getLastRow();
    if (last < 2) return out;
    const n = last - 1;
    const col = c => (c ? sh.getRange(2, c, n, 1).getValues() : null);

    const inv   = col(hdr[norm('Invoice')]);
    if (!inv) return out;
    const rem   = col(hdr[norm('Remarks')]);
    const ship  = col(hdr[norm('Ship Date')]);
    const truck = col(hdr[norm('Trucking')]);
    const insp  = col(hdr[norm('Inspection')]);
    const end   = col(hdr[norm('Insp. End')]);
    const arch  = col(hdr[norm('archived')]);
    const tz = Session.getScriptTimeZone();

    for (let i = 0; i < n; i++) {
      const invoice = String(inv[i][0] || '').trim();
      if (!invoice) continue;
      let archived = false;
      if (arch) {
        const a = String(arch[i][0] || '').trim().toLowerCase();
        archived = (a === 'true' || a === '1' || a === 'y' || a === 'yes');
      }
      const sRaw = ship ? ship[i][0] : '';
      const shipDate = (sRaw instanceof Date && !isNaN(sRaw))
        ? Utilities.formatDate(sRaw, tz, 'yyyy-MM-dd')
        : String(sRaw || '').trim().slice(0, 10);
      let inspDate = '';
      const eRaw = end ? end[i][0] : '';
      if (eRaw instanceof Date && !isNaN(eRaw)) {
        inspDate = Utilities.formatDate(eRaw, tz, 'yyyy-MM-dd');
      } else {
        const m = String(eRaw || '').match(/\d{4}-\d{2}-\d{2}/);
        if (m) inspDate = m[0];
      }
      // ★ 2026-08-06 성능 수정 — 예전엔 Jobs 시트의 모든 행(보관된 오래된 건 포함)을
      //   전부 담았음. 그 결과 배열이 수천 건으로 커지고, CacheService 1건당 100KB
      //   제한을 넘겨 캐시 저장이 조용히 실패해서, 상세조회를 열 때마다 시트 전체를
      //   처음부터 다시 읽는 상태가 됐음 → 25초 타임아웃의 직접 원인.
      //   후보는 "아직 살아있는(보관 안 된) 디멘션 필요 오더"만 대상이므로 미리 거름.
      if (archived) continue;
      const methodKey = dimMethodKey_(truck ? truck[i][0] : '');
      if (!methodKey || methodKey === 'PU') continue;
      out.push({
        invoice: invoice,
        customer: String(rem ? rem[i][0] : '').trim(),
        shipDate: shipDate,
        inspDate: inspDate,
        method: methodKey,
        archived: false,
        inspected: !!String(insp ? insp[i][0] : '').trim()
      });
    }
  } catch (e) { /* best-effort */ }

  // 캐시는 1건당 100KB 제한이 있어서, 넘칠 것 같으면 저장을 시도하지 않음
  try {
    const payload = JSON.stringify(out);
    if (payload.length < 90000) CacheService.getScriptCache().put('dimJobsSnapshot_v2', payload, 120);
  } catch (e) { /* 무시 */ }
  return out;
}

/* ---------------------------------------------------------------------
 * findDimCandidates_(me, snapshot, dimsMap, links)
 *
 * 매니저 확인 사항 반영:
 *  - 추천 기준 = 같은 고객사 + (같은 검수일 또는 같은 출고일)
 *  - 둘 다 일치하면 최우선(score 2), 하나만 일치하면 그 다음(score 1)
 *  - 배송방법이 다르면 아예 후보에서 제외
 *
 * 반환:
 *  joinTargets   — "내가 저쪽에 들어갈 수 있는" 후보 (내가 디멘션 없을 때)
 *  addCandidates — "저쪽을 내 디멘션에 넣을 수 있는" 후보 (내가 대표일 때)
 * ------------------------------------------------------------------- */
function findDimCandidates_(me, snapshot, dimsMap, links) {
  const joinTargets = [];
  const addCandidates = [];
  if (!me || !me.invoice) return { joinTargets: joinTargets, addCandidates: addCandidates };

  const myKey = dimCustomerKey_(me.customer);
  const myMethod = dimMethodKey_(me.method);
  if (!myKey || !myMethod || myMethod === 'PU') return { joinTargets: joinTargets, addCandidates: addCandidates };

  const myOwnDims = ((dimsMap[me.invoice] || {}).inherited ? 0 : ((dimsMap[me.invoice] || {}).count || 0));
  const iAmChild = !!links.childToPrimary[me.invoice];

  snapshot.forEach(o => {
    if (o.invoice === me.invoice) return;
    if (o.archived) return;
    if (dimCustomerKey_(o.customer) !== myKey) return;
    if (dimMethodKey_(o.method) !== myMethod) return;

    const sameShip = !!(me.shipDate && o.shipDate && me.shipDate === o.shipDate);
    const sameInsp = !!(me.inspDate && o.inspDate && me.inspDate === o.inspDate);
    if (!sameShip && !sameInsp) return;

    const score = (sameShip ? 1 : 0) + (sameInsp ? 1 : 0);
    const theirPrimary = resolveDimPrimary_(o.invoice, links);
    const theirGroupDims = (dimsMap[theirPrimary] || {}).count || 0;
    const theirOwnDims = ((dimsMap[o.invoice] || {}).inherited ? 0 : ((dimsMap[o.invoice] || {}).count || 0));

    const base = {
      invoice: o.invoice, customer: o.customer, shipDate: o.shipDate, inspDate: o.inspDate,
      method: o.method, sameShip: sameShip, sameInsp: sameInsp, score: score,
      dimsCount: theirOwnDims, groupPrimary: theirPrimary,
      isChild: theirPrimary !== o.invoice, groupDimsCount: theirGroupDims
    };

    // 내가 아직 어디에도 안 묶였고 내 디멘션도 없을 때 → 저쪽에 들어갈 수 있음
    if (!iAmChild && myOwnDims === 0) joinTargets.push(base);

    // 내가 대표(내 디멘션이 있음)일 때 → 저쪽이 단독이고 디멘션이 없어야 넣을 수 있음
    if (!iAmChild && myOwnDims > 0 && !base.isChild && theirGroupDims === 0) addCandidates.push(base);
  });

  const sorter = (a, b) => (b.score - a.score) || String(a.invoice).localeCompare(String(b.invoice));
  joinTargets.sort((a, b) => (b.groupDimsCount > 0 ? 1 : 0) - (a.groupDimsCount > 0 ? 1 : 0) || sorter(a, b));
  addCandidates.sort(sorter);
  return { joinTargets: joinTargets.slice(0, 8), addCandidates: addCandidates.slice(0, 8) };
}

/* ---------------------------------------------------------------------
 * linkDimensions(data) — 두 오더를 하나의 디멘션 그룹으로 묶음.
 * data: { invoice, target, by }
 *
 * 대표(primary) 결정 규칙 — 매니저 확인 사항 반영:
 *  1) 한쪽에만 디멘션이 있으면 → 디멘션이 있는 쪽이 대표
 *  2) 양쪽 다 없으면 → 먼저 나온(인보이스 번호가 빠른) 쪽이 자동으로 대표
 *  3) 양쪽 다 디멘션이 있으면 → 거부(어느 쪽을 버릴지 시스템이 판단하면 안 됨)
 * 대표를 바꾸고 싶으면 setDimPrimary()를 쓰면 됨.
 * ------------------------------------------------------------------- */
function linkDimensions(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    const targetRaw = String((data && data.target) || '').trim();
    const by = String((data && data.by) || 'Packing').trim();
    if (!invoice || !targetRaw) return { ok: false, error: 'invoice and target are required' };
    if (invoice === targetRaw) return { ok: false, error: '같은 인보이스끼리는 묶을 수 없습니다.' };

    const snapshot = dimJobsSnapshot_();
    const byInv = {};
    snapshot.forEach(o => { byInv[o.invoice] = o; });
    const a = byInv[invoice];
    const b = byInv[targetRaw];
    if (!a) return { ok: false, error: '오더를 찾을 수 없습니다: ' + invoice };
    if (!b) return { ok: false, error: '오더를 찾을 수 없습니다: ' + targetRaw };

    // 배송방법이 다르면 거부 (팔렛과 박스는 단위가 달라 합산이 성립하지 않음)
    if (dimMethodKey_(a.method) !== dimMethodKey_(b.method)) {
      return { ok: false, error: '배송방법이 다릅니다 (' + a.method + ' vs ' + b.method + '). 같은 방법끼리만 묶을 수 있습니다.' };
    }
    if (dimMethodKey_(a.method) === 'PU') {
      return { ok: false, error: 'Pick Up(PU) 오더는 디멘션이 필요 없어 묶을 수 없습니다.' };
    }

    const links = buildDimLinksMap_();
    const dimsMap = buildDimsExistsMap_();

    const targetPrimary = resolveDimPrimary_(targetRaw, links);
    const myPrimary = resolveDimPrimary_(invoice, links);
    if (targetPrimary === myPrimary) return { ok: false, error: '이미 같은 그룹으로 묶여 있습니다.' };

    const ownDims = (inv) => {
      const d = dimsMap[inv] || {};
      return d.inherited ? 0 : (d.count || 0);
    };
    const myDims = ownDims(myPrimary);
    const targetDims = ownDims(targetPrimary);

    if (myDims > 0 && targetDims > 0) {
      return { ok: false, error: '양쪽 모두 디멘션이 입력되어 있습니다. 남길 쪽을 정하고 다른 쪽 디멘션을 먼저 삭제해 주세요.' };
    }

    let primary, child;
    if (targetDims > 0) { primary = targetPrimary; child = myPrimary; }
    else if (myDims > 0) { primary = myPrimary; child = targetPrimary; }
    else {
      // 둘 다 디멘션 없음 → 먼저 나온(번호가 빠른) 인보이스를 대표로
      const pair = [myPrimary, targetPrimary].sort((x, y) => String(x).localeCompare(String(y)));
      primary = pair[0]; child = pair[1];
    }

    // child 쪽에 딸린 기존 포함오더들도 통째로 새 대표에게 넘김
    const moving = [child].concat(links.primaryToChildren[child] || []);
    const sh = dimLinksSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      const rows = sh.getRange(2, 1, last - 1, 2).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        const c = String(rows[i][0] || '').trim();
        if (moving.indexOf(c) >= 0) sh.deleteRow(i + 2);
      }
    }
    const now = batchNow_();
    const newRows = moving.map(c => [c, primary, by, now]);
    if (newRows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, newRows.length, 4).setValues(newRows);
    }
    bumpVersion_();
    try { CacheService.getScriptCache().remove('salesToday_cache_v1'); } catch (e) { /* 무시 */ }
    return { ok: true, primary: primary, linked: moving };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------------
 * unlinkDimensions(data) — 포함되어 있던 추가 오더를 다시 단독으로 되돌림.
 * 매니저 요청: "고객이 마음이 바뀌어서 별도로 보내달라는 경우가 있다."
 * data: { invoice, by }
 * 디멘션 실물은 대표 쪽에 그대로 남고, 이 오더만 그룹에서 빠짐
 * (= 디멘션 미입력 상태로 돌아감).
 * ------------------------------------------------------------------- */
function unlinkDimensions(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };
    const sh = dimLinksSheet_();
    const last = sh.getLastRow();
    let removed = 0;
    if (last >= 2) {
      const rows = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][0] || '').trim() === invoice) { sh.deleteRow(i + 2); removed++; }
      }
    }
    if (!removed) return { ok: false, error: '이 오더는 어디에도 포함되어 있지 않습니다.' };
    bumpVersion_();
    try { CacheService.getScriptCache().remove('salesToday_cache_v1'); } catch (e) { /* 무시 */ }
    return { ok: true, removed: removed };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------------
 * setDimPrimary(data) — 그룹의 대표 인보이스를 바꿈.
 * 매니저 요청: "먼저 나온 인보이스 자동 지정이고, 그 다음에 작업자가
 * 선택할 수 있는 기능도 있으면 좋겠다."
 * data: { invoice, by }  ← invoice가 새 대표가 됨
 * 디멘션 실물 행(Dimensions 시트)의 Invoice 값을 새 대표로 옮기고,
 * DimLinks를 새 대표 기준으로 다시 씀. 그룹 구성원은 그대로 유지됨.
 * ------------------------------------------------------------------- */
function setDimPrimary(data) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const invoice = String((data && data.invoice) || '').trim();
    const by = String((data && data.by) || 'Packing').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };

    const links = buildDimLinksMap_();
    const oldPrimary = resolveDimPrimary_(invoice, links);
    if (oldPrimary === invoice) return { ok: false, error: '이미 대표 인보이스입니다.' };

    const members = [oldPrimary].concat(links.primaryToChildren[oldPrimary] || []);
    if (members.indexOf(invoice) < 0) return { ok: false, error: '같은 그룹이 아닙니다.' };

    // 1) 디멘션 실물 행을 새 대표 이름으로 옮김
    const dsh = dimensionsSheet_();
    const dLast = dsh.getLastRow();
    if (dLast >= 2) {
      const invCol = dsh.getRange(2, 1, dLast - 1, 1).getValues();
      for (let i = 0; i < invCol.length; i++) {
        if (String(invCol[i][0] || '').trim() === oldPrimary) dsh.getRange(i + 2, 1).setValue(invoice);
      }
    }

    // 2) DimLinks를 새 대표 기준으로 다시 씀
    const sh = dimLinksSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      const rows = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (members.indexOf(String(rows[i][0] || '').trim()) >= 0) sh.deleteRow(i + 2);
      }
    }
    const now = batchNow_();
    const newRows = members.filter(m => m !== invoice).map(m => [m, invoice, by, now]);
    if (newRows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, newRows.length, 4).setValues(newRows);
    }
    bumpVersion_();
    try { CacheService.getScriptCache().remove('salesToday_cache_v1'); } catch (e) { /* 무시 */ }
    return { ok: true, primary: invoice, members: members };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------------
 * cleanupOrphanDimLinks_() — 대표 쪽 디멘션이 자동삭제(2일 경과)로 사라졌는데
 * 연결 정보만 남는 경우를 정리. autoDeleteOldDimensions() 끝에서 호출됨.
 * ------------------------------------------------------------------- */
function cleanupOrphanDimLinks_() {
  try {
    const sh = dimLinksSheet_();
    const last = sh.getLastRow();
    if (last < 2) return 0;
    const alive = {};
    const dsh = dimensionsSheet_();
    const dLast = dsh.getLastRow();
    if (dLast >= 2) {
      dsh.getRange(2, 1, dLast - 1, 1).getValues().forEach(r => {
        const v = String(r[0] || '').trim();
        if (v) alive[v] = true;
      });
    }
    const rows = sh.getRange(2, 1, last - 1, 2).getValues();
    let removed = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const primary = String(rows[i][1] || '').trim();
      if (!alive[primary]) { sh.deleteRow(i + 2); removed++; }
    }
    if (removed) Logger.log('cleanupOrphanDimLinks_: ' + removed + '건 정리됨');
    return removed;
  } catch (e) {
    Logger.log('cleanupOrphanDimLinks_ 오류: ' + String(e && e.message || e));
    return 0;
  }
}

/* ---------------------------------------------------------------------
 * getDimGroupDetail_(invoice) — ★ 2026-08-06 성능 재설계
 * 상세조회(getSalesInvoiceDetail)는 작업자가 매번 기다리는 화면이므로,
 * 여기서는 DimLinks 시트(아주 작음)만 읽어서 "묶여 있는가"만 즉시 판단함.
 * 후보 추천처럼 무거운 계산은 getDimCandidates()로 분리해서, 카드가 먼저
 * 뜬 다음에 화면이 따로 불러오게 함 (작업자 체감 대기시간 없음).
 * ------------------------------------------------------------------- */
function getDimGroupDetail_(invoice) {
  try {
    const links = buildDimLinksMap_();
    return {
      dimsLinkedTo: links.childToPrimary[invoice] || '',
      dimsChildren: (links.primaryToChildren[invoice] || []).map(c => ({ invoice: c, customer: '' }))
    };
  } catch (e) {
    return { dimsLinkedTo: '', dimsChildren: [] };
  }
}

/* ---------------------------------------------------------------------
 * getDimCandidates(invoice) — 화면이 카드를 띄운 뒤에 따로 호출하는 API.
 * 같은 고객사 + (같은 검수일 또는 같은 출고일) 오더를 찾아 추천 목록으로 반환.
 * 조금 느려도 화면이 멈추지 않음(그 영역만 "확인 중"으로 표시됨).
 * ------------------------------------------------------------------- */
function getDimCandidates(invoice) {
  try {
    invoice = String(invoice || '').trim();
    if (!invoice) return { ok: false, error: 'invoice required' };

    const links = buildDimLinksMap_();
    const snapshot = dimJobsSnapshot_();
    const byInv = {};
    snapshot.forEach(o => { byInv[o.invoice] = o; });

    const primary = links.childToPrimary[invoice] || '';
    const children = (links.primaryToChildren[invoice] || []).map(c => ({
      invoice: c,
      customer: (byInv[c] || {}).customer || '',
      shipDate: (byInv[c] || {}).shipDate || ''
    }));
    // ★ 2026-08-06 추가(매니저 요청) — 같은 팔렛에 실린 오더 전체 명단.
    //   추가 오더를 열었을 때도 대표가 누구인지, 함께 묶인 다른 오더가 무엇인지
    //   한 화면에서 다 보이게 하기 위함(대표 오더로 이동하지 않아도 됨).
    const groupPrimary = resolveDimPrimary_(invoice, links);
    const memberInvs = [groupPrimary].concat(links.primaryToChildren[groupPrimary] || []);
    const dimsGroupMembers = memberInvs.map(m => ({
      invoice: m,
      customer: (byInv[m] || {}).customer || '',
      shipDate: (byInv[m] || {}).shipDate || '',
      isPrimary: m === groupPrimary
    }));

    const base = {
      ok: true, invoice: invoice,
      dimsLinkedTo: primary,
      dimsLinkedToCustomer: primary ? ((byInv[primary] || {}).customer || '') : '',
      dimsChildren: children,
      dimsGroupPrimary: groupPrimary,
      dimsGroupMembers: dimsGroupMembers,
      dimsJoinTargets: [], dimsAddCandidates: []
    };

    const me = byInv[invoice];
    if (!me || primary) return base; // PU/보관됨이거나 이미 묶여 있으면 후보 계산 불필요

    const dimsMap = buildDimsExistsMap_();
    const cand = findDimCandidates_(me, snapshot, dimsMap, links);
    base.dimsJoinTargets = cand.joinTargets;
    base.dimsAddCandidates = cand.addCandidates;
    return base;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ---------------------------------------------------------------------
 * getOrdersByItem(q) — ★ 2026-08-06 신규(매니저 요청)
 * 바코드 또는 SKU로 "그 상품이 들어있는 오더"를 찾아줌.
 * BatchItems 시트(BatchId·Invoice·SKU·Name·Barcode·ReqQty·Rack)에서
 * Invoice~Barcode 4개 컬럼만 좁게 읽어서 매칭. 바코드는 normBarcode_로
 * 정규화해서 비교하므로 앞자리 0이 있고 없고에 관계없이 찾아짐.
 *
 * [한계 — 매니저 안내 필요]
 * 총량피킹 배치로 처리된 오더만 BatchItems에 상품 목록이 남습니다.
 * 단독(개별) 검수만 거친 오더는 상품 단위 기록이 없어서 이 검색에
 * 잡히지 않습니다(인보이스·고객사명 검색은 그대로 됩니다).
 * ------------------------------------------------------------------- */
function getOrdersByItem(q) {
  try {
    q = String(q || '').trim();
    if (!q) return { ok: false, error: 'query required' };
    const qUp = q.toUpperCase();
    let qBar = qUp;
    try { qBar = normBarcode_(q); } catch (e) { /* 정규화 실패 시 원문 비교 */ }

    const sh = bitemsSheet_();
    const last = sh.getLastRow();
    const found = {};
    let count = 0;
    if (last >= 2) {
      const vals = sh.getRange(2, 2, last - 1, 4).getValues(); // B~E: Invoice, SKU, Name, Barcode
      for (let i = 0; i < vals.length; i++) {
        const inv = String(vals[i][0] || '').trim();
        if (!inv || found[inv]) continue;
        const sku = String(vals[i][1] || '').trim();
        const name = String(vals[i][2] || '').trim();
        const bar = String(vals[i][3] || '').trim();
        let barNorm = bar.toUpperCase();
        try { barNorm = normBarcode_(bar); } catch (e) { /* 원문 비교로 대체 */ }
        const hit = (bar && (barNorm === qBar || bar.toUpperCase().indexOf(qUp) >= 0)) ||
                    (sku && sku.toUpperCase().indexOf(qUp) >= 0);
        if (!hit) continue;
        found[inv] = { invoice: inv, sku: sku, name: name, barcode: bar };
        count++;
        if (count >= 40) break;
      }
    }
    return { ok: true, query: q, orders: Object.keys(found).map(k => found[k]) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ---------------------------------------------------------------------
 * parseBatchTs_(raw) — ★ 2026-08-06 신규
 * 시트에서 읽은 시각 값을 밀리초로 바꿔줌. 구글시트는 같은 컬럼이라도
 * 상황에 따라 Date 객체를 주기도 하고 문자열을 주기도 하기 때문에
 * 양쪽을 모두 처리해야 함. (이걸 안 해서 1시간 유예가 통째로 고장났었음)
 * ------------------------------------------------------------------- */
function parseBatchTs_(raw) {
  if (!raw) return NaN;
  // 1) 이미 Date 객체인 경우 — 가장 흔함(시트가 날짜로 자동 변환해서 저장)
  if (Object.prototype.toString.call(raw) === '[object Date]') {
    return isNaN(raw.getTime()) ? NaN : raw.getTime();
  }
  const str = String(raw).trim();
  if (!str) return NaN;
  // 2) 'yyyy-MM-dd HH:mm:ss' 형태 — 가운데 공백만 T로 바꿔 ISO로 해석
  let m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)/);
  if (m) {
    const t = new Date(m[1] + 'T' + m[2]).getTime();
    if (!isNaN(t)) return t;
  }
  // 3) 그 밖의 형태는 브라우저/GAS 기본 해석에 맡김
  const t2 = new Date(str).getTime();
  return isNaN(t2) ? NaN : t2;
}

/* =====================================================================
 * ★★★ 2026-08-06 신규 — 총량피킹 → Jobs 상태 자동 반영 ★★★
 *
 * [왜 필요한가]
 * 총량피킹은 "그날 나온 오더 전부를 전 인원이 한꺼번에 집는" 방식이라,
 * 고객사별로 누가 작업했는지가 존재하지 않음. 그런데 메인 대시보드는
 * "오더 1건 = 작업자 1명 + Start/Complete 버튼"을 전제로 만들어져 있어서,
 * 매니저가 배치 오더마다 수동으로 눌러줘야 했음. 빠뜨리면 IN00463486처럼
 * "검수는 PASS인데 피킹은 시작도 안 된" 어긋난 데이터가 생김.
 *
 * [시작 시점 — 매니저 확인 사항]
 * 스캔은 피킹이 아니라 "분류"임. 작업자는 이미 창고를 돌며 집고 있는데
 * 스캔이 아직 안 들어온 것뿐이므로, 스캔 유무로 시작을 판단하면 안 됨.
 * → 작업자가 batch.html에서 이름 선택하고 "▶ 피킹 시작"을 누르는 순간,
 *   그 배치에 속한 모든 오더를 한꺼번에 Started로 만든다.
 *
 * [종료 시점 — 매니저 확인 사항]
 * 작업자마다 끝나는 시점이 다르므로 일괄 종료로 묶지 않음.
 * → 고객사 슬롯이 100%(getSlotProgress의 status==='done')가 된 그 시각을
 *   그 오더의 종료로 기록한다. 이미 스캔 기록에 있는 값이라 추가 입력 없음.
 *
 * [작업자 이름]
 * 개인 이름을 알 수 없으므로 '총량 피킹'으로 고정. 모르는 것을 아는 척하지 않음.
 *
 * [절대 지키는 안전장치]
 *  1) 사람이 직접 한 작업은 덮지 않음 — 이미 실제 작업자 이름이 들어 있거나
 *     이미 completed면 건너뜀 (배치에 포함됐어도 개별로 처리한 오더가 있을 수 있음)
 *  2) 슬롯이 100%가 아니면 절대 완료로 만들지 않음 — 안 나간 물건을
 *     나갔다고 영업팀에 보여주는 것이 가장 위험함
 *  3) 이미 같은 값이면 시트에 다시 쓰지 않음 — 스캔은 초 단위로 들어오므로
 *     매번 쓰면 시트가 느려짐
 * ===================================================================== */

const BATCH_PICKER_NAME = '총량 피킹';

/* 배치에 속한 인보이스 목록 */
function batchInvoices_(batchId) {
  const out = [];
  try {
    const sh = bcustSheetSafe_();
    const last = sh.getLastRow();
    if (last < 2) return out;
    const rows = sh.getRange(2, 1, last - 1, 2).getValues();
    rows.forEach(r => {
      if (String(r[0]) !== String(batchId)) return;
      const inv = String(r[1] || '').trim();
      if (inv && out.indexOf(inv) < 0) out.push(inv);
    });
  } catch (e) { /* best-effort */ }
  return out;
}

/* Jobs 시트에서 필요한 컬럼 번호를 한 번에 확보 */
function jobsCols_() {
  const hdr = headerMapCached_();
  const norm = normalizeHeaderName_;
  return {
    inv:    hdr[norm('Invoice')],
    status: hdr[norm('Status')],
    picker: hdr[norm('Picker')],
    stTime: hdr[norm('Start Time')],
    enTime: hdr[norm('End Time')],
    stISO:  hdr[norm('StartAtISO')],
    enISO:  hdr[norm('EndAtISO')]
  };
}

function fmtHHmm_(d)   { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm'); }
function fmtLocalISO_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"); }

/* ---------------------------------------------------------------------
 * syncBatchJobsStart(batchId) — "▶ 피킹 시작"을 누른 순간 호출됨.
 * 배치에 속한 모든 오더를 Started로. 스캔 유무와 무관 (스캔은 분류 단계이므로).
 * ------------------------------------------------------------------- */
function syncBatchJobsStart(batchId) {
  try {
    const invoices = batchInvoices_(batchId);
    if (!invoices.length) return { ok: true, started: 0 };

    const sh = SHEET_();
    const c = jobsCols_();
    if (!c.inv || !c.status) return { ok: false, error: 'Jobs 시트 컬럼을 찾을 수 없습니다' };
    const last = sh.getLastRow();
    if (last < 2) return { ok: true, started: 0 };

    const n = last - 1;
    const invCol    = sh.getRange(2, c.inv, n, 1).getValues();
    const statusCol = sh.getRange(2, c.status, n, 1).getValues();
    const pickerCol = c.picker ? sh.getRange(2, c.picker, n, 1).getValues() : null;

    const now = new Date();
    const hhmm = fmtHHmm_(now), iso = fmtLocalISO_(now);
    const want = {};
    invoices.forEach(v => { want[v] = true; });

    let started = 0;
    for (let i = 0; i < n; i++) {
      const inv = String(invCol[i][0] || '').trim();
      if (!inv || !want[inv]) continue;

      const st = String(statusCol[i][0] || '').trim().toLowerCase();
      // 안전장치 ①: 이미 진행중이거나 끝난 건 건드리지 않음
      if (st === 'started' || st === 'completed') continue;
      // 안전장치 ①: 사람이 직접 배정한 작업자가 있으면 건드리지 않음
      const pk = pickerCol ? String(pickerCol[i][0] || '').trim() : '';
      if (pk && pk !== BATCH_PICKER_NAME) continue;

      const row = i + 2;
      sh.getRange(row, c.status).setValue('started');
      if (c.picker) sh.getRange(row, c.picker).setValue(BATCH_PICKER_NAME);
      if (c.stTime) sh.getRange(row, c.stTime).setValue(hhmm);
      if (c.stISO)  sh.getRange(row, c.stISO).setValue(iso);
      started++;
    }
    if (started) { bumpVersion_(); Logger.log('syncBatchJobsStart: ' + started + '건 시작 처리 (' + batchId + ')'); }
    return { ok: true, started: started };
  } catch (e) {
    Logger.log('syncBatchJobsStart 오류: ' + String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ---------------------------------------------------------------------
 * syncBatchJobsDone(batchId, slots) — 슬롯이 100% 찬 오더를 완료 처리.
 * slots를 넘기면 그걸 쓰고, 안 넘기면 getSlotProgress로 직접 구함.
 * ------------------------------------------------------------------- */
function syncBatchJobsDone(batchId, slots) {
  try {
    if (!slots) {
      const prog = getSlotProgress(batchId);
      if (!prog || !prog.ok) return { ok: false, error: 'slot progress unavailable' };
      slots = prog.slots || [];
    }
    // 안전장치 ②: status가 'done'인 슬롯만 대상
    const doneInv = {};
    let doneCount = 0;
    slots.forEach(s => {
      if (s && s.status === 'done' && s.invoice) { doneInv[String(s.invoice).trim()] = true; doneCount++; }
    });
    if (!doneCount) return { ok: true, completed: 0 };

    const sh = SHEET_();
    const c = jobsCols_();
    if (!c.inv || !c.status) return { ok: false, error: 'Jobs 시트 컬럼을 찾을 수 없습니다' };
    const last = sh.getLastRow();
    if (last < 2) return { ok: true, completed: 0 };

    const n = last - 1;
    const invCol    = sh.getRange(2, c.inv, n, 1).getValues();
    const statusCol = sh.getRange(2, c.status, n, 1).getValues();
    const pickerCol = c.picker ? sh.getRange(2, c.picker, n, 1).getValues() : null;
    const stISOCol  = c.stISO  ? sh.getRange(2, c.stISO,  n, 1).getValues() : null;

    const now = new Date();
    const hhmm = fmtHHmm_(now), iso = fmtLocalISO_(now);

    let completed = 0;
    for (let i = 0; i < n; i++) {
      const inv = String(invCol[i][0] || '').trim();
      if (!inv || !doneInv[inv]) continue;

      const st = String(statusCol[i][0] || '').trim().toLowerCase();
      // 안전장치 ③: 이미 완료면 다시 쓰지 않음
      if (st === 'completed') continue;
      // 안전장치 ①: 사람이 직접 배정한 작업자가 있으면 건드리지 않음
      const pk = pickerCol ? String(pickerCol[i][0] || '').trim() : '';
      if (pk && pk !== BATCH_PICKER_NAME) continue;

      const row = i + 2;
      // 시작 기록이 없으면(피킹 시작을 안 누른 배치 등) 지금 시각으로 같이 채움 —
      // 종료만 있고 시작이 빈 어중간한 데이터를 남기지 않기 위함
      if (c.picker && !pk) sh.getRange(row, c.picker).setValue(BATCH_PICKER_NAME);
      const hasStart = stISOCol ? !!String(stISOCol[i][0] || '').trim() : false;
      if (!hasStart) {
        if (c.stTime) sh.getRange(row, c.stTime).setValue(hhmm);
        if (c.stISO)  sh.getRange(row, c.stISO).setValue(iso);
      }
      sh.getRange(row, c.status).setValue('completed');
      if (c.enTime) sh.getRange(row, c.enTime).setValue(hhmm);
      if (c.enISO)  sh.getRange(row, c.enISO).setValue(iso);
      completed++;
    }
    if (completed) { bumpVersion_(); Logger.log('syncBatchJobsDone: ' + completed + '건 완료 처리 (' + batchId + ')'); }
    return { ok: true, completed: completed };
  } catch (e) {
    Logger.log('syncBatchJobsDone 오류: ' + String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ---------------------------------------------------------------------
 * maybeSyncBatchJobsDone_(batchId, slots) — getSlotProgress가 호출될 때마다
 * 얹혀서 돌아가는 가벼운 자동 처리.
 *
 * getSlotProgress는 TV 현황판이 8초, batch.html이 5초마다 부르는 API라
 * 매번 Jobs 시트를 읽고 쓰면 감당이 안 됨. 그래서 "완료된 슬롯 목록"이
 * 지난번과 똑같으면 아무것도 하지 않고 즉시 빠져나옴(시트 접근 0회).
 * 새로 완료된 슬롯이 생겼을 때만 실제 동기화를 수행함.
 * ------------------------------------------------------------------- */
function maybeSyncBatchJobsDone_(batchId, slots) {
  try {
    const doneList = (slots || [])
      .filter(s => s && s.status === 'done' && s.invoice)
      .map(s => String(s.invoice).trim())
      .sort();
    const sig = doneList.join(',');
    const key = 'jobsync_' + String(batchId);
    const cache = CacheService.getScriptCache();
    if (cache.get(key) === sig) return;      // 변화 없음 → 아무것도 안 함
    cache.put(key, sig, 900);                 // 15분 유지
    if (!doneList.length) return;
    syncBatchJobsDone(batchId, slots);
  } catch (e) { /* 자동 처리 실패가 화면 조회를 막으면 안 되므로 조용히 무시 */ }
}

/* ---------------------------------------------------------------------
 * syncBatchJobsAll(batchId) — 매니저가 수동으로 한 번에 맞추고 싶을 때.
 * GAS 에디터에서 직접 실행하거나 ...exec?op=syncBatchJobs&batchId=... 로 호출.
 * ------------------------------------------------------------------- */
function syncBatchJobsAll(batchId) {
  batchId = String(batchId || '').trim();
  if (!batchId) return { ok: false, error: 'batchId required' };
  const a = syncBatchJobsStart(batchId);
  const b = syncBatchJobsDone(batchId, null);
  return { ok: true, started: (a && a.started) || 0, completed: (b && b.completed) || 0 };
}

/* ---------------------------------------------------------------------
 * fixPageRange_(raw) — ★ 2026-08-07 신규
 * 담당페이지가 구글시트에 의해 날짜로 변환돼 저장된 과거 기록을 원래대로 표시.
 *   "1-3" → 2026-01-03 (Date) → 다시 "1-3"
 * 앞으로 저장되는 값은 텍스트 서식으로 고정했으므로 변환되지 않음.
 * ------------------------------------------------------------------- */
function fixPageRange_(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (Object.prototype.toString.call(raw) === '[object Date]' && !isNaN(raw)) {
    return (raw.getMonth() + 1) + '-' + raw.getDate();
  }
  const str = String(raw).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (m) return parseInt(m[2], 10) + '-' + parseInt(m[3], 10);
  return str;
}
