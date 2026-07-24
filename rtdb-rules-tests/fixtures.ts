export const PROJECT_ID = 'wellbuilt-sync-containment-test';
export const DATABASE_URL = `http://127.0.0.1:9000?ns=${PROJECT_ID}`;

export const DRIVER_HASH = 'a'.repeat(64);
export const OTHER_HASH = 'b'.repeat(64);

export const VALID_PENDING = {
  displayName: 'Mike S',
  passcodeHash: DRIVER_HASH,
  requestedAt: '2026-07-10T12:00:00.000Z',
  source: 'wbt',
  companyName: 'Liquid Gold',
};

export const PRIVILEGE_PENDING = {
  ...VALID_PENDING,
  isAdmin: true,
  role: 'admin',
};

export const VALID_PULL_PACKET = {
  requestType: 'pull',
  wellName: 'Gabriel 1',
  packetId: '20260710_120000_Gabriel1_ab12cd',
  driverId: DRIVER_HASH,
  driverName: 'Mike S',
  dateTimeUTC: '2026-07-10T12:00:00.000Z',
};

export const VALID_EDIT_PACKET = {
  requestType: 'edit',
  wellName: 'Gabriel 1',
  originalPacketId: 'orig123',
  driverName: 'Mike S',
};

export const VALID_DELETE_PACKET = {
  requestType: 'delete',
  wellName: 'Gabriel 1',
  packetId: 'target123',
  source: 'dashboard',
};