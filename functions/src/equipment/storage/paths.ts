/** Driver-owned document image (legacy single-capture path). */
export function driverDocumentImagePath(driverHash: string, docId: string): string {
  return `ewallet/${driverHash}/${docId}.jpg`;
}

/** Driver-owned multi-capture image (front, back, page). */
export function driverDocumentCapturePath(
  driverHash: string,
  docId: string,
  captureKind: string,
): string {
  return `ewallet/${driverHash}/${docId}/${captureKind}.jpg`;
}

/** Company equipment document image (transitional vehicle_documents collection). */
export function vehicleDocumentImagePath(
  companyId: string,
  equipmentType: string,
  equipmentNumber: string,
  docId: string,
): string {
  return `vehicle_documents/${companyId}/${equipmentType}_${equipmentNumber}/${docId}.jpg`;
}