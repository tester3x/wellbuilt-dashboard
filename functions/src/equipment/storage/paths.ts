/** Driver-owned document image (legacy path — unchanged in Commit 3). */
export function driverDocumentImagePath(driverHash: string, docId: string): string {
  return `ewallet/${driverHash}/${docId}.jpg`;
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