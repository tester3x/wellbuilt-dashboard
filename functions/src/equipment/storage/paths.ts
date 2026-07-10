/** Driver-owned document image (legacy path — unchanged in Commit 3). */
export function driverDocumentImagePath(driverHash: string, docId: string): string {
  return `ewallet/${driverHash}/${docId}.jpg`;
}