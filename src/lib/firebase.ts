// Firebase configuration and initialization
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getDatabase, Database } from 'firebase/database';
import { getFirestore as _getFirestore, Firestore } from 'firebase/firestore';
import { getStorage as _getStorage, FirebaseStorage } from 'firebase/storage';
import { getFunctions, Functions, httpsCallable } from 'firebase/functions';

const firebaseConfig = {
  apiKey: "AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI",
  authDomain: "wellbuilt-sync.firebaseapp.com",
  databaseURL: "https://wellbuilt-sync-default-rtdb.firebaseio.com",
  projectId: "wellbuilt-sync",
  storageBucket: "wellbuilt-sync.appspot.com",
};

// Singleton instances
let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let database: Database | null = null;
let firestore: Firestore | null = null;
let storage: FirebaseStorage | null = null;
let functions: Functions | null = null;

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

export function getFirebaseFunctions(): Functions {
  if (!functions) {
    functions = getFunctions(getFirebaseApp());
  }
  return functions;
}

/**
 * Get next invoice number from the shared block system (same as WB T).
 * Calls the assignInvoiceBlock Cloud Function which uses Firestore transactions
 * to atomically assign blocks — no duplicates possible.
 */
export async function getNextInvoiceNumber(companyId: string): Promise<{ number: number; prefix: string }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'assignInvoiceBlock');
  const result: any = await fn({ companyId });
  const block = result.data;
  return { number: block.start, prefix: block.prefix || '' };
}

/**
 * Get next ticket number from the shared block system (same as WB T).
 */
export async function getNextTicketNumber(): Promise<number> {
  const fn = httpsCallable(getFirebaseFunctions(), 'assignTicketBlock');
  const result: any = await fn({});
  const block = result.data;
  return block.start;
}
