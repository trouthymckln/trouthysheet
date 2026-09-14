const { useEffect, useRef, useState } = React;

const LocalStore = window.SiteStore;
const CloudStore = window.TrouthyCloudStore;
const MAX_IMAGE_BYTES = CloudStore?.maxImageBytes || 8 * 1024 * 1024;
const EMPTY_AUTH_STATE = {
  configured: false,
  user: null,
  isEditor: false,
  setupError: '尚未完成共享編輯設定。'
};
const BUILTIN_SLUGS = ['intro', 'events', 'policy', 'welfare'];
const SAMPLE_BRANCH_IDS = new Set([
  'intro-1', 'intro-2', 'intro-3',
  'events-1', 'events-2', 'events-3',
  'policy-1', 'policy-2', 'policy-3',
  'welfare-1', 'welfare-2', 'welfare-3'
]);

const makeId = (prefix) => window.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const copy = (value) => JSON.parse(JSON.stringify(value));

const DEFAULT_DOCUMENT = {
  version: 3,
  pages: [
    {
      id: 'page-intro', slug: 'intro', title: '簡介', builtIn: true, layout: 'vertical', branches: []
    },
    {
      id: 'page-events', slug: 'events', title: '活動', builtIn: true, layout: 'vertical', branches: []
    },
    {
      id: 'page-policy', slug: 'policy', title: '政策', builtIn: true, layout: 'vertical', branches: []
    },
    {
      id: 'page-welfare', slug: 'welfare', title: '福利', builtIn: true, layout: 'vertical', branches: []
    }
  ]
};

const safeSlug = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48);

