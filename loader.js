(() => {
  let closeTimer, removeTimer, loaderPromise, finishLoading;
  window.isLoading = true;
  window.showPageLoader = () => {
    if (window.isLoading && loaderPromise) return loaderPromise;
    document.getElementById('loading-screen')?.remove();
    window.clearTimeout(closeTimer);
    window.clearTimeout(removeTimer);
    window.isLoading = true;
    loaderPromise = new Promise((resolve) => { finishLoading = resolve; });
    const overlay = document.createElement('section');
    overlay.id = 'loading-screen';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff;opacity:1;transition:opacity 500ms ease;';
    const fallback = document.createElement('div');
    fallback.setAttribute('aria-label', 'Loading');
    fallback.style.cssText = 'position:absolute;width:3.5rem;height:3.5rem;border:4px solid #e5d4c5;border-top-color:#8c2727;border-radius:50%;animation:loader-spin .8s linear infinite;';
    const badge = document.createElement('video');
    badge.autoplay = true;
    badge.loop = true;
    badge.muted = true;
    badge.defaultMuted = true;
    badge.playsInline = true;
    badge.preload = 'auto';
    badge.setAttribute('autoplay', '');
    badge.setAttribute('loop', '');
    badge.setAttribute('muted', '');
    badge.setAttribute('playsinline', '');
    badge.className = 'w-52 h-52 object-contain mx-auto';
    badge.src = './loading.mp4';
    badge.style.cssText = 'position:relative;width:13rem;height:13rem;object-fit:contain;margin:0 auto;';
    badge.setAttribute('aria-label', 'Trouthy loading');
    const loadingLabel = document.createElement('p');
    loadingLabel.className = 'loading-label';
    loadingLabel.append('Loading');
    [0, 1, 2].forEach((index) => {
      const dot = document.createElement('span');
      dot.className = 'loading-dot';
      dot.style.animationDelay = `${index * 0.14}s`;
      dot.textContent = '.';
      loadingLabel.append(dot);
    });
    const playVideo = () => badge.play().catch((err) => {
      if (err.name !== 'AbortError') console.error('Autoplay blocked or file missing:', err);
      fallback.style.display = 'block';
    });
    badge.addEventListener('canplay', playVideo, { once: true });
    badge.addEventListener('playing', () => { fallback.style.display = 'none'; });
    badge.addEventListener('pause', () => {
      if (window.isLoading && badge.currentTime === 0) fallback.style.display = 'block';
    });
    badge.addEventListener('error', () => { badge.style.display = 'none'; fallback.style.display = 'block'; });
    overlay.append(fallback);
    overlay.append(badge);
    overlay.append(loadingLabel);
    document.body.prepend(overlay);
    const video = document.querySelector('#loading-screen video');
    if (video) playVideo();
    closeTimer = window.setTimeout(() => {
      badge.pause?.();
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
      window.isLoading = false;
      removeTimer = window.setTimeout(() => {
        overlay.remove();
        finishLoading?.();
      }, 500);
    }, 3000);
    return loaderPromise;
  };
  const style = document.createElement('style');
  style.textContent = '@keyframes loader-spin{to{transform:rotate(360deg)}}@keyframes loader-dot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}.loading-label{display:flex;margin:1rem 0 0;color:#182c3a;font-family:"DM Sans",sans-serif;font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.loading-dot{display:inline-block;animation:loader-dot .9s ease-in-out infinite}';
  document.head.append(style);
  document.addEventListener('DOMContentLoaded', window.showPageLoader);
})();
