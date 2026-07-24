/**
 * Certification setup via Firestore REST + Firebase CLI OAuth access token.
 * Local only — reads token from ~/.config/configstore/firebase-tools.json
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

const PROJECT = 'wellbuilt-sync';
const COMPANY_ID = 'liquid-gold';
const DRIVER_HASH = 'da561bc41e746a0b08f679d3210c3c06f4141a27571bca7ba146a4ccc8891906';
const DRIVER_DISPLAY = 'MikeS24';
const UNIT_NUMBER = '102';
const EQUIPMENT_TYPE = 'truck';
const ADMIN_UID = 'EZHWZBlmkPYpHUq860nAo5ZmDDU2';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function loadAccessToken() {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8'));
  const token = cfg.tokens?.access_token;
  if (!token) throw new Error('Firebase CLI access_token missing — run: firebase login');
  return token;
}

function str(v) { return { stringValue: String(v) }; }
function bool(v) { return { booleanValue: Boolean(v) }; }
function nullVal() { return { nullValue: null }; }
function ts(iso) { return { timestampValue: iso }; }
function map(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) fields[k] = nullVal();
    else if (typeof v === 'string') fields[k] = str(v);
    else if (typeof v === 'boolean') fields[k] = bool(v);
    else if (typeof v === 'object') fields[k] = { mapValue: { fields: map(v).fields || map(v) } };
  }
  return { mapValue: { fields } };
}

function actor(uid, name = 'Cert Setup') {
  return {
    mapValue: {
      fields: {
        type: str('dashboard'),
        uid: str(uid),
        displayName: str(name),
      },
    },
  };
}

async function api(path, { method = 'GET', body } = {}) {
  const token = loadAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

async function runQuery(collectionId, filters) {
  const parent = `projects/${PROJECT}/databases/(default)/documents/companies/${COMPANY_ID}`;
  const structuredQuery = {
    from: [{ collectionId }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: filters.map(([field, op, value]) => ({
          fieldFilter: {
            field: { fieldPath: field },
            op,
            value: typeof value === 'boolean' ? bool(value) : str(value),
          },
        })),
      },
    },
    limit: 1,
  };
  return api(`:runQuery`, {
    method: 'POST',
    body: { structuredQuery: { ...structuredQuery, from: [{ collectionId, allDescendants: false }] , parent } },
  });
}

function parseQueryDocs(result) {
  const docs = [];
  for (const row of result || []) {
    if (row.document) docs.push(row.document);
  }
  return docs;
}

function docId(doc) {
  return doc.name.split('/').pop();
}

function fieldVal(doc, name) {
  const f = doc.fields?.[name];
  if (!f) return undefined;
  if (f.stringValue !== undefined) return f.stringValue;
  if (f.booleanValue !== undefined) return f.booleanValue;
  return undefined;
}

async function main() {
  let equipmentId;
  let unitNumber = UNIT_NUMBER;

  const eqQuery = await api(`:runQuery`, {
    method: 'POST',
    body: {
      structuredQuery: {
        from: [{ collectionId: 'equipment' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'equipmentTypeId' }, op: 'EQUAL', value: str(EQUIPMENT_TYPE) } },
              { fieldFilter: { field: { fieldPath: 'unitNumber' }, op: 'EQUAL', value: str(UNIT_NUMBER) } },
              { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: bool(true) } },
            ],
          },
        },
        limit: 1,
      },
      parent: `projects/${PROJECT}/databases/(default)/documents/companies/${COMPANY_ID}`,
    },
  });

  const eqDocs = parseQueryDocs(eqQuery);
  if (eqDocs.length) {
    equipmentId = docId(eqDocs[0]);
    unitNumber = fieldVal(eqDocs[0], 'unitNumber') || UNIT_NUMBER;
    console.log('EXISTING_EQUIPMENT', { equipmentId, unitNumber });
  } else {
    equipmentId = randomBytes(10).toString('hex').slice(0, 20);
    const now = new Date().toISOString();
    await api(`/companies/${COMPANY_ID}/equipment/${equipmentId}`, {
      method: 'PATCH',
      body: {
        fields: {
          equipmentId: str(equipmentId),
          companyId: str(COMPANY_ID),
          equipmentTypeId: str(EQUIPMENT_TYPE),
          unitNumber: str(UNIT_NUMBER),
          status: str('ready'),
          active: bool(true),
          healthScore: nullVal(),
          equipmentStatus: nullVal(),
          createdAt: ts(now),
          createdBy: actor(ADMIN_UID),
          updatedAt: ts(now),
          updatedBy: actor(ADMIN_UID),
        },
      },
    });
    console.log('CREATED_EQUIPMENT', { equipmentId, unitNumber: UNIT_NUMBER });
  }

  const assignQuery = await api(`:runQuery`, {
    method: 'POST',
    body: {
      structuredQuery: {
        from: [{ collectionId: 'assignments' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'equipmentId' }, op: 'EQUAL', value: str(equipmentId) } },
              { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: bool(true) } },
            ],
          },
        },
        limit: 1,
      },
      parent: `projects/${PROJECT}/databases/(default)/documents/companies/${COMPANY_ID}`,
    },
  });

  const assignDocs = parseQueryDocs(assignQuery);
  if (assignDocs.length) {
    const doc = assignDocs[0];
    const hash = fieldVal(doc, 'driverHash') || '';
    console.log(JSON.stringify({
      result: 'already_exists',
      assignmentId: docId(doc),
      equipmentId,
      unitNumber,
      driverHashMasked: `${hash.slice(0, 8)}...${hash.slice(-4)}`,
      driverDisplay: DRIVER_DISPLAY,
      assignmentRole: fieldVal(doc, 'assignmentRole'),
    }, null, 2));
    return;
  }

  const assignmentId = randomBytes(10).toString('hex').slice(0, 20);
  const now = new Date().toISOString();
  await api(`/companies/${COMPANY_ID}/assignments/${assignmentId}`, {
    method: 'PATCH',
    body: {
      fields: {
        assignmentId: str(assignmentId),
        companyId: str(COMPANY_ID),
        equipmentId: str(equipmentId),
        driverHash: str(DRIVER_HASH),
        assignedBy: actor(ADMIN_UID),
        assignmentRole: str('primary_operator'),
        active: bool(true),
        startedAt: ts(now),
        createdAt: ts(now),
        createdBy: actor(ADMIN_UID),
        updatedAt: ts(now),
        updatedBy: actor(ADMIN_UID),
      },
    },
  });

  console.log(JSON.stringify({
    result: 'created',
    assignmentId,
    equipmentId,
    unitNumber,
    driverHashMasked: `${DRIVER_HASH.slice(0, 8)}...${DRIVER_HASH.slice(-4)}`,
    driverDisplay: DRIVER_DISPLAY,
    assignmentRole: 'primary_operator',
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});