import type { ExternalDriver } from './externalAssignmentDelivery';
import type { IndependentDriverProfile } from './independentDriverProfiles';

/** Current contact details take precedence over the name frozen on an old job. */
export function independentDriverContact(
  driver: { key: string; name: string }, profiles: IndependentDriverProfile[], outsideDrivers: ExternalDriver[],
): { officialName: string; whatsappName: string; phoneE164: string } {
  const profile = profiles.find(item => item.driverKey === driver.key);
  const legacyPhone = driver.key.startsWith('outside:')
    ? outsideDrivers.find(item => `outside:${item.externalDriverId}` === driver.key)?.phoneE164 || '' : '';
  return {
    officialName: driver.name,
    whatsappName: profile?.whatsappName?.trim() || driver.name,
    phoneE164: profile?.phoneE164 === undefined ? legacyPhone : profile.phoneE164,
  };
}
