import * as https from 'firebase-functions/v2/https';
export function assertWbmWriter(profile: Record<string, unknown>, roles: string[]): void {
 if(profile.isViewer === true || roles.includes('viewer') || (Array.isArray(profile.roles) && profile.roles.includes('viewer'))) throw new https.HttpsError('permission-denied','viewer_read_only');
}
