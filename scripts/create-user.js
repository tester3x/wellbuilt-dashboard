// Run this script to create an initial admin user
// Usage: node scripts/create-user.js email@example.com password

const { initializeApp } = require('firebase/app');
const { getAuth, createUserWithEmailAndPassword } = require('firebase/auth');
const { getDatabase, ref, set } = require('firebase/database');

const firebaseConfig = {
  apiKey: "AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI",
  databaseURL: "https://wellbuilt-sync-default-rtdb.firebaseio.com",
  projectId: "wellbuilt-sync",
};

async function createUser(email, password, role = 'it') {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  try {
    // Create auth user
    const result = await createUserWithEmailAndPassword(auth, email, password);
    console.log('Created auth user:', result.user.uid);

    // Add role to database
    await set(ref(db, `users/${result.user.uid}`), {
      email: email,
      role: role,
      displayName: email.split('@')[0],
      createdAt: new Date().toISOString(),
    });
    console.log('Added user to database with role:', role);

    console.log('\nUser created successfully!');
    console.log('Email:', email);
    console.log('Role:', role);
    console.log('UID:', result.user.uid);

    process.exit(0);
  } catch (error) {
    console.error('Error creating user:', error.message);
    process.exit(1);
  }
}

const email = process.argv[2];
const password = process.argv[3];
const role = process.argv[4] || 'it';

if (!email || !password) {
  console.log('Usage: node scripts/create-user.js <email> <password> [role]');
  console.log('Roles: driver, viewer, admin, manager, it (default: it)');
  process.exit(1);
}

createUser(email, password, role);