const uniqueSlug = (value, used, fallback = 'page') => {
  const base = safeSlug(value) || fallback;
  let candidate = base;
  let number = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${number}`;
    number += 1;
  }
  return candidate;
};

const normaliseUrl = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
};

const normaliseBranch = (branch, fallback = {}) => ({
  id: String(branch?.id || fallback.id || makeId('branch')),
  title: String(branch?.title ?? fallback.title ?? ''),
  body: String(branch?.body ?? branch?.description ?? fallback.body ?? ''),
  imageId: typeof branch?.imageId === 'string' ? branch.imageId : null,
  imagePath: typeof branch?.imagePath === 'string' ? branch.imagePath : null,
  imageProvider: branch?.imageProvider === 'firestore' ? 'firestore' : null,
  imageUrl: typeof branch?.imageUrl === 'string'
    ? branch.imageUrl
    : typeof branch?.image === 'string'
      ? branch.image
      : (fallback.imageUrl || ''),
  ctaLabel: String(branch?.ctaLabel ?? fallback.ctaLabel ?? ''),
  ctaUrl: String(branch?.ctaUrl ?? fallback.ctaUrl ?? '')
});

const normaliseDocument = (document) => {
  const source = document || {};
  const sourceVersion = Number(source.version) || 1;
  const inputPages = Array.isArray(source.pages) ? source.pages : [];
  const usedSlugs = new Set();
  const builtInPages = DEFAULT_DOCUMENT.pages.map((template) => {
    const found = inputPages.find((page) => page?.id === template.id || page?.slug === template.slug);
    const page = { ...copy(template), ...(found || {}), builtIn: true, slug: template.slug, title: template.title };
    usedSlugs.add(template.slug);
    page.layout = 'vertical';
    page.branches = Array.isArray(found?.branches)
      ? found.branches
        .filter((branch) => sourceVersion >= 3 || !SAMPLE_BRANCH_IDS.has(String(branch?.id)))
        .map((branch) => normaliseBranch(branch))
      : [];
    return page;
  });
  const customPages = inputPages
    .filter((page) => page && !BUILTIN_SLUGS.includes(page.slug) && !BUILTIN_SLUGS.includes(page.id))
    .map((page) => {
      const slug = uniqueSlug(page.slug || page.title, usedSlugs);
      usedSlugs.add(slug);
      return {
        id: String(page.id || makeId('page')),
        slug,
        title: String(page.title || slug),
        builtIn: false,
        layout: 'vertical',
        branches: Array.isArray(page.branches) ? page.branches.map((branch) => normaliseBranch(branch)) : []
      };
    });
  return { version: 3, pages: [...builtInPages, ...customPages] };
};

const discardedSampleImageIds = (source, normalised) => {
  if ((Number(source?.version) || 1) >= 3 || !Array.isArray(source?.pages)) return [];
  const retainedImageIds = new Set(normalised.pages.flatMap((page) => page.branches.map((branch) => branch.imageId)).filter(Boolean));
  return source.pages
    .filter((page) => DEFAULT_DOCUMENT.pages.some((template) => template.id === page?.id || template.slug === page?.slug))
    .flatMap((page) => Array.isArray(page.branches) ? page.branches : [])
    .filter((branch) => SAMPLE_BRANCH_IDS.has(String(branch?.id)) && branch?.imageId && !retainedImageIds.has(branch.imageId))
    .map((branch) => branch.imageId);
};

const unreferencedFirestoreImageIds = (document, imageIds) => {
  const retainedImageIds = new Set(document.pages
    .flatMap((page) => page.branches)
    .filter((branch) => branch.imageProvider === 'firestore' && branch.imageId)
    .map((branch) => branch.imageId));
  return [...new Set(imageIds.filter((imageId) => imageId && !retainedImageIds.has(imageId)))];
};

const migrateLegacyDocument = () => copy(DEFAULT_DOCUMENT);

const hashFor = (slug) => `#/${encodeURIComponent(slug)}`;

const readHashSlug = () => {
  const raw = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  try {
    return safeSlug(decodeURIComponent(raw));
  } catch {
    return '';
  }
};

const messageForError = (error) => {
  if (error?.code === 'trouthy/not-configured') return '儲存變更前，請先完成 Firebase 共享編輯設定。';
  if (error?.code === 'trouthy/not-authorized' || error?.code === 'permission-denied') return '只有獲准的團隊帳號可以變更此網站。';
  if (error?.code === 'auth/popup-closed-by-user') return 'Google 登入在完成前已關閉。';
  if (error?.code === 'trouthy/missing-token' || error?.code === 'trouthy/expired-token' || error?.code === 'trouthy/invalid-token') return '照片上傳前，請重新登入獲准的 Google 帳號。';
  if (error?.code === 'trouthy/origin-not-allowed') return '此網站網址尚未加入圖片上傳服務的允許清單。';
  if (error?.code === 'trouthy/firebase-keys-unavailable') return '目前無法驗證登入身分。請稍後再試。';
  if (error?.code === 'trouthy/image-upload-failed') return '圖片主機拒絕了這次上傳。請稍後再試。';
  if (error?.code === 'trouthy/not-image') return '請為此分支選擇圖片檔案。';
  if (error?.code === 'trouthy/image-too-large') return '請選擇小於 8 MB 的圖片。';
  if (error?.name === 'QuotaExceededError') return '瀏覽器儲存空間已滿。請移除圖片或釋放空間後再試。';
  return error?.message || '無法將變更分享給所有訪客。';
};

function BranchImage({ branch, alt, className = '', compact = false }) {
  const [failed, setFailed] = useState(false);
  const source = branch.imageUrl;

  useEffect(() => setFailed(false), [source]);

  if (!source || failed) {
    return <div className={`image-placeholder ${compact ? 'image-placeholder-compact' : ''} ${className}`} aria-hidden="true" />;
  }

  return <img className={className} src={source} alt={alt} onError={() => setFailed(true)} />;
}

function PageManager({ pages, activeSlug, onNavigate, onAddPage, onUpdateTitle, onUpdateSlug, onMovePage, onDeletePage }) {
  const customPages = pages.filter((page) => !page.builtIn);

  return <section className="editor-section page-manager" aria-labelledby="page-manager-title">
    <div className="editor-section-heading">
      <div>
        <p className="eyebrow">網站結構</p>
        <h2 id="page-manager-title">頁面</h2>
      </div>
      <button className="command-button command-primary" type="button" onClick={onAddPage}>+ 新增頁面</button>
    </div>
    <div className="page-list">
      {pages.map((page) => {
        const customPosition = customPages.findIndex((candidate) => candidate.id === page.id);
        const isCustom = !page.builtIn;
        return <article className={`page-row ${page.slug === activeSlug ? 'is-active' : ''}`} key={page.id}>
          <button className="page-open" type="button" onClick={() => onNavigate(page.slug)} aria-current={page.slug === activeSlug ? 'page' : undefined}>
            <span>{page.title}</span>
            <small>{page.builtIn ? '內建' : `#/${page.slug}`}</small>
          </button>
          {isCustom && <div className="page-fields">
            <label>頁面名稱<input defaultValue={page.title} onBlur={(event) => onUpdateTitle(page.id, event.target.value)} /></label>
            <label>網址路徑<input defaultValue={page.slug} onBlur={(event) => onUpdateSlug(page.id, event.target.value)} /></label>
          </div>}
          {isCustom && <div className="row-actions" aria-label={`管理 ${page.title}`}>
            <button className="icon-button" type="button" title="將頁面向前移動" aria-label="將頁面向前移動" disabled={customPosition <= 0} onClick={() => onMovePage(page.id, -1)}>&uarr;</button>
            <button className="icon-button" type="button" title="將頁面向後移動" aria-label="將頁面向後移動" disabled={customPosition === customPages.length - 1} onClick={() => onMovePage(page.id, 1)}>&darr;</button>
            <button className="icon-button danger" type="button" title="刪除頁面" aria-label="刪除頁面" onClick={() => onDeletePage(page.id)}>&times;</button>
          </div>}
        </article>;
      })}
    </div>
  </section>;
}

function BranchEditorRow({ branch, index, total, selected, onSelect, onChange, onMove, onDelete, onUpload, onRemoveImage, reportError }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const validUrl = !branch.ctaUrl || Boolean(normaliseUrl(branch.ctaUrl));

  const chooseImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      const message = '請為此分支選擇圖片檔案。';
      setUploadError(message);
      reportError(message);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      const message = '請選擇小於 8 MB 的圖片。';
      setUploadError(message);
      reportError(message);
      return;
    }
    setUploadError('');
    setUploading(true);
    try {
      const result = await onUpload(file);
      if (!result?.saved) {
        setUploadError(result?.message || '無法上傳照片。請檢查網絡連線後再試。');
      }
    } finally {
      setUploading(false);
    }
  };

  const removeImage = () => {
    onRemoveImage();
  };

  return <article className={`branch-editor-row ${selected ? 'is-selected' : ''}`}>
    <div className="branch-editor-number">{String(index + 1).padStart(2, '0')}</div>
    <button className="branch-editor-select" type="button" onClick={onSelect}>
      <BranchImage branch={branch} alt="" compact className="branch-thumbnail" />
      <span>{branch.title || '未命名分支'}</span>
    </button>
    <div className="branch-fields">
      <label>標題<input value={branch.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
      <label>說明<textarea value={branch.body} onChange={(event) => onChange({ body: event.target.value })} rows="3" /></label>
      <label>按鈕文字<input value={branch.ctaLabel} placeholder="可選填的按鈕文字" onChange={(event) => onChange({ ctaLabel: event.target.value })} /></label>
      <label>按鈕網址<input type="url" value={branch.ctaUrl} placeholder="https://example.com" onChange={(event) => onChange({ ctaUrl: event.target.value })} /></label>
      {!validUrl && <p className="field-warning">請使用完整的 http:// 或 https:// 連結。</p>}
      <div className="branch-image-actions">
        <label className="file-picker">
          <span>{uploading ? '正在處理照片...' : branch.imageUrl ? '更換照片' : '上傳照片'}</span>
          <input type="file" accept="image/*" onChange={chooseImage} disabled={uploading} />
        </label>
        {(branch.imageId || branch.imagePath || branch.imageUrl) && <button className="text-button" type="button" onClick={removeImage}>移除照片</button>}
      </div>
      {uploadError && <p className="field-warning" role="alert">{uploadError}</p>}
    </div>
    <div className="row-actions branch-actions" aria-label={`管理 ${branch.title || '此分支'}`}>
      <button className="icon-button" type="button" title="將分支向前移動" aria-label="將分支向前移動" disabled={index === 0} onClick={() => onMove(-1)}>&uarr;</button>
      <button className="icon-button" type="button" title="將分支向後移動" aria-label="將分支向後移動" disabled={index === total - 1} onClick={() => onMove(1)}>&darr;</button>
      <button className="icon-button danger" type="button" title="刪除分支" aria-label="刪除分支" onClick={onDelete}>&times;</button>
    </div>
  </article>;
}

function BranchEditor({ page, selectedBranchId, onSelectBranch, onAddBranch, onUpdateBranch, onMoveBranch, onDeleteBranch, onUploadImage, onRemoveImage, reportError }) {
  return <section className="editor-section branch-editor" aria-labelledby="branch-editor-title">
    <div className="editor-section-heading">
      <div>
        <p className="eyebrow">路線編輯器</p>
        <h2 id="branch-editor-title">{page.title} 的分支</h2>
      </div>
      <button className="command-button command-primary" type="button" onClick={() => onAddBranch(page.id)}>+ 新增分支</button>
    </div>
    {page.branches.length ? <div className="branch-editor-list">
      {page.branches.map((branch, index) => <BranchEditorRow
        key={branch.id}
        branch={branch}
        index={index}
        total={page.branches.length}
        selected={selectedBranchId === branch.id}
        onSelect={() => onSelectBranch(branch.id)}
        onChange={(changes) => onUpdateBranch(page.id, branch.id, changes)}
        onMove={(direction) => onMoveBranch(page.id, branch.id, direction)}
        onDelete={() => onDeleteBranch(page.id, branch.id)}
        onUpload={(file) => onUploadImage(page.id, branch.id, file)}
        onRemoveImage={() => onRemoveImage(page.id, branch.id)}
        reportError={reportError}
      />)}
    </div> : <div className="empty-editor-state">尚未建立旅程節點。</div>}
  </section>;
}

function createJourneyGeometry(branches) {
  const count = Math.max(branches.length, 1);
  const height = Math.max(560, 190 + count * 170);
  const startY = count === 1 ? Math.round(height / 2) : 118;
  const endY = height - 100;
  const step = count === 1 ? 0 : (endY - startY) / (count - 1);
  const routeX = 380;
  const branchOffset = 180;
  const stops = branches.map((branch, index) => ({
    id: branch.id,
    index,
    y: Math.round(startY + step * index),
    carX: routeX,
    cardX: routeX + (index % 2 === 0 ? branchOffset : -branchOffset)
  }));

  return {
    height,
    stops,
    carPath: `M ${routeX} 42 L ${routeX} ${height - 42}`,
    connectors: stops.map((stop) => `M ${routeX} ${stop.y} L ${stop.cardX} ${stop.y}`)
  };
}

function RouteJourney({ page, selectedBranchId, onSelectBranch, onOpenBranch, runId }) {
  const geometry = createJourneyGeometry(page.branches);
  const trackRef = useRef(null);
  const carRef = useRef(null);
  const selectRef = useRef(onSelectBranch);
  const [revealedCount, setRevealedCount] = useState(0);
  const branchSignature = page.branches.map((branch) => branch.id).join('|');

  selectRef.current = onSelectBranch;

  useEffect(() => {
    setRevealedCount(0);
    const track = trackRef.current;
    const car = carRef.current;
    if (!track || !car || !page.branches.length) return () => {};

    const length = track.getTotalLength();
    const duration = Math.max(2800, page.branches.length * 1050);
    let frameId = 0;
    let startedAt = 0;
    let lastRevealed = 0;
    track.style.strokeDasharray = String(length);
    track.style.strokeDashoffset = String(length);
    car.style.opacity = '0';

    const update = (now) => {
      if (!startedAt) startedAt = now;
      const progress = Math.min((now - startedAt) / duration, 1);
      const point = track.getPointAtLength(length * progress);
      car.style.left = `${(point.x / 760) * 100}%`;
      car.style.top = `${(point.y / geometry.height) * 100}%`;
      car.style.opacity = progress > 0 ? '1' : '0';
      track.style.strokeDashoffset = String(length * (1 - progress));

      const nextRevealed = Math.min(page.branches.length, Math.floor(progress * (page.branches.length + 1)));
      if (nextRevealed > lastRevealed) {
        lastRevealed = nextRevealed;
        setRevealedCount(nextRevealed);
        selectRef.current(page.branches[nextRevealed - 1].id);
      }
      if (progress < 1) frameId = requestAnimationFrame(update);
    };

    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, [page.id, branchSignature, runId, geometry.height]);

  if (!page.branches.length) {
    return <section className="journey journey-empty" aria-label={`${page.title} 路線`}>
      <p>此路線尚未新增分支內容。</p>
    </section>;
  }

  return <section className="journey journey-vertical" aria-labelledby="journey-title">
    <div className="journey-heading">
      <h2 id="journey-title">探索路線</h2>
    </div>
    <div className="journey-canvas" style={{ height: `${geometry.height}px` }}>
      <svg className="journey-svg" viewBox={`0 0 760 ${geometry.height}`} aria-hidden="true" preserveAspectRatio="none">
        {geometry.connectors.map((connector, index) => <path className="journey-connector" d={connector} key={`${connector}-${index}`} />)}
        <path className="journey-track" d={geometry.carPath} ref={trackRef} />
      </svg>
      <img className="journey-car" ref={carRef} src="car2.png" alt="" aria-hidden="true" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
      {geometry.stops.map((stop, index) => <button
        key={stop.id}
        type="button"
        className={`journey-stop ${index < revealedCount ? 'is-revealed' : ''} ${selectedBranchId === stop.id ? 'is-selected' : ''}`}
        style={{ left: `${(stop.cardX / 760) * 100}%`, top: `${(stop.y / geometry.height) * 100}%` }}
        onClick={() => onOpenBranch(stop.id)}
        aria-pressed={selectedBranchId === stop.id}
      >
        <span>{String(index + 1).padStart(2, '0')}</span>
        <strong>{page.branches[index].title || '未命名分支'}</strong>
      </button>)}
    </div>
  </section>;
}

function BranchSlide({ branch, branches, onSelectBranch, copyRef }) {
  if (!branch) return null;
  const index = branches.findIndex((candidate) => candidate.id === branch.id);
  const destination = normaliseUrl(branch.ctaUrl);
  const hasImage = Boolean(branch.imageUrl);
  const previous = branches[index - 1];
  const next = branches[index + 1];

  return <article className={`branch-slide ${hasImage ? 'has-image' : 'without-image'}`} aria-labelledby={`slide-title-${branch.id}`}>
    {hasImage && <div className="branch-slide-media"><BranchImage branch={branch} alt={branch.title || '分支圖片'} className="branch-slide-image" /></div>}
    <div className="branch-slide-copy" ref={copyRef}>
      <p className="slide-count">{String(index + 1).padStart(2, '0')} / {String(branches.length).padStart(2, '0')}</p>
      <h2 id={`slide-title-${branch.id}`}>{branch.title || '未命名分支'}</h2>
      {branch.body && <p>{branch.body}</p>}
      {destination && branch.ctaLabel && <a className="command-button command-primary" href={destination} target="_blank" rel="noreferrer">{branch.ctaLabel}</a>}
      <div className="slide-controls" aria-label="分支控制">
        <button className="icon-button" type="button" title="上一個分支" aria-label="上一個分支" disabled={!previous} onClick={() => onSelectBranch(previous.id)}>&larr;</button>
        <span>第 {index + 1} 個，共 {branches.length} 個分支</span>
        <button className="icon-button" type="button" title="下一個分支" aria-label="下一個分支" disabled={!next} onClick={() => onSelectBranch(next.id)}>&rarr;</button>
      </div>
    </div>
  </article>;
}

function App() {
  const [site, setSite] = useState(null);
  const [mode, setMode] = useState('presentation');
  const [headerMinimized, setHeaderMinimized] = useState(false);
  const [activeSlug, setActiveSlug] = useState('intro');
  const [selectedBranchId, setSelectedBranchId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [journeyRunId, setJourneyRunId] = useState(0);
  const [storageError, setStorageError] = useState('');
  const [saveState, setSaveState] = useState('');
  const [authState, setAuthState] = useState(() => CloudStore?.getAuthState?.() || EMPTY_AUTH_STATE);
  const [remoteExists, setRemoteExists] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const siteRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const lastSaveRef = useRef(Promise.resolve(false));
  const saveTimerRef = useRef(0);
  const initialRouteRef = useRef(true);
  const transitionRef = useRef(0);
  const activeSlugRef = useRef(activeSlug);
  const branchCopyRef = useRef(null);

  siteRef.current = site;
  activeSlugRef.current = activeSlug;
  const canEdit = Boolean(authState.configured && authState.isEditor);

  const reportError = (error) => setStorageError(typeof error === 'string' ? error : messageForError(error));

  const persistDocument = (documentToSave) => {
    if (!canEdit || !CloudStore?.isConfigured?.()) {
      reportError('只有獲准的團隊帳號可以變更此網站。');
      setSaveState('未儲存');
      return Promise.resolve(false);
    }
    const snapshot = copy(documentToSave);
    setSaveState('正在為所有訪客儲存...');
    const save = saveQueueRef.current
      .catch(() => undefined)
      .then(() => CloudStore.saveDocument(snapshot))
      .then(() => {
        setSaveState('已為所有訪客儲存');
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => setSaveState(''), 1800);
        return true;
      })
      .catch((error) => {
        reportError(error);
        setSaveState('未儲存');
        return false;
      });
    saveQueueRef.current = save;
    lastSaveRef.current = save;
    return save;
  };

  const commitDocument = (updater) => {
    const current = siteRef.current;
    if (!current || !canEdit) {
      if (!canEdit) reportError('只有獲准的團隊帳號可以變更此網站。');
      return null;
    }
    const next = normaliseDocument(updater(copy(current)));
    siteRef.current = next;
    setSite(next);
    persistDocument(next);
    return next;
  };

  const navigateTo = (slug, replace = false) => {
    const nextHash = hashFor(slug);
    if (slug !== activeSlugRef.current) setIsLoading(true);
    if (window.location.hash !== nextHash) {
      if (replace) window.history.replaceState(null, '', nextHash);
      else window.location.hash = nextHash;
    }
    setActiveSlug(slug);
  };

  useEffect(() => {
    let alive = true;
    const loader = window.showPageLoader?.() || Promise.resolve();
    const applyDocument = (remoteDocument, metadata = {}) => {
      if (!alive) return;
      const siteDocument = normaliseDocument(remoteDocument || DEFAULT_DOCUMENT);
      siteRef.current = siteDocument;
      setSite(siteDocument);
      setRemoteExists(Boolean(metadata.exists));
      setRemoteReady(!metadata.pending && !metadata.failed);
      const requestedSlug = readHashSlug();
      const initialSlug = siteDocument.pages.some((page) => page.slug === requestedSlug) ? requestedSlug : 'intro';
      if (requestedSlug !== initialSlug) window.history.replaceState(null, '', hashFor(initialSlug));
      setActiveSlug(initialSlug);
      document.body.classList.add('app-ready');
    };
    let unsubscribeSite = () => {};
    try {
      if (CloudStore?.subscribeToDocument) {
        unsubscribeSite = CloudStore.subscribeToDocument(applyDocument, (error) => {
          reportError(error);
          applyDocument(DEFAULT_DOCUMENT, { exists: false, failed: true });
        });
      } else {
        applyDocument(DEFAULT_DOCUMENT, { exists: false });
      }
    } catch (error) {
      reportError(error);
      applyDocument(DEFAULT_DOCUMENT, { exists: false });
    }
    Promise.resolve(loader).catch(() => undefined).then(() => {
      if (!alive) return;
      setIsLoading(false);
      setJourneyRunId((value) => value + 1);
    });
    return () => {
      alive = false;
      unsubscribeSite();
      window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!CloudStore?.onAuthStateChange) return undefined;
    return CloudStore.onAuthStateChange((nextAuthState) => {
      setAuthState(nextAuthState || EMPTY_AUTH_STATE);
      if (!nextAuthState?.isEditor) setMode('presentation');
    });
  }, []);

  const routeKey = site ? site.pages.map((page) => `${page.id}:${page.slug}`).join('|') : '';
  useEffect(() => {
    if (!site) return undefined;
    const syncRoute = () => {
      const current = siteRef.current;
      const requestedSlug = readHashSlug();
      const fallback = current.pages[0]?.slug || 'intro';
      const resolved = current.pages.some((page) => page.slug === requestedSlug) ? requestedSlug : fallback;
      if (requestedSlug !== resolved) window.history.replaceState(null, '', hashFor(resolved));
      if (resolved !== activeSlugRef.current) setIsLoading(true);
      setActiveSlug(resolved);
    };
    syncRoute();
    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, [routeKey]);

  const activePage = site?.pages.find((page) => page.slug === activeSlug) || site?.pages[0] || null;
  const activePageId = activePage?.id || '';
  const activeBranchKey = activePage?.branches.map((branch) => branch.id).join('|') || '';

  useEffect(() => {
    if (!activePage) return;
    if (!activePage.branches.some((branch) => branch.id === selectedBranchId)) setSelectedBranchId(activePage.branches[0]?.id || null);
  }, [activePageId, activeBranchKey]);

  useEffect(() => {
    if (!activePage) return;
    if (initialRouteRef.current) {
      initialRouteRef.current = false;
      return;
    }
    const transition = ++transitionRef.current;
    setIsLoading(true);
    const loader = window.showPageLoader?.() || Promise.resolve();
    Promise.resolve(loader).catch(() => undefined).then(() => {
      if (transition !== transitionRef.current) return;
      setIsLoading(false);
      setJourneyRunId((value) => value + 1);
    });
  }, [activeSlug, activePageId]);

  if (!site || !activePage) return <main className="app-boot">正在準備 Trouthy 網站...</main>;

  const selectedBranch = activePage.branches.find((branch) => branch.id === selectedBranchId) || activePage.branches[0] || null;
  const editing = mode === 'editor' && canEdit;

  const addPage = () => {
    const id = makeId('page');
    const next = commitDocument((document) => {
      const slug = uniqueSlug('new-page', new Set(document.pages.map((page) => page.slug)));
      document.pages.push({ id, slug, title: '新頁面', builtIn: false, layout: 'vertical', branches: [] });
      return document;
    });
    const page = next?.pages.find((item) => item.id === id);
    if (page) navigateTo(page.slug);
  };

  const updateCustomPageTitle = (pageId, title) => commitDocument((document) => {
    const page = document.pages.find((item) => item.id === pageId);
    if (page && !page.builtIn) page.title = String(title || '').trim() || page.title;
    return document;
  });

  const updateCustomPageSlug = (pageId, rawSlug) => {
    const current = siteRef.current;
    const page = current.pages.find((item) => item.id === pageId);
    if (!page || page.builtIn) return;
    const nextSlug = uniqueSlug(rawSlug, new Set(current.pages.filter((item) => item.id !== pageId).map((item) => item.slug)));
    commitDocument((document) => {
      const target = document.pages.find((item) => item.id === pageId);
      if (target) target.slug = nextSlug;
      return document;
    });
    if (page.slug === activeSlug) navigateTo(nextSlug, true);
  };

  const movePage = (pageId, direction) => commitDocument((document) => {
    const customIndexes = document.pages.map((page, index) => ({ page, index })).filter(({ page }) => !page.builtIn);
    const currentPosition = customIndexes.findIndex(({ page }) => page.id === pageId);
    const nextPosition = currentPosition + direction;
    if (currentPosition < 0 || nextPosition < 0 || nextPosition >= customIndexes.length) return document;
    const from = customIndexes[currentPosition].index;
    const to = customIndexes[nextPosition].index;
    [document.pages[from], document.pages[to]] = [document.pages[to], document.pages[from]];
    return document;
  });

  const deleteUnreferencedFirestoreImages = async (document, imageIds) => {
    const imageIdsToDelete = unreferencedFirestoreImageIds(document, imageIds);
    if (!imageIdsToDelete.length || !await lastSaveRef.current) return;
    try {
      await Promise.all(imageIdsToDelete.map((imageId) => CloudStore.deleteImage(imageId)));
    } catch (error) {
      reportError(error);
    }
  };

  const deletePage = async (pageId) => {
    const page = siteRef.current.pages.find((item) => item.id === pageId);
    if (!page || page.builtIn || !window.confirm(`確定要刪除 ${page.title} 及其所有分支內容嗎？`)) return;
    const imageIds = page.branches
      .filter((branch) => branch.imageProvider === 'firestore')
      .map((branch) => branch.imageId);
    const next = commitDocument((document) => {
      document.pages = document.pages.filter((item) => item.id !== pageId);
      return document;
    });
    if (!next) return;
    await deleteUnreferencedFirestoreImages(next, imageIds);
    if (page.slug === activeSlug) navigateTo('intro');
  };

  const addBranch = (pageId) => {
    const branchId = makeId('branch');
    commitDocument((document) => {
      const page = document.pages.find((item) => item.id === pageId);
      if (page) page.branches.push({ id: branchId, title: '', body: '', imageId: null, imagePath: null, imageProvider: null, imageUrl: '', ctaLabel: '', ctaUrl: '' });
      return document;
    });
    setSelectedBranchId(branchId);
  };

  const updateBranch = (pageId, branchId, changes) => commitDocument((document) => {
    const branch = document.pages.find((page) => page.id === pageId)?.branches.find((item) => item.id === branchId);
    if (branch) Object.assign(branch, changes);
    return document;
  });

  const moveBranch = (pageId, branchId, direction) => commitDocument((document) => {
    const branches = document.pages.find((page) => page.id === pageId)?.branches;
    if (!branches) return document;
    const currentIndex = branches.findIndex((branch) => branch.id === branchId);
    const nextIndex = currentIndex + direction;
    if (currentIndex >= 0 && nextIndex >= 0 && nextIndex < branches.length) [branches[currentIndex], branches[nextIndex]] = [branches[nextIndex], branches[currentIndex]];
    return document;
  });

  const deleteBranch = async (pageId, branchId) => {
    const branch = siteRef.current.pages.find((page) => page.id === pageId)?.branches.find((item) => item.id === branchId);
    if (!branch || !window.confirm(`確定要刪除 ${branch.title || '此分支'} 嗎？`)) return;
    const next = commitDocument((document) => {
      const page = document.pages.find((item) => item.id === pageId);
      if (page) page.branches = page.branches.filter((item) => item.id !== branchId);
      return document;
    });
    if (!next) return;
    if (branch.imageProvider === 'firestore') await deleteUnreferencedFirestoreImages(next, [branch.imageId]);
  };

  const uploadBranchImage = async (pageId, branchId, file) => {
    const previousImage = siteRef.current.pages.find((page) => page.id === pageId)?.branches.find((branch) => branch.id === branchId);
    try {
      const image = await CloudStore.uploadImage(file);
      const exists = siteRef.current.pages.find((page) => page.id === pageId)?.branches.some((branch) => branch.id === branchId);
      if (!exists) {
        await CloudStore.deleteImage(image.imageId);
        return { saved: false };
      }
      const next = updateBranch(pageId, branchId, {
        imageId: image.imageId,
        imagePath: null,
        imageProvider: image.imageProvider,
        imageUrl: image.imageUrl
      });
      if (next && await lastSaveRef.current) {
        if (previousImage?.imageProvider === 'firestore') await deleteUnreferencedFirestoreImages(next, [previousImage.imageId]);
        return { saved: true };
      }
      await CloudStore.deleteImage(image.imageId);
      return { saved: false };
    } catch (error) {
      reportError(error);
      return {
        saved: false,
        message: messageForError(error)
      };
    }
  };

  const removeBranchImage = async (pageId, branchId) => {
    const branch = siteRef.current.pages.find((page) => page.id === pageId)?.branches.find((item) => item.id === branchId);
    if (!branch) return;
    const next = updateBranch(pageId, branchId, { imageId: null, imagePath: null, imageProvider: null, imageUrl: '' });
    if (next && branch.imageProvider === 'firestore') await deleteUnreferencedFirestoreImages(next, [branch.imageId]);
  };

  const resetSite = async () => {
    if (!window.confirm('確定要為所有訪客重設全部共享頁面與分支內容嗎？')) return;
    const imageIds = siteRef.current.pages
      .flatMap((page) => page.branches)
      .filter((branch) => branch.imageProvider === 'firestore')
      .map((branch) => branch.imageId);
    const next = commitDocument(() => copy(DEFAULT_DOCUMENT));
    if (!next) return;
    await deleteUnreferencedFirestoreImages(next, imageIds);
    navigateTo('intro', true);
    setSelectedBranchId(null);
    setStorageError('');
  };

  const importLocalDraft = async () => {
    if (!canEdit || remoteExists || !remoteReady || !LocalStore) return;
    if (!window.confirm('確定要將此瀏覽器的本機草稿匯入成第一個共享 Trouthy 網站嗎？')) return;
    try {
      setStorageError('');
      setSaveState('正在匯入本機草稿...');
      const localDocument = normaliseDocument(await LocalStore.loadDocument(DEFAULT_DOCUMENT, migrateLegacyDocument));
      let discardedLocalImageCount = 0;
      for (const page of localDocument.pages) {
        for (const branch of page.branches) {
          if (!branch.imageId) continue;
          discardedLocalImageCount += 1;
          branch.imageId = null;
          branch.imagePath = null;
          branch.imageProvider = null;
          branch.imageUrl = '';
        }
      }
      await CloudStore.seedDocument(localDocument);
      setSaveState(discardedLocalImageCount ? '已為所有訪客儲存。本機照片未匯入，請重新上傳照片。' : '已為所有訪客儲存');
    } catch (error) {
      reportError(error);
      setSaveState('未儲存');
    }
  };

  const signIn = async () => {
    try {
      setStorageError('');
      await CloudStore.signIn();
    } catch (error) {
      reportError(error);
    }
  };

  const signOut = async () => {
    try {
      await CloudStore.signOut();
      setMode('presentation');
    } catch (error) {
      reportError(error);
    }
  };

  const openJourneyBranch = (branchId) => {
    setSelectedBranchId(branchId);
    window.requestAnimationFrame(() => {
      branchCopyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return <div className={`site-app ${editing ? 'is-editing' : ''}`}>
    <header className={`site-header ${headerMinimized ? 'is-minimized' : ''}`}>
      <div className="header-top">
        <button className="brand" type="button" onClick={() => navigateTo('intro')} aria-label="前往簡介">
          <img className="brand-mark" src="icon.png" alt="" width="34" height="34" />
          <span><strong>Trouthy</strong></span>
        </button>
        <div className="header-actions">
          <div className="account-controls">
            {canEdit && <div className="mode-switch" role="group" aria-label="網站模式">
              <button className={mode === 'presentation' ? 'is-active' : ''} type="button" onClick={() => setMode('presentation')} aria-pressed={mode === 'presentation'}>瀏覽</button>
              <button className={mode === 'editor' ? 'is-active' : ''} type="button" onClick={() => setMode('editor')} aria-pressed={mode === 'editor'}>編輯</button>
            </div>}
            {authState.user ? <>
              <span className={`account-identity ${canEdit ? 'is-editor' : ''}`} title={authState.user.email}>{authState.user.email}</span>
              <button className="text-button account-sign-out" type="button" onClick={signOut}>登出</button>
            </> : authState.configured ? <button className="account-button" type="button" onClick={signIn}>團隊登入</button> : <span className="account-note" title={authState.setupError}>需要完成團隊編輯設定</span>}
          </div>
        </div>
        <button className="header-toggle" type="button" title={headerMinimized ? '還原標頭' : '縮小標頭'} aria-label={headerMinimized ? '還原標頭' : '縮小標頭'} aria-controls="site-pages" aria-expanded={!headerMinimized} onClick={() => setHeaderMinimized((minimized) => !minimized)}>{headerMinimized ? '+' : '\u2212'}</button>
      </div>
      <nav className="site-nav" id="site-pages" aria-label="頁面">
        {site.pages.map((page) => <button key={page.id} type="button" className={page.slug === activeSlug ? 'is-active' : ''} aria-current={page.slug === activeSlug ? 'page' : undefined} onClick={() => navigateTo(page.slug)}>{page.title}</button>)}
      </nav>
    </header>
    <main className="site-main">
      {(storageError || saveState) && <div className={`save-status ${storageError ? 'has-error' : ''}`} role={storageError ? 'alert' : 'status'}>
        <span>{storageError || saveState}</span>
        {storageError && <button type="button" className="icon-button" title="關閉訊息" aria-label="關閉訊息" onClick={() => setStorageError('')}>&times;</button>}
      </div>}
      {!authState.configured && <aside className="access-notice" role="status">完成 Firebase 設定後，即可使用團隊編輯功能。</aside>}
      {authState.configured && authState.user && !canEdit && <aside className="access-notice" role="status">此 Google 帳號可瀏覽 Trouthy，但尚未獲准編輯。</aside>}
      {editing && <div className="editor-workspace">
        <div className="editor-workspace-header">
          <div><p className="eyebrow">編輯器</p><h1>建立你的路線</h1></div>
          <div className="editor-meta">
            <span>變更會立即顯示給所有訪客。</span>
            {!remoteExists && remoteReady && LocalStore && <button className="text-button" type="button" onClick={importLocalDraft}>匯入本機草稿</button>}
            <button className="icon-button" type="button" title="重設共享網站" aria-label="重設共享網站" onClick={resetSite}>&#8635;</button>
          </div>
        </div>
        <PageManager pages={site.pages} activeSlug={activeSlug} onNavigate={navigateTo} onAddPage={addPage} onUpdateTitle={updateCustomPageTitle} onUpdateSlug={updateCustomPageSlug} onMovePage={movePage} onDeletePage={deletePage} />
        <BranchEditor page={activePage} selectedBranchId={selectedBranchId} onSelectBranch={setSelectedBranchId} onAddBranch={addBranch} onUpdateBranch={updateBranch} onMoveBranch={moveBranch} onDeleteBranch={deleteBranch} onUploadImage={uploadBranchImage} onRemoveImage={removeBranchImage} reportError={reportError} />
      </div>}
      <section className="route-title-band">
        <h1>{activePage.title}</h1>
        <span>{activePage.branches.length} 個分支</span>
      </section>
      {!isLoading && <RouteJourney key={`${activePage.id}-${journeyRunId}`} page={activePage} selectedBranchId={selectedBranchId} onSelectBranch={setSelectedBranchId} onOpenBranch={openJourneyBranch} runId={journeyRunId} />}
      <BranchSlide branch={selectedBranch} branches={activePage.branches} onSelectBranch={setSelectedBranchId} copyRef={branchCopyRef} />
      <section className="page-closing-art" aria-label="Trouthy 結尾插圖">
        <img src="trouthy-closing-art.png" alt="Trouthy 插圖：引擎在軌道上，Trouthy 與你同行。" loading="lazy" />
      </section>
    </main>
    <footer className="site-footer">Trouthy</footer>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);