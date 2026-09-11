(() => {
  const config = window.TrouthyFirebaseConfig || {};
  const requiredFields = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'appId'];
  const isConfigured = requiredFields.every((field) => {
    const value = String(config[field] || '').trim();
    return value && !/paste|your_project/i.test(value);
  });
  const siteId = String(config.siteId || 'trouthy').replace(/[^a-z0-9-]/gi, '') || 'trouthy';
  const editorEmails = new Set((Array.isArray(config.editorEmails) ? config.editorEmails : [])
    .map((email) => String(email || '').trim().toLowerCase())
    .filter(Boolean));
  const maxImageBytes = 8 * 1024 * 1024;

  let auth = null;
  let database = null;
  let storage = null;
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
        storageBucket: config.storageBucket,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId
      });
      auth = app.auth();
      database = app.firestore();
      storage = app.storage();
    } catch (error) {
      setupError = error?.message || 'Firebase could not be initialized.';
    }
  } else if (!isConfigured) {
    setupError = 'Shared editing has not been configured yet.';
  } else {
    setupError = 'Firebase libraries could not be loaded.';
  }

  const ready = () => Boolean(auth && database && storage);
  const normaliseUser = (user) => user ? {
    uid: user.uid,
    email: String(user.email || '').toLowerCase(),
    displayName: user.displayName || user.email || 'Team member',
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
    if (!ready()) throw makeError(setupError || 'Shared editing is unavailable.', 'trouthy/not-configured');
  };
  const requireEditor = () => {
    requireReady();
    if (!isEditor(auth.currentUser)) throw makeError('Only approved team accounts can change this site.', 'trouthy/not-authorized');
  };
  const siteRef = () => database.collection('sites').doc(siteId);
  const documentRecord = (document) => ({
    ...JSON.parse(JSON.stringify(document)),
    updatedAt: window.firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: {
      uid: auth.currentUser.uid,
      email: auth.currentUser.email || '',
      name: auth.currentUser.displayName || auth.currentUser.email || ''
    }
  });
  const imagePathFor = (file) => {
    const filename = String(file.name || 'image').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(-64) || 'image';
    const id = window.crypto?.randomUUID?.() || `image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `sites/${siteId}/images/${id}-${filename}`;
  };

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
      const provider = new window.firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await auth.signInWithPopup(provider);
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
      return siteRef().onSnapshot((snapshot) => {
        onValue(snapshot.exists ? snapshot.data() : null, { exists: snapshot.exists, configured: true });
      }, onError);
    },

    async saveDocument(document) {
      requireEditor();
      await siteRef().set(documentRecord(document), { merge: true });
    },

    async seedDocument(document) {
      requireEditor();
      await database.runTransaction(async (transaction) => {
        const existing = await transaction.get(siteRef());
        if (existing.exists) throw makeError('A shared Trouthy site already exists. Refresh before importing.', 'trouthy/site-exists');
        transaction.set(siteRef(), documentRecord(document));
      });
    },

    async uploadImage(file) {
      requireEditor();
      if (!(file instanceof Blob) || !String(file.type || '').startsWith('image/')) {
        throw makeError('Choose an image file for this branch.', 'trouthy/not-image');
      }
      if (file.size > maxImageBytes) {
        throw makeError('Choose an image smaller than 8 MB.', 'trouthy/image-too-large');
      }
      const imagePath = imagePathFor(file);
      const reference = storage.ref().child(imagePath);
      await reference.put(file, { contentType: file.type || 'image/*' });
      return { imagePath, imageUrl: await reference.getDownloadURL() };
    },

    async deleteImage(imagePath) {
      if (!imagePath) return;
      requireEditor();
      try {
        await storage.ref().child(imagePath).delete();
      } catch (error) {
        if (error?.code !== 'storage/object-not-found') throw error;
      }
    }
  });
})();