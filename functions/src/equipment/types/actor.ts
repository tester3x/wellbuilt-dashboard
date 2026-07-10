/** Actor identity for WB eQuipment service writes. */
export type ActorRef =
  | { type: 'driver'; driverHash: string; displayName?: string }
  | { type: 'dashboard'; uid: string; displayName?: string }
  | { type: 'system'; reason?: string };

export interface DriverActor {
  type: 'driver';
  driverHash: string;
}

export interface DriverProfile {
  driverHash: string;
  displayName: string;
  companyId?: string;
  companyName?: string;
}