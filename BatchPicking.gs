/******************************************************
 * FirestoreSync.gs — 그룹A(board.html, sales.html) 단방향 미러링
 * ------------------------------------------------------
 * 기존 함수(getBatch, getSalesOverview 등) 로직은 절대 안 건드림.
 * 이 파일은 그 함수들을 "그대로 호출"해서 결과 JSON을
 * Firestore에 복사만 함. 1분 시간기반 트리거로 실행됨.
 ******************************************************/

function getFirestore_() {
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty('FIRESTORE_CLIENT_EMAIL');
  const rawKey = props.getProperty('FIRESTORE_PRIVATE_KEY');
  const projectId = props.getProperty('FIRESTORE_PROJECT_ID');
  if (!email || !rawKey || !projectId) {
    throw new Error('Firestore Script Properties가 설정되지 않았습니다 (4-1 단계 확인)');
  }
  const normalizedKey = rawKey.replace(/\\n/g, '\n');
  return FirestoreApp.getFirestore(email, normalizedKey, projectId);
}

/* ===================== checkFirestoreCredentials (진단용) ===================== */
function checkFirestoreCredentials() {
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty('FIRESTORE_CLIENT_EMAIL') || '';
  const key = props.getProperty('FIRESTORE_PRIVATE_KEY') || '';
  const projectId = props.getProperty('FIRESTORE_PROJECT_ID') || '';

  Logger.log('=== 자격증명 형식 점검 (값 자체는 출력 안 함) ===');
  Logger.log('email 존재: ' + !!email + ' / email이 .iam.gserviceaccount.com으로 끝나는가: ' + email.endsWith('.iam.gserviceaccount.com'));
  Logger.log('projectId: ' + projectId);
  Logger.log('key 길이: ' + key.length);

  const normalizedKey = key.replace(/\\n/g, '\n');
  try {
    Utilities.computeRsaSha256Signature('test', normalizedKey);
    Logger.log('✅ RSA 서명 테스트 성공');
  } catch (e) {
    Logger.log('❌ RSA 서명 테스트 실패: ' + String(e && e.message || e));
  }

  try {
    const firestore = getFirestore_();
    firestore.createDocument('mirror/_connectionTest', { checkedAt: batchNow_() });
    Logger.log('✅ Firestore 실제 연결 테스트 성공');
  } catch (e) {
    Logger.log('❌ Firestore 연결 테스트 실패: ' + String(e && e.message || e));
  }
}

// mirror 컬렉션 하위에 doc 하나를 통째로 덮어씀.
function mirrorWrite_(firestore, docPath, payload) {
  const fields = {
    data: JSON.stringify(payload),
    updatedAt: batchNow_(),
  };
  try {
    firestore.updateDocument('mirror/' + docPath, fields);
  } catch (eUpdate) {
    try {
      firestore.createDocument('mirror/' + docPath, fields);
    } catch (eCreate) {
      Logger.log('mirrorWrite_ 실패 (' + docPath + '): update=' + String(eUpdate && eUpdate.message || eUpdate) + ' / create=' + String(eCreate && eCreate.message || eCreate));
    }
  }
}

// 함수 호출 하나가 에러 나도 전체가 멈추지 않도록 감싸는 헬퍼 (결과 또는 null 반환)
function safeCall_(fn) {
  try { return fn(); } catch (e) { Logger.log('safeCall_ 실패: ' + String(e && e.message || e)); return null; }
}

// 함수 하나가 에러 나도 나머지 동기화는 계속 진행되도록 감싸는 헬퍼 (mirrorWrite까지 처리)
function safeSync_(firestore, docPath, fn) {
  try {
    const result = fn();
    mirrorWrite_(firestore, docPath, result);
  } catch (e) {
    Logger.log('syncToFirestore: ' + docPath + ' 실패 — ' + String(e && e.message || e));
  }
}

/* ===================== syncToFirestore (1분 트리거로 실행) =====================
 * ★ 수정 — board.html(v2)이 화면에 뭘 보여줄지 스스로 판단하던 3단계 규칙
 *   (①매니저가 지정한 활성 배치 → ②오늘 만든 배치 → ③미완료 배치가 정확히
 *   1개뿐이면 그것)을 여기서도 서버가 똑같이 따라가서 displayBatchId를 정함.
 *   이렇게 해야 "활성 배치가 명시적으로 지정 안 된 상태"에서도
 *   board_slotProgress/board_unfulfilledAlerts 문서가 항상 만들어짐.
 * ================================================================================ */
