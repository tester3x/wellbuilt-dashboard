// Firebase configuration and initialization
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getDatabase, Database } from 'firebase/database';
import { getFirestore as _getFirestore, Firestore } from 'firebase/firestore';
import { getStorage as _getStorage, FirebaseStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI",
  databaseURL: "https://wellbuilt-sync-default-rtdb.firebaseio.com",
  projectId: "wellbuilt-sync",
  storageBucket: "wellbuilt-sync.firebasestorage.app",
};

// Singleton instances
let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let database: Database | null = null;
let firestore: Firestore | null = null;
let storage: FirebaseStorage | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (!app) {
    const existingApps = getApps();
    app = existingApps.length > 0 ? existingApps[0] : initializeApp(firebaseConfig);
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
  }
  return auth;
}

export function getFirebaseDatabase(): Database {
  if (!database) {
    database = getDatabase(getFirebaseApp());
  }
  return database;
}

export function getFirestoreDb(): Firestore {
  if (!firestore) {
    firestore = _getFirestore(getFirebaseApp());
  }
  return firestore;
}

export function getFirebaseStorage(): FirebaseStorage {
  if (!storage) {
    storage = _getStorage(getFirebaseApp());
  }
  return storage;
}
