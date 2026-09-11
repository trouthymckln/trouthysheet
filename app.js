const { useEffect, useRef, useState } = React;

const LocalStore = window.SiteStore;
const CloudStore = window.TrouthyCloudStore;
const MAX_IMAGE_BYTES = CloudStore?.maxImageBytes || 8 * 1024 * 1024;
const EMPTY_AUTH_STATE = {
  configured: false,
  user: null,
  isEditor: false,
  setupError: 'Shared editing has not been configured yet.'
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
      id: 'page-intro', slug: 'intro', title: 'Intro', builtIn: true, layout: 'vertical', branches: []
    },
    {
      id: 'page-events', slug: 'events', title: 'Events', builtIn: true, layout: 'vertical', branches: []
    },
    {
      id: 'page-policy', slug: 'policy', title: 'Policy', builtIn: true, layout: 'vertical', branches: []
    },
    {
      id: 'page-welfare', slug: 'welfare', title: 'Welfare', builtIn: true, layout: 'vertical', branches: []
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

const unreferencedImagePaths = (document, imagePaths) => {
  const retainedPaths = new Set(document.pages
    .flatMap((page) => page.branches.map((branch) => branch.imagePath))
    .filter(Boolean));
  return [...new Set(imagePaths.filter((imagePath) => imagePath && !retainedPaths.has(imagePath)))];
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
  if (error?.code === 'trouthy/not-configured') return 'Shared editing needs Firebase setup before changes can be saved.';
  if (error?.code === 'trouthy/not-authorized' || error?.code === 'permission-denied' || error?.code === 'storage/unauthorized') return 'Only approved team accounts can change this site.';
  if (error?.code === 'auth/popup-closed-by-user') return 'Google sign-in was closed before it finished.';
  if (error?.code === 'storage/unauthenticated') return 'Sign in with an approved Google account before uploading a photo.';
  if (error?.name === 'QuotaExceededError') return 'Browser storage is full. Remove an image or free up browser storage, then try again.';
  return error?.message || 'The change could not be shared with everyone.';
};

function BranchImage({ branch, alt, className = '', compact = false }) {
  const [failed, setFailed] = useState(false);
  const source = branch.imageUrl;

  useEffect(() => setFailed(false), [source]);

  if (!source || failed) {
    return <div className={`image-placeholder ${compact ? 'image-placeholder-compact' : ''} ${className}`}>Photo ready for your story</div>;
  }

  return <img className={className} src={source} alt={alt} onError={() => setFailed(true)} />;
}

function PageManager({ pages, activeSlug, onNavigate, onAddPage, onUpdateTitle, onUpdateSlug, onMovePage, onDeletePage }) {
  const customPages = pages.filter((page) => !page.builtIn);

  return <section className="editor-section page-manager" aria-labelledby="page-manager-title">
    <div className="editor-section-heading">
      <div>
        <p className="eyebrow">Structure</p>
        <h2 id="page-manager-title">Pages</h2>
      </div>
      <button className="command-button command-primary" type="button" onClick={onAddPage}>+ New page</button>
    </div>
    <div className="page-list">
      {pages.map((page) => {
        const customPosition = customPages.findIndex((candidate) => candidate.id === page.id);
        const isCustom = !page.builtIn;
        return <article className={`page-row ${page.slug === activeSlug ? 'is-active' : ''}`} key={page.id}>
          <button className="page-open" type="button" onClick={() => onNavigate(page.slug)} aria-current={page.slug === activeSlug ? 'page' : undefined}>
            <span>{page.title}</span>
            <small>{page.builtIn ? 'Built in' : `#/${page.slug}`}</small>
          </button>
          {isCustom && <div className="page-fields">
            <label>Page name<input defaultValue={page.title} onBlur={(event) => onUpdateTitle(page.id, event.target.value)} /></label>
            <label>URL slug<input defaultValue={page.slug} onBlur={(event) => onUpdateSlug(page.id, event.target.value)} /></label>
          </div>}
          {isCustom && <div className="row-actions" aria-label={`Manage ${page.title}`}>
            <button className="icon-button" type="button" title="Move page earlier" aria-label="Move page earlier" disabled={customPosition <= 0} onClick={() => onMovePage(page.id, -1)}>&uarr;</button>
            <button className="icon-button" type="button" title="Move page later" aria-label="Move page later" disabled={customPosition === customPages.length - 1} onClick={() => onMovePage(page.id, 1)}>&darr;</button>
            <button className="icon-button danger" type="button" title="Delete page" aria-label="Delete page" onClick={() => onDeletePage(page.id)}>&times;</button>
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
      const message = 'Choose an image file for this branch.';
      setUploadError(message);
      reportError(message);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      const message = 'Choose an image smaller than 8 MB.';
      setUploadError(message);
      reportError(message);
      return;
    }
    setUploadError('');
    setUploading(true);
    const saved = await onUpload(file);
    if (!saved) setUploadError('The photo could not be shared. Check your connection and try again.');
    setUploading(false);
  };

  return <article className={`branch-editor-row ${selected ? 'is-selected' : ''}`}>
    <div className="branch-editor-number">{String(index + 1).padStart(2, '0')}</div>
    <button className="branch-editor-select" type="button" onClick={onSelect}>
      <BranchImage branch={branch} alt="" compact className="branch-thumbnail" />
      <span>{branch.title || 'Untitled branch'}</span>
    </button>
    <div className="branch-fields">
      <label>Title<input value={branch.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
      <label>Description<textarea value={branch.body} onChange={(event) => onChange({ body: event.target.value })} rows="3" /></label>
      <label>Button label<input value={branch.ctaLabel} placeholder="Optional button text" onChange={(event) => onChange({ ctaLabel: event.target.value })} /></label>
      <label>Button URL<input type="url" value={branch.ctaUrl} placeholder="https://example.com" onChange={(event) => onChange({ ctaUrl: event.target.value })} /></label>
      {!validUrl && <p className="field-warning">Use a full http:// or https:// link for the button.</p>}
      <div className="branch-image-actions">
        <label className="file-picker">
          <span>{uploading ? 'Saving photo...' : 'Upload photo'}</span>
          <input type="file" accept="image/*" onChange={chooseImage} disabled={uploading} />
        </label>
        {(branch.imageId || branch.imagePath || branch.imageUrl) && <button className="text-button" type="button" onClick={onRemoveImage}>Remove photo</button>}
      </div>
      {uploadError && <p className="field-warning" role="alert">{uploadError}</p>}
    </div>
    <div className="row-actions branch-actions" aria-label={`Manage ${branch.title || 'branch'}`}>
      <button className="icon-button" type="button" title="Move branch earlier" aria-label="Move branch earlier" disabled={index === 0} onClick={() => onMove(-1)}>&uarr;</button>
      <button className="icon-button" type="button" title="Move branch later" aria-label="Move branch later" disabled={index === total - 1} onClick={() => onMove(1)}>&darr;</button>
      <button className="icon-button danger" type="button" title="Delete branch" aria-label="Delete branch" onClick={onDelete}>&times;</button>
    </div>
  </article>;
}

function BranchEditor({ page, selectedBranchId, onSelectBranch, onAddBranch, onUpdateBranch, onMoveBranch, onDeleteBranch, onUploadImage, onRemoveImage, reportError }) {
  return <section className="editor-section branch-editor" aria-labelledby="branch-editor-title">
    <div className="editor-section-heading">
      <div>
        <p className="eyebrow">Route editor</p>
        <h2 id="branch-editor-title">{page.title} branches</h2>
      </div>
      <button className="command-button command-primary" type="button" onClick={() => onAddBranch(page.id)}>+ Add branch</button>
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
    </div> : <div className="empty-editor-state">No journey stops yet.</div>}
  </section>;
}

function createJourneyGeometry(branches) {
  const count = Math.max(branches.length, 1);
  const height = Math.max(560, 190 + count * 170);
  const startY = count === 1 ? Math.round(height / 2) : 118;
  const endY = height - 100;
  const step = count === 1 ? 0 : (endY - startY) / (count - 1);
  const routeX = 260;
  const cardX = 550;
  const stops = branches.map((branch, index) => ({
    id: branch.id,
    index,
    y: Math.round(startY + step * index),
    carX: routeX,
    cardX
  }));

  return {
    height,
    stops,
    carPath: `M ${routeX} 42 L ${routeX} ${height - 42}`,
    connectors: stops.map((stop) => `M ${routeX} ${stop.y} L ${stop.cardX} ${stop.y}`)
  };
}

function RouteJourney({ page, selectedBranchId, onSelectBranch, runId }) {
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
    return <section className="journey journey-empty" aria-label={`${page.title} route`}>
      <p>No branch slides have been added to this route yet.</p>
    </section>;
  }

  return <section className="journey journey-vertical" aria-labelledby="journey-title">
    <div className="journey-heading">
      <p className="eyebrow">Vertical journey</p>
      <h2 id="journey-title">Explore the route</h2>
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
        onClick={() => onSelectBranch(stop.id)}
        aria-pressed={selectedBranchId === stop.id}
      >
        <span>{String(index + 1).padStart(2, '0')}</span>
        <strong>{page.branches[index].title || 'Untitled branch'}</strong>
      </button>)}
    </div>
  </section>;
}

function BranchSlide({ branch, branches, onSelectBranch }) {
  if (!branch) return null;
  const index = branches.findIndex((candidate) => candidate.id === branch.id);
  const destination = normaliseUrl(branch.ctaUrl);
  const previous = branches[index - 1];
  const next = branches[index + 1];

  return <article className="branch-slide" aria-labelledby={`slide-title-${branch.id}`}>
    <div className="branch-slide-media"><BranchImage branch={branch} alt={branch.title || 'Branch image'} className="branch-slide-image" /></div>
    <div className="branch-slide-copy">
      <p className="slide-count">{String(index + 1).padStart(2, '0')} / {String(branches.length).padStart(2, '0')}</p>
      <h2 id={`slide-title-${branch.id}`}>{branch.title || 'Untitled branch'}</h2>
      {branch.body && <p>{branch.body}</p>}
      {destination && branch.ctaLabel && <a className="command-button command-primary" href={destination} target="_blank" rel="noreferrer">{branch.ctaLabel}</a>}
      <div className="slide-controls" aria-label="Branch slide controls">
        <button className="icon-button" type="button" title="Previous branch" aria-label="Previous branch" disabled={!previous} onClick={() => onSelectBranch(previous.id)}>&larr;</button>
        <span>Branch {index + 1} of {branches.length}</span>
        <button className="icon-button" type="button" title="Next branch" aria-label="Next branch" disabled={!next} onClick={() => onSelectBranch(next.id)}>&rarr;</button>
      </div>
    </div>
  </article>;
}

function App() {
  const [site, setSite] = useState(null);
  const [mode, setMode] = useState('presentation');
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

  siteRef.current = site;
  activeSlugRef.current = activeSlug;
  const canEdit = Boolean(authState.configured && authState.isEditor);

  const reportError = (error) => setStorageError(typeof error === 'string' ? error : messageForError(error));

  const persistDocument = (documentToSave) => {
    if (!canEdit || !CloudStore?.isConfigured?.()) {
      reportError('Only approved team accounts can change this site.');
      setSaveState('Not saved');
      return Promise.resolve(false);
    }
    const snapshot = copy(documentToSave);
    setSaveState('Saving for everyone...');
    const save = saveQueueRef.current
      .catch(() => undefined)
      .then(() => CloudStore.saveDocument(snapshot))
      .then(() => {
        setSaveState('Saved for everyone');
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => setSaveState(''), 1800);
        return true;
      })
      .catch((error) => {
        reportError(error);
        setSaveState('Not saved');
        return false;
      });
    saveQueueRef.current = save;
    lastSaveRef.current = save;
    return save;
  };

  const commitDocument = (updater) => {
    const current = siteRef.current;
    if (!current || !canEdit) {
      if (!canEdit) reportError('Only approved team accounts can change this site.');
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

  if (!site || !activePage) return <main className="app-boot">Preparing your Trouthy site...</main>;

  const selectedBranch = activePage.branches.find((branch) => branch.id === selectedBranchId) || activePage.branches[0] || null;
  const editing = mode === 'editor' && canEdit;

  const addPage = () => {
    const id = makeId('page');
    const next = commitDocument((document) => {
      const slug = uniqueSlug('new-page', new Set(document.pages.map((page) => page.slug)));
      document.pages.push({ id, slug, title: 'New page', builtIn: false, layout: 'vertical', branches: [] });
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

  const deletePage = async (pageId) => {
    const page = siteRef.current.pages.find((item) => item.id === pageId);
    if (!page || page.builtIn || !window.confirm(`Delete ${page.title} and all of its branch slides?`)) return;
    const imagePaths = page.branches.map((branch) => branch.imagePath).filter(Boolean);
    const next = commitDocument((document) => {
      document.pages = document.pages.filter((item) => item.id !== pageId);
      return document;
    });
    if (!next) return;
    const pathsToDelete = unreferencedImagePaths(next, imagePaths);
    if (pathsToDelete.length && await lastSaveRef.current) {
      try {
        await Promise.all(pathsToDelete.map((imagePath) => CloudStore.deleteImage(imagePath)));
      } catch (error) {
        reportError(error);
      }
    }
    if (page.slug === activeSlug) navigateTo('intro');
  };

  const addBranch = (pageId) => {
    const branchId = makeId('branch');
    commitDocument((document) => {
      const page = document.pages.find((item) => item.id === pageId);
      if (page) page.branches.push({ id: branchId, title: '', body: '', imageId: null, imagePath: null, imageUrl: '', ctaLabel: '', ctaUrl: '' });
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
    if (!branch || !window.confirm(`Delete ${branch.title || 'this branch'}?`)) return;
    const next = commitDocument((document) => {
      const page = document.pages.find((item) => item.id === pageId);
      if (page) page.branches = page.branches.filter((item) => item.id !== branchId);
      return document;
    });
    if (!next) return;
    const pathsToDelete = unreferencedImagePaths(next, [branch.imagePath]);
    if (pathsToDelete.length && await lastSaveRef.current) {
      try {
        await Promise.all(pathsToDelete.map((imagePath) => CloudStore.deleteImage(imagePath)));
      } catch (error) {
        reportError(error);
      }
    }
  };

  const uploadBranchImage = async (pageId, branchId, file) => {
    const previousImagePath = siteRef.current.pages.find((page) => page.id === pageId)?.branches.find((branch) => branch.id === branchId)?.imagePath;
    try {
      const image = await CloudStore.uploadImage(file);
      const exists = siteRef.current.pages.find((page) => page.id === pageId)?.branches.some((branch) => branch.id === branchId);
      if (!exists) {
        await CloudStore.deleteImage(image.imagePath);
        return false;
      }
      const next = updateBranch(pageId, branchId, { imageId: null, imagePath: image.imagePath, imageUrl: image.imageUrl });
      if (!next || !await lastSaveRef.current) return false;
      const pathsToDelete = unreferencedImagePaths(next, [previousImagePath]);
      if (pathsToDelete.length) await Promise.all(pathsToDelete.map((imagePath) => CloudStore.deleteImage(imagePath)));
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  const removeBranchImage = async (pageId, branchId) => {
    const branch = siteRef.current.pages.find((page) => page.id === pageId)?.branches.find((item) => item.id === branchId);
    if (!branch) return;
    const next = updateBranch(pageId, branchId, { imageId: null, imagePath: null, imageUrl: '' });
    if (!next) return;
    const pathsToDelete = unreferencedImagePaths(next, [branch.imagePath]);
    if (pathsToDelete.length && await lastSaveRef.current) {
      try {
        await Promise.all(pathsToDelete.map((imagePath) => CloudStore.deleteImage(imagePath)));
      } catch (error) {
        reportError(error);
      }
    }
  };

  const resetSite = async () => {
    if (!window.confirm('Reset every shared page, branch, and uploaded photo for all visitors?')) return;
    const imagePaths = siteRef.current.pages.flatMap((page) => page.branches.map((branch) => branch.imagePath)).filter(Boolean);
    const next = commitDocument(() => copy(DEFAULT_DOCUMENT));
    if (!next) return;
    navigateTo('intro', true);
    setSelectedBranchId(null);
    setStorageError('');
    const pathsToDelete = unreferencedImagePaths(next, imagePaths);
    if (pathsToDelete.length && await lastSaveRef.current) {
      try {
        await Promise.all(pathsToDelete.map((imagePath) => CloudStore.deleteImage(imagePath)));
      } catch (error) {
        reportError(error);
      }
    }
  };

  const importLocalDraft = async () => {
    if (!canEdit || remoteExists || !remoteReady || !LocalStore) return;
    if (!window.confirm('Import this browser\'s existing local draft as the first shared Trouthy site?')) return;
    try {
      setStorageError('');
      setSaveState('Importing local draft...');
      const localDocument = normaliseDocument(await LocalStore.loadDocument(DEFAULT_DOCUMENT, migrateLegacyDocument));
      for (const page of localDocument.pages) {
        for (const branch of page.branches) {
          if (!branch.imageId) continue;
          const localImage = await LocalStore.getImage(branch.imageId);
          if (!localImage?.blob) {
            branch.imageId = null;
            continue;
          }
          const image = await CloudStore.uploadImage(localImage.blob);
          branch.imageId = null;
          branch.imagePath = image.imagePath;
          branch.imageUrl = image.imageUrl;
        }
      }
      await CloudStore.seedDocument(localDocument);
      setSaveState('Saved for everyone');
    } catch (error) {
      reportError(error);
      setSaveState('Not saved');
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

  return <div className={`site-app ${editing ? 'is-editing' : ''}`}>
    <header className="site-header">
      <div className="header-top">
        <button className="brand" type="button" onClick={() => navigateTo('intro')} aria-label="Go to Intro">
          <img className="brand-mark" src="icon.png" alt="" width="34" height="34" />
          <span><strong>Trouthy</strong></span>
        </button>
        <div className="account-controls">
          {canEdit && <div className="mode-switch" role="group" aria-label="Site mode">
            <button className={mode === 'presentation' ? 'is-active' : ''} type="button" onClick={() => setMode('presentation')} aria-pressed={mode === 'presentation'}>View</button>
            <button className={mode === 'editor' ? 'is-active' : ''} type="button" onClick={() => setMode('editor')} aria-pressed={mode === 'editor'}>Edit</button>
          </div>}
          {authState.user ? <>
            <span className={`account-identity ${canEdit ? 'is-editor' : ''}`} title={authState.user.email}>{authState.user.email}</span>
            <button className="text-button account-sign-out" type="button" onClick={signOut}>Sign out</button>
          </> : authState.configured ? <button className="account-button" type="button" onClick={signIn}>Team sign in</button> : <span className="account-note" title={authState.setupError}>Team editing setup required</span>}
        </div>
      </div>
      <nav className="site-nav" aria-label="Pages">
        {site.pages.map((page) => <button key={page.id} type="button" className={page.slug === activeSlug ? 'is-active' : ''} aria-current={page.slug === activeSlug ? 'page' : undefined} onClick={() => navigateTo(page.slug)}>{page.title}</button>)}
      </nav>
    </header>
    <main className="site-main">
      {(storageError || saveState) && <div className={`save-status ${storageError ? 'has-error' : ''}`} role={storageError ? 'alert' : 'status'}>
        <span>{storageError || saveState}</span>
        {storageError && <button type="button" className="icon-button" title="Dismiss message" aria-label="Dismiss message" onClick={() => setStorageError('')}>&times;</button>}
      </div>}
      {!authState.configured && <aside className="access-notice" role="status">Team editing will be available after Firebase is configured.</aside>}
      {authState.configured && authState.user && !canEdit && <aside className="access-notice" role="status">This Google account can view Trouthy, but it is not approved to edit.</aside>}
      {editing && <div className="editor-workspace">
        <div className="editor-workspace-header">
          <div><p className="eyebrow">Editor</p><h1>Build your route</h1></div>
          <div className="editor-meta">
            <span>Changes appear for everyone immediately.</span>
            {!remoteExists && remoteReady && LocalStore && <button className="text-button" type="button" onClick={importLocalDraft}>Import local draft</button>}
            <button className="text-button" type="button" onClick={resetSite}>Reset shared site</button>
          </div>
        </div>
        <PageManager pages={site.pages} activeSlug={activeSlug} onNavigate={navigateTo} onAddPage={addPage} onUpdateTitle={updateCustomPageTitle} onUpdateSlug={updateCustomPageSlug} onMovePage={movePage} onDeletePage={deletePage} />
        <BranchEditor page={activePage} selectedBranchId={selectedBranchId} onSelectBranch={setSelectedBranchId} onAddBranch={addBranch} onUpdateBranch={updateBranch} onMoveBranch={moveBranch} onDeleteBranch={deleteBranch} onUploadImage={uploadBranchImage} onRemoveImage={removeBranchImage} reportError={reportError} />
      </div>}
      <section className="route-title-band">
        <p className="eyebrow">{activePage.builtIn ? 'Trouthy route' : 'Custom route'}</p>
        <h1>{activePage.title}</h1>
        <span>{activePage.branches.length} branch{activePage.branches.length === 1 ? '' : 'es'}</span>
      </section>
      {!isLoading && <RouteJourney key={`${activePage.id}-${journeyRunId}`} page={activePage} selectedBranchId={selectedBranchId} onSelectBranch={setSelectedBranchId} runId={journeyRunId} />}
      <BranchSlide branch={selectedBranch} branches={activePage.branches} onSelectBranch={setSelectedBranchId} />
    </main>
    <footer className="site-footer">Trouthy</footer>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);