function syncToFirestore() {
  const firestore = getFirestore_();

  // ---- board.html용: 각 함수는 한 번씩만 호출해서 재사용 ----
  const activeRes = safeCall_(function(){ return getActiveBatch(); });
  mirrorWrite_(firestore, 'board_activeBatch', activeRes || { ok: false });

  const todayRes = safeCall_(function(){ return getBatch(); });
  mirrorWrite_(firestore, 'board_batch', todayRes || { ok: false });

  const openRes = safeCall_(function(){ return getOpenBatches(); });
  mirrorWrite_(firestore, 'board_openBatches', openRes || { ok: false });

  safeSync_(firestore, 'board_batchWorkers', function(){ return getBatchWorkers(); });

  // ★ board.html의 pollOnce()와 동일한 3단계 규칙으로 "지금 화면에 보여줄 배치"를 결정
  let displayBatchId = '';
  if (activeRes && activeRes.ok && activeRes.batch && activeRes.batch.batchId) {
    displayBatchId = activeRes.batch.batchId;
  } else if (todayRes && todayRes.ok && todayRes.batch && todayRes.batch.batchId) {
    displayBatchId = todayRes.batch.batchId;
  } else if (openRes && openRes.ok && Array.isArray(openRes.batches)) {
    const trulyOpen = openRes.batches.filter(function(b){ return !b.recentlyCompleted; });
    if (trulyOpen.length === 1) displayBatchId = trulyOpen[0].batchId;
  }

  if (displayBatchId) {
    safeSync_(firestore, 'board_slotProgress', function(){ return getSlotProgress(displayBatchId); });
    safeSync_(firestore, 'board_unfulfilledAlerts', function(){ return getUnfulfilledSkuAlerts(displayBatchId); });
  } else {
    // ★ 배치가 전혀 없어도 문서 자체는 만들어둬서, board.html이 응답을 영원히
    // 기다리지 않고 정상적으로 "진행중인 배치 없음"을 표시할 수 있게 함.
    mirrorWrite_(firestore, 'board_slotProgress', { ok: true, slots: [], doneCount: 0, totalCount: 0 });
    mirrorWrite_(firestore, 'board_unfulfilledAlerts', { ok: true, alerts: [] });
  }

  // ---- sales.html용 ----
  safeSync_(firestore, 'sales_overview', function(){ return getSalesOverview(); });
  safeSync_(firestore, 'sales_todayList', function(){ return getSalesTodayList(); });
}

