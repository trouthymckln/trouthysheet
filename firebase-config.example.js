(() => {
  // Copy this file to firebase-config.js and replace each value from Firebase Console.
  window.TrouthyFirebaseConfig = Object.freeze({
    apiKey: 'PASTE_FIREBASE_API_KEY',
    authDomain: 'YOUR_PROJECT.firebaseapp.com',
    projectId: 'YOUR_PROJECT_ID',
    storageBucket: 'YOUR_PROJECT.firebasestorage.app',
    messagingSenderId: 'PASTE_MESSAGING_SENDER_ID',
    appId: 'PASTE_APP_ID',
    siteId: 'trouthy',
    editorEmails: ['owner@example.com']
  });
})();