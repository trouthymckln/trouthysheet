(() => {
  const config = window.TrouthyFirebaseConfig || {};
  const requiredFields = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const isConfigured = requiredFields.every((field) => {
    const value = String(config[field] || '').trim();
    return value && !/paste|your_project/i.test(value);
  });
  const siteId = String(config.siteId || 'trouthy').replace(/[^a-z0-9-]/gi, '') || 'trouthy';
  const editorEmails = new Set((Array.isArray(config.editorEmails) ? config.editorEmails : [])
    .map((email) => String(email || '').trim().toLowerCase())
    .filter(Boolean));
  const maxImageBytes = 8 * 1024 * 1024;
  const maxStoredImageCharacters = 700 * 1024;

  let auth = null;
  let database = null;
  let setupError = '';

  const makeError = (message, code) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };

  if (isConfigured && window.firebase) {
    try {
      const app = window.firebase.apps.length ? window.firebase.app() : window.firebase.initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId
      });
      auth = app.auth();
      database = app.firestore();
    } catch (error) {
      setupError = error?.message || '無法初始化 Firebase。';
    }
  } else if (!isConfigured) {
    setupError = '尚未完成共享編輯設定。';
  } else {
    setupError = '無法載入 Firebase 函式庫。';
  }

  const ready = () => Boolean(auth && database);
  const normaliseUser = (user) => user ? {
    uid: user.uid,
    email: String(user.email || '').toLowerCase(),
    displayName: user.displayName || user.email || '團隊成員',
    photoURL: user.photoURL || ''
  } : null;
  const isEditor = (user) => Boolean(user?.email && editorEmails.has(String(user.email).toLowerCase()));
  const currentAuthState = (user = auth?.currentUser || null) => ({
    configured: ready(),
    user: normaliseUser(user),
    isEditor: isEditor(user),
    setupError
  });
  const requireReady = () => {
    if (!ready()) throw makeError(setupError || '共享編輯功能目前無法使用。', 'trouthy/not-configured');
  };
  const requireEditor = () => {
    requireReady();
    if (!isEditor(auth.currentUser)) throw makeError('只有獲准的團隊帳號可以變更此網站。', 'trouthy/not-authorized');
  };
  const googleProvider = () => {
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return provider;
  };
  const siteRef = () => database.collection('sites').doc(siteId);
  const imageRef = (imageId) => siteRef().collection('images').doc(imageId);
  const imageIdsForDocument = (document) => new Set((document?.pages || [])
    .flatMap((page) => Array.isArray(page?.branches) ? page.branches : [])
    .filter((branch) => branch?.imageProvider === 'firestore' && branch.imageId)
    .map((branch) => branch.imageId));
  const hydrateDocumentImages = (document, imageUrls) => {
    if (!document) return null;
    return {
      ...document,
      pages: (document.pages || []).map((page) => ({
        ...page,
        branches: (page.branches || []).map((branch) => branch?.imageProvider === 'firestore' && branch.imageId
          ? { ...branch, imageUrl: imageUrls.get(branch.imageId) || '' }
          : branch)
      }))
    };
  };
  const documentForStorage = (document) => {
    const storedDocument = JSON.parse(JSON.stringify(document));
    for (const page of storedDocument.pages || []) {
      for (const branch of page.branches || []) {
        if (branch?.imageProvider === 'firestore') branch.imageUrl = '';
      }
    }
    return storedDocument;
  };
  const documentRecord = (document) => ({
    ...documentForStorage(document),
    updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: {
      uid: auth.currentUser.uid,
      email: auth.currentUser.email || '',
      name: auth.currentUser.displayName || auth.currentUser.email || ''
    }
  });
  const imageRecord = (dataUrl) => ({
    dataUrl,
    contentType: 'image/jpeg',
    updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: {
      uid: auth.currentUser.uid,
      email: auth.currentUser.email || '',
      name: auth.currentUser.displayName || auth.currentUser.email || ''
    }
  });
  const prepareImage = (file) => new Promise((resolve, reject) => {
    const objectUrl = window.URL.createObjectURL(file);
    const image = new window.Image();
    const releaseObjectUrl = () => window.URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      releaseObjectUrl();
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      if (!sourceWidth || !sourceHeight) {
        reject(makeError('無法讀取這張圖片。請選擇另一個檔案。', 'trouthy/image-processing-failed'));
        return;
      }
      let maximumDimension = Math.min(Math.max(sourceWidth, sourceHeight), 1600);
      let quality = 0.86;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const scale = Math.min(1, maximumDimension / Math.max(sourceWidth, sourceHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          reject(makeError('此瀏覽器無法處理圖片。', 'trouthy/image-processing-failed'));
          return;
        }
        let dataUrl = '';
        try {
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        } catch {
          reject(makeError('無法處理這張圖片。請選擇另一個檔案。', 'trouthy/image-processing-failed'));
          return;
        }
        if (dataUrl.length <= maxStoredImageCharacters) {
          resolve(dataUrl);
          return;
        }
        maximumDimension = Math.max(360, Math.round(maximumDimension * 0.78));
        quality = Math.max(0.45, quality - 0.08);
      }
      reject(makeError('這張圖片壓縮後仍然太大。請選擇較小的圖片。', 'trouthy/image-too-large'));
    };
    image.onerror = () => {
      releaseObjectUrl();
      reject(makeError('無法讀取這張圖片。請選擇另一個檔案。', 'trouthy/image-processing-failed'));
    };
    image.src = objectUrl;
  });

  window.TrouthyCloudStore = Object.freeze({
    siteId,
    maxImageBytes,
    isConfigured: ready,
    getAuthState: currentAuthState,

    onAuthStateChange(listener) {
      if (!ready()) {
        listener(currentAuthState(null));
        return () => {};
      }
      return auth.onAuthStateChanged((user) => listener(currentAuthState(user)));
    },

    async signIn() {
      requireReady();
      await auth.signInWithPopup(googleProvider());
    },

    async signOut() {
      requireReady();
      await auth.signOut();
    },

    subscribeToDocument(onValue, onError) {
      if (!ready()) {
        onValue(null, { exists: false, configured: false });
        return () => {};
      }
      // Render the public shell immediately while Firestore establishes its first listener.
      onValue(null, { exists: false, configured: true, pending: true });
      let remoteDocument = null;
      let metadata = { exists: false, configured: true };
      const imageUrls = new Map();
      const imageUnsubscribers = new Map();
      const notify = () => onValue(hydrateDocumentImages(remoteDocument, imageUrls), metadata);
      const syncImageSubscriptions = () => {
        const imageIds = imageIdsForDocument(remoteDocument);
        for (const [imageId, unsubscribe] of imageUnsubscribers) {
          if (imageIds.has(imageId)) continue;
          unsubscribe();
          imageUnsubscribers.delete(imageId);
          imageUrls.delete(imageId);
        }
        for (const imageId of imageIds) {
          if (imageUnsubscribers.has(imageId)) continue;
          const unsubscribe = imageRef(imageId).onSnapshot((snapshot) => {
            const dataUrl = snapshot.exists ? String(snapshot.data()?.dataUrl || '') : '';
            if (dataUrl.startsWith('data:image/')) imageUrls.set(imageId, dataUrl);
            else imageUrls.delete(imageId);
            notify();
          }, () => {
            imageUrls.delete(imageId);
            notify();
          });
          imageUnsubscribers.set(imageId, unsubscribe);
        }
      };
      const unsubscribeSite = siteRef().onSnapshot((snapshot) => {
        remoteDocument = snapshot.exists ? snapshot.data() : null;
        metadata = { exists: snapshot.exists, configured: true };
        syncImageSubscriptions();
        notify();
      }, onError);
      return () => {
        unsubscribeSite();
        imageUnsubscribers.forEach((unsubscribe) => unsubscribe());
      };
    },

    async saveDocument(document) {
      requireEditor();
      await siteRef().set(documentRecord(document), { merge: true });
    },

    async seedDocument(document) {
      requireEditor();
      await database.runTransaction(async (transaction) => {
        const existing = await transaction.get(siteRef());
        if (existing.exists) throw makeError('共享 Trouthy 網站已存在。匯入前請重新整理。', 'trouthy/site-exists');
        transaction.set(siteRef(), documentRecord(document));
      });
    },

    async uploadImage(file) {
      requireEditor();
      if (!(file instanceof Blob) || !String(file.type || '').startsWith('image/')) {
        throw makeError('請為此分支選擇圖片檔案。', 'trouthy/not-image');
      }
      if (file.size > maxImageBytes) {
        throw makeError('請選擇小於 8 MB 的圖片。', 'trouthy/image-too-large');
      }
      const dataUrl = await prepareImage(file);
      const image = imageRef();
      await image.set(imageRecord(dataUrl));
      return { imageId: image.id, imageProvider: 'firestore', imageUrl: dataUrl };
    },

    async deleteImage(imageId) {
      if (!imageId) return;
      requireEditor();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(imageId)) return;
      await imageRef(imageId).delete();
    }
  });
})();