function installFirestoreSyncTrigger() {
  const existing = ScriptApp.getProjectTriggers()
    .filter(function(t){ return t.getHandlerFunction() === 'syncToFirestore'; });
  existing.forEach(function(t){ ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('syncToFirestore')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('✅ syncToFirestore 1분 트리거 설치 완료');
}

/* ===================== syncSalesInvoiceDetailMirror_ (★ 세션A 신규) =====================
 * 목적: getSalesInvoiceDetail(invoice)의 결과를 바꿀 수 있는 모든 쓰기 함수의
 * 끝에서 호출한다 — 이 인보이스의 최신 상세를 Firestore mirror/salesInvDetail_{invoice}
 * 문서로 다시 쓰고, 동시에 기존 6초 서버 캐시(salesInvDetail_v1_{invoice})도 지운다.
 *
 * getSalesOverview/getSalesTodayList처럼 "고정된 소수 문서"를 1분마다 통째로
 * 다시 계산하는 syncToFirestore()와 달리, 인보이스는 수가 무한히 늘어날 수
 * 있으므로 이 함수는 "그 인보이스에 영향을 주는 쓰기가 실제로 일어났을 때만"
 * 호출된다(쓰기 시점 전파, write-through) — syncToFirestore()의 1분 트리거와는
 * 완전히 별개의 경로이며, 서로 겹치거나 충돌하지 않는다.
 *
 * ★ 이번에 같이 고친 버그 — 예전엔 updateOrderMethod/updatePaymentStatus 딱 두
 * 곳만 salesInvDetail_v1_{invoice} 캐시를 지우고 있었음. saveInspection/
 * setPackingMoved/saveDimensions/logIssue류(모두 syncInspectionFromPicking_
 * 경유)는 이 캐시를 전혀 안 지워서, 검수·이슈·디멘션을 바꿔도 최대 6초~30초간
 * 상세조회 화면에 예전 값이 그대로 보일 수 있는 잠복 버그가 있었음. 이제 이
 * 함수 하나로 모든 쓰기 경로가 캐시 삭제 + 미러 갱신을 동시에 하도록 통일함.
 *
 * best-effort — 여기서 실패해도 원래 쓰기 자체는 이미 성공한 뒤이므로, 호출부는
 * 항상 try/catch로 감싸서 쓴다. 반드시 락(LockService) 밖에서, 원래 쓰기가
 * 끝난 뒤에 호출한다(logScan/logIssue의 syncInspectionFromPicking_과 동일한
 * 이유 — 무거운 계산으로 다른 작업자의 쓰기를 기다리게 하면 안 됨).
 *
 * 입력: 인보이스 문자열 1개 또는 배열(여러 인보이스가 한 번에 영향받는 경우 —
 *       분할 인보이스 그룹 전체, 디멘션 합산 그룹 전체 등)
 * ================================================================================ */
function syncSalesInvoiceDetailMirror_(invoiceOrList) {
  const invoices = Array.isArray(invoiceOrList) ? invoiceOrList : [invoiceOrList];
  const cache = CacheService.getScriptCache();
  let firestore = null;
  invoices.forEach(function (rawInvoice) {
    const invoice = String(rawInvoice || '').trim();
    if (!invoice) return;

    // 1) 기존 6초 서버 캐시 무효화 (Firestore 미러가 실패해도 이건 항상 시도)
    try { cache.remove('salesInvDetail_v1_' + invoice); } catch (e) { /* 무시 */ }

    // 2) Firestore 미러 문서 갱신 (best-effort — 실패해도 원래 쓰기엔 영향 없음)
    try {
      if (!firestore) firestore = getFirestore_(); // 위 getFirestore_() 재사용
      const detail = getSalesInvoiceDetail(invoice); // BatchPicking.gs의 기존 함수 그대로 재사용, 로직 안 건드림
      mirrorWrite_(firestore, 'salesInvDetail_' + invoice, detail); // 위 mirrorWrite_() 재사용
    } catch (e) {
      Logger.log('syncSalesInvoiceDetailMirror_ 실패 (' + invoice + '): ' + String(e && e.message || e));
    }
  });
}

/* ===================== writeIssueLogDoc_ (★ 세션C 신규) =====================
 * 목적: BatchPicking.gs의 logIssue()가 구글시트(IssueLog)에 새 이슈 행을 쓴
 * 것과 정확히 동일한 내용을, Firestore의 issueLog/{issueId} 컬렉션에도 그대로
 * 복사해서 쓴다 — "①번 이중쓰기" 방식(세션C 설계 확정 사항)의 첫 적용.
 *
 * 왜 필요한가: 지금 당장 이 Firestore 기록을 구독해서 보여주는 화면은 없다.
 * 목적은 순수하게 "나중에(세션D/E) 이슈 데이터를 Firestore 기반으로 옮길 때,
 * 그 시점부터 새로 쌓기 시작하는 게 아니라 이미 지금부터 쌓여있게" 하기 위한
 * 준비 작업이다. 구글시트는 지금도, 앞으로도 세션E 전까지는 유일한 진짜
 * 데이터(source of truth)이며 이 함수는 그 옆에 사본을 하나 더 만들 뿐이다.
 *
 * 안전 원칙(세션A의 syncSalesInvoiceDetailMirror_와 동일):
 *  - best-effort — 이 함수가 실패해도 호출부(logIssue)의 원래 쓰기는 이미
 *    끝난 뒤이므로 절대 영향받지 않는다. 호출부는 반드시 try/catch로 감싸서 씀.
 *  - issueId(UUID)를 문서 ID로 그대로 사용 — 같은 이슈를 가리키는 구글시트
 *    행과 Firestore 문서가 항상 1:1로 정확히 대응됨(나중에 대조·이전 작업 시
 *    핵심적으로 중요).
 *  - createDocument를 먼저 시도하고, 이미 존재하면(재시도 등의 극히 드문 경우)
 *    updateDocument로 대체 — mirrorWrite_()와 동일한 방어적 패턴.
 *
 * 입력: doc = { batchId, issueId, timestamp, worker, barcode, sku, name,
 *               invoice, customer, reason, qty, note, status }
 *       — logIssue()가 실제로 시트에 쓴 값과 필드명·값 모두 정확히 동일.
 * ================================================================================ */
function writeIssueLogDoc_(doc) {
  const firestore = getFirestore_(); // 위 getFirestore_() 재사용 — 자격증명 로직 중복 없음
  const fields = Object.assign({}, doc);
  try {
    firestore.createDocument('issueLog/' + doc.issueId, fields);
  } catch (eCreate) {
    // 극히 드문 경우(재시도로 같은 issueId가 다시 들어온 경우)에만 덮어쓰기로 대체
    try {
      firestore.updateDocument('issueLog/' + doc.issueId, fields);
    } catch (eUpdate) {
      Logger.log('writeIssueLogDoc_ 실패 (issueId=' + doc.issueId + '): create=' + String(eCreate && eCreate.message || eCreate) + ' / update=' + String(eUpdate && eUpdate.message || eUpdate));
    }
  }
}
