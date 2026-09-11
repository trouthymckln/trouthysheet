(() => {
  const DATABASE_NAME = 'trouthy-hub-site';
  const DATABASE_VERSION = 1;
  const DOCUMENT_STORE = 'documents';
  const IMAGE_STORE = 'images';
  const DOCUMENT_ID = 'site';
  const LEGACY_STORAGE_KEY = 'student_union_data';
  let databasePromise;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const createId = () => window.crypto?.randomUUID?.() || `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const openDatabase = () => {
    if (databasePromise) return databasePromise;
    if (!window.indexedDB) return Promise.reject(new Error('This browser does not support persistent browser storage.'));

    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DOCUMENT_STORE)) database.createObjectStore(DOCUMENT_STORE, { keyPath: 'id' });
        if (!database.objectStoreNames.contains(IMAGE_STORE)) database.createObjectStore(IMAGE_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open browser storage.'));
      request.onblocked = () => reject(new Error('Browser storage is blocked by another open tab.'));
    });
    return databasePromise;
  };

  const readRecord = async (storeName, key) => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Unable to read browser storage.'));
    });
  };

  const writeRecord = async (storeName, record) => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = () => resolve(record);
      transaction.onerror = () => reject(transaction.error || new Error('Unable to save browser storage.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saving to browser storage was cancelled.'));
    });
  };

  const deleteRecords = async (storeName, ids) => {
    const values = [...new Set(ids.filter(Boolean))];
    if (!values.length) return;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      values.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Unable to remove browser storage.'));
      transaction.onabort = () => reject(transaction.error || new Error('Removing browser storage was cancelled.'));
    });
  };

  const readLegacyDocument = () => {
    try {
      const value = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  };

  window.SiteStore = Object.freeze({
    async loadDocument(defaultDocument, migrateLegacy) {
      const stored = await readRecord(DOCUMENT_STORE, DOCUMENT_ID);
      if (stored?.value) return stored.value;

      const legacyDocument = readLegacyDocument();
      const document = legacyDocument && migrateLegacy
        ? migrateLegacy(legacyDocument, clone(defaultDocument))
        : clone(defaultDocument);
      await this.saveDocument(document);
      return document;
    },

    async saveDocument(document) {
      await writeRecord(DOCUMENT_STORE, { id: DOCUMENT_ID, value: clone(document), updatedAt: Date.now() });
    },

    async putImage(file) {
      if (!(file instanceof Blob)) throw new Error('Choose a valid image file before saving.');
      const record = {
        id: createId(),
        blob: file,
        name: file.name || 'uploaded-image',
        type: file.type || 'image/*',
        updatedAt: Date.now()
      };
      await writeRecord(IMAGE_STORE, record);
      return record.id;
    },

    async getImage(imageId) {
      return readRecord(IMAGE_STORE, imageId);
    },

    async deleteImage(imageId) {
      return deleteRecords(IMAGE_STORE, [imageId]);
    },

    async deleteImages(imageIds) {
      return deleteRecords(IMAGE_STORE, imageIds);
    },

    async storageEstimate() {
      if (!navigator.storage?.estimate) return null;
      return navigator.storage.estimate();
    },

    async reset() {
      const database = await openDatabase();
      await Promise.all([DOCUMENT_STORE, IMAGE_STORE].map((storeName) => new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Unable to reset browser storage.'));
      })));
    }
  });
})();