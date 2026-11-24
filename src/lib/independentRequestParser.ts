import type { IndependentCustomer, IndependentDirectory } from './independentDispatchDirectory';
import type { IndependentJobDetails } from './independentDispatchJobs';
import { INDEPENDENT_SECTORS, SECTOR_FIELDS, type IndependentSector } from './independentDispatchSectors';

export type ParsedJobRequest = {
  customerId: string;
  customerLabel: string;
  customerSuggestions: { id: string; name: string; sectorMatch: boolean }[];
  sector: IndependentSector | '';
  fields: Partial<IndependentJobDetails>;
  sectorFields: Record<string, string>;
  scheduledLocal: string;
  missing: string[];
  warnings: string[];
};

const ALIASES: Record<string, string[]> = {
  customer: ['customer', 'client', 'requested by', 'requesting company'],
  jobContactName: ['company man', 'company man name', 'job contact', 'site contact', 'field contact', 'lead', 'boss'],
  jobContactRole: ['contact role', 'contact title', 'company man title'],
  jobContactPhoneE164: ['company man phone', 'company man number', 'job contact phone', 'site contact phone', 'contact phone', 'lead phone', 'boss phone'],
  sector: ['sector', 'service type', 'transportation sector'],
  title: ['job', 'job name', 'load name', 'work requested'],
  reference: ['reference', 'ref', 'po', 'po #', 'order #', 'load #', 'bol', 'ticket #'],
  pickup: ['pickup', 'pickup location', 'pickup address', 'pick up at', 'load at', 'origin', 'from'],
  destination: ['delivery', 'delivery location', 'delivery address', 'drop off', 'drop-off', 'dropoff', 'destination', 'deliver to', 'to'],
  cargo: ['cargo', 'equipment', 'freight', 'load description'],
  notes: ['notes', 'instructions', 'special instructions'],
  requestedDriverCount: ['requested drivers', 'drivers requested', 'driver count', 'number of drivers', 'drivers', 'trucks requested', 'truck count', 'trucks'],
  scheduledLocal: ['pickup time', 'pickup date/time', 'scheduled pickup', 'pickup appointment', 'schedule', 'arrival time', 'be there by', 'job starts at', 'job begins at', 'start time', 'report by', 'on site by', 'onsite by', 'on location by', 'ready by'],
  waterType: ['water type'], volumeBbl: ['estimated barrels', 'barrels', 'bbl', 'volume'],
  sourceReference: ['well', 'source reference'], disposalReference: ['disposal', 'disposal reference'],
  freightDescription: ['freight description'], pieces: ['pieces', 'piece count'], pallets: ['pallets'],
  weightLbs: ['weight', 'weight lb', 'weight lbs'], freightClass: ['freight class', 'class'],
  trailerType: ['trailer', 'trailer type'], commodity: ['commodity'],
  deliveryAppointment: ['delivery appointment', 'delivery time'], urgency: ['urgency'],
  cargoDetails: ['cargo details', 'cargo and dimensions'], vehicleRequirement: ['vehicle requirement', 'vehicle'],
  readyBy: ['ready by'], material: ['material'], estimatedTons: ['estimated tons', 'tons', 'tonnage'],
  loadCount: ['estimated loads', 'loads'], scaleTicket: ['scale ticket'],
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function labeled(lines: string[], names: string[]): string {
  const wanted = new Set(names.map(normalize));
  for (const line of lines) {
    const match = line.match(/^(.{1,45}?)\s*(?::|\s+-\s+|\s+#\s*)\s*(.+)$/);
    if (match && wanted.has(normalize(match[1]))) return match[2].trim();
  }
  return '';
}

function matchSavedCustomer(raw: string, customers: IndependentCustomer[]): IndependentCustomer | undefined {
  const wanted = normalize(raw);
  const matches = customers.filter(customer => [customer.name, ...(customer.alternateNames || [])]
    .some(name => normalize(name) === wanted));
  return matches.length === 1 ? matches[0] : undefined;
}

function closeCustomerCandidates(raw: string, customers: IndependentCustomer[]): IndependentCustomer[] {
  const wanted = normalize(raw);
  if (wanted.length < 3) return [];
  return customers.filter(customer => [customer.name, ...(customer.alternateNames || [])].some(name => {
    const candidate = normalize(name);
    if (candidate === wanted) return true;
    if (candidate.startsWith(`${wanted} `) || wanted.startsWith(`${candidate} `)) return true;
    const words = wanted.split(' ').filter(word => word.length >= 3);
    return words.length > 0 && words.every(word => candidate.split(' ').some(part => part.startsWith(word)));
  }));
}

function closeCustomers(candidates: IndependentCustomer[], sector: IndependentSector | ''): ParsedJobRequest['customerSuggestions'] {
  return candidates.sort((a, b) => Number(!!sector && b.sectors.includes(sector)) - Number(!!sector && a.sectors.includes(sector))
    || a.name.localeCompare(b.name)).slice(0, 3)
    .map(customer => ({ id: customer.id, name: customer.name, sectorMatch: !!sector && customer.sectors.includes(sector) }));
}

function sectorFrom(raw: string): IndependentSector | '' {
  const value = normalize(raw);
  const aliases: Record<IndependentSector, string[]> = {
    'water-hauling': ['water hauling', 'water', 'water truck'],
    ltl: ['ltl', 'ltl freight', 'less than truckload'],
    otr: ['otr', 'over the road', 'over the road trucking'],
    'hot-shot': ['hot shot', 'hotshot'],
    aggregate: ['aggregate', 'gravel', 'sand hauling'],
  };
  return INDEPENDENT_SECTORS.find(sector => aliases[sector.id].includes(value) || normalize(sector.label) === value)?.id || '';
}

function inferSector(text: string): IndependentSector | '' {
  const value = normalize(text);
  const hits: IndependentSector[] = [];
  if (/\b(production water|fresh water|flowback|frac water|bbl|barrels)\b/.test(value)) hits.push('water-hauling');
  if (/\b(ltl|pallets|freight class)\b/.test(value)) hits.push('ltl');
  if (/\b(otr|dry van|reefer|flatbed|step deck)\b/.test(value)) hits.push('otr');
  if (/\b(hot shot|hotshot)\b/.test(value)) hits.push('hot-shot');
  if (/\b(aggregate|gravel|scoria|topsoil|tons)\b/.test(value)) hits.push('aggregate');
  return hits.length === 1 ? hits[0] : '';
}

function localDateTime(raw: string): string {
  const iso = raw.match(/\b(20\d\d)-(\d\d)-(\d\d)[ T](\d\d):(\d\d)\b/);
  const us = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\s+(\d{1,2})(?::(\d\d))?\s*(AM|PM)?\b/i);
  if (!iso && !us) return '';
  const year = Number(iso?.[1] || us?.[3]), month = Number(iso?.[2] || us?.[1]), day = Number(iso?.[3] || us?.[2]);
  let hour = Number(iso?.[4] || us?.[4]);
  const minute = Number(iso?.[5] || us?.[5] || '0');
  if (us?.[6]) hour = hour % 12 + (us[6].toUpperCase() === 'PM' ? 12 : 0);
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function optionValue(raw: string, options: readonly string[]): string {
  const value = normalize(raw);
  return options.find(option => normalize(option) === value) || '';
}

function contactPhone(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  return '';
}

function requestedDrivers(lines: string[], warnings: string[]): number | undefined {
  const labeledCount = labeled(lines, ALIASES.requestedDriverCount);
  const naturalCounts = lines.flatMap(line => [
    ...line.matchAll(/\b(?:need|send|request|want|require|cover(?:\s+with)?)\s+(\d{1,2})\s+(?:\w+\s+)?(?:drivers?|trucks?)\b/gi),
    ...line.matchAll(/\b(\d{1,2})\s+(?:\w+\s+)?(?:drivers?|trucks?)\s+(?:needed|required|requested)\b/gi),
  ].map(match => match[1]));
  if (!labeledCount && new Set(naturalCounts).size > 1) {
    warnings.push('The request mentions different driver counts; confirm the staffing target.');
    return undefined;
  }
  const candidate = labeledCount || naturalCounts[0];
  if (!candidate) return undefined;
  const count = Number(/^\s*(\d{1,2})\b/.exec(candidate)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 30) {
    warnings.push('Requested driver count needs review; enter a number from 1 to 30.');
    return undefined;
  }
  return count;
}

/** Local, review-first extraction. Never creates a job or sends the source text anywhere. */
export function parsePastedJobRequest(text: string, directory: IndependentDirectory): ParsedJobRequest {
  const lines = text.slice(0, 10000).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const service = labeled(lines, ['service']);
  const serviceBody = service.split(/\.\s+(?=For\b|Ordered by\b)/i)[0];
  const serviceCustomer = service.match(/\bfor\s+([^,.;]+)(?=[,.;]|$)/i)?.[1]?.trim() || '';
  const serviceRoute = serviceBody.match(/\bfrom\s+(.+?)\s+(?:take\s+)?to\s+(.+?)(?=\s+to\s+(?:fill|deliver|load|unload)\b|\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|$)/i);
  const serviceTime = serviceBody.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i)?.[1] || '';
  const orderedBy = service.match(/\bOrdered by\s+([^.,;]+)(?=[.,;]|$)/i)?.[1]?.trim() || '';
  const warnings: string[] = [];
  const fields: Partial<IndependentJobDetails> = {};
  fields.requestedDriverCount = requestedDrivers(lines, warnings);
  const requestedSector = labeled(lines, ALIASES.sector);
  let sector = requestedSector ? sectorFrom(requestedSector) : inferSector(text);
  if (requestedSector && !sector) warnings.push(`Transportation sector “${requestedSector}” was not recognized.`);
  const customerLabel = labeled(lines, ALIASES.customer) || serviceCustomer;
  const contactName = labeled(lines, ALIASES.jobContactName) || orderedBy;
  const contactNames = contactName.split(/\s*\/\s*/).map(name => name.trim()).filter(Boolean);
  const contactRole = labeled(lines, ALIASES.jobContactRole) || (orderedBy && contactName === orderedBy ? 'Requester' : '');
  const contactPhoneRaw = labeled(lines, ALIASES.jobContactPhoneE164);
  const directCustomer = customerLabel ? matchSavedCustomer(customerLabel, directory.customers) : undefined;
  const candidates = customerLabel ? closeCustomerCandidates(customerLabel, directory.customers) : [];
  const namedContactMatches = contactNames.length ? candidates.filter(candidate =>
    contactNames.every(name => (candidate.contacts || []).some(contact => normalize(contact.name) === normalize(name)))) : [];
  const contactMatches = namedContactMatches.filter(candidate => !sector || candidate.sectors.includes(sector));
  const contactCustomer = contactMatches.length === 1 ? contactMatches[0] : undefined;
  const directIsOfficial = directCustomer && normalize(directCustomer.name) === normalize(customerLabel);
  const customer = namedContactMatches.length && !contactCustomer ? undefined
    : contactCustomer && (!directIsOfficial || directCustomer?.id === contactCustomer.id)
    ? contactCustomer : contactCustomer && directIsOfficial && directCustomer?.id !== contactCustomer.id
      ? undefined : directCustomer && (!sector || directCustomer.sectors.includes(sector)) ? directCustomer : undefined;
  const customerSuggestions = customerLabel && !customer ? closeCustomers(candidates, sector) : [];
  if (directCustomer && sector && !directCustomer.sectors.includes(sector))
    warnings.push(`${sector} is not enabled for ${directCustomer.name}; confirm the customer and job type.`);
  if (customer && contactCustomer?.id === customer.id && directCustomer?.id !== customer.id)
    warnings.push(`Matched “${customerLabel}” to ${customer.name} using job contact ${contactName}; confirm the company.`);
  if (namedContactMatches.length && !contactMatches.length && sector)
    warnings.push(`Job contact ${contactName} is saved under a different sector; confirm the customer and job type.`);
  if (customer && customerLabel && normalize(customerLabel) !== normalize(customer.name))
    warnings.push(`Matched “${customerLabel}” to ${customer.name}. The job will use the official company name.`);
  if (customerLabel && !customer) warnings.push(customerSuggestions.length
    ? `Customer “${customerLabel}” may match a saved company. Confirm its official name; the job sector is only a clue.`
    : `Customer “${customerLabel}” is not in your customer list. Confirm the official name or use NEW customer.`);
  if (!sector && !requestedSector && customer?.sectors.length === 1) sector = customer.sectors[0];
  if (sector && (!directory.sectors.includes(sector) || (customer && !customer.sectors.includes(sector)))) {
    warnings.push(`${sector} is not enabled for this customer.`); sector = '';
  }
  for (const key of ['title', 'reference', 'pickup', 'destination', 'cargo', 'notes'] as const) {
    const value = labeled(lines, ALIASES[key]);
    if (value) fields[key] = value.slice(0, key === 'notes' ? 4000 : key === 'pickup' || key === 'destination' || key === 'cargo' ? 500 : 180);
  }
  if (service) {
    const pickup = serviceRoute?.[1]?.replace(/\s+take$/i, '').trim() || '';
    const destination = serviceRoute?.[2]?.trim() || '';
    if (pickup && !/^[-–—?]+$/.test(pickup)) fields.pickup ||= pickup.slice(0, 500);
    if (destination) fields.destination ||= destination.slice(0, 500);
    const water = /\b(fresh water|production water|flowback|frac water)\b/i.exec(service)?.[1];
    if (destination && (water || /^\s*\d+\s+loads?\b/i.test(serviceBody))) fields.title ||= `${water || 'Load'} to ${destination}`.slice(0, 180);
    fields.notes ||= `Original request: ${text.trim()}`.slice(0, 4000);
    if (pickup && /^[-–—?]+$/.test(pickup)) warnings.push('Pickup was left blank in the request; confirm the source location.');
  }
  if (contactNames.length > 1) {
    fields.notes = [fields.notes, `Company men (shift and phone pairing unspecified): ${contactName}`].filter(Boolean).join('\n').slice(0, 4000);
    warnings.push('Multiple company men were named without clear shifts; confirm each person and phone before dispatching.');
  } else if (contactName) {
    fields.jobContactName = contactName.slice(0, 120);
    fields.jobContactRole = (contactRole || (lines.some(line => /^company man\s*:/i.test(line)) ? 'Company man' : '')).slice(0, 80);
  }
  if (contactPhoneRaw && contactNames.length === 1) {
    fields.jobContactPhoneE164 = contactPhone(contactPhoneRaw);
    if (!fields.jobContactPhoneE164) warnings.push('Job contact phone needs review; use a full number with country code.');
    else if (!contactPhoneRaw.trim().startsWith('+')) warnings.push('Assumed +1 for the job contact phone; confirm it.');
  } else if (contactPhoneRaw && contactNames.length !== 1) warnings.push('Job contact phone could not be paired with one person; confirm the right person before using it.');
  if (!fields.pickup || !fields.destination) {
    const fromTo = text.match(/\bfrom\s+([^\n]+?)\s+to\s+([^\n.,;]+)/i);
    if (fromTo) {
      const pickup = fromTo[1].replace(/\s+take$/i, '').trim();
      if (!/^[-–—?]+$/.test(pickup)) fields.pickup ||= pickup;
      fields.destination ||= fromTo[2].trim();
    }
  }
  const scheduleLines = lines.flatMap(line => {
    const label = line.match(/^(.{1,45}?)\s*(?::|\s+-\s+)\s*(.+)$/);
    if (label && ALIASES.scheduledLocal.map(normalize).includes(normalize(label[1]))) return [`${label[1].trim()}: ${label[2].trim()}`];
    return line.split(/;|[.!?](?:\s|$)/).map(part => part.trim()).filter(part =>
      /\b(?:be there|be on\s*(?:site|location)|arrive|arrival|report|on\s*(?:site|location)|show up|check in|ready)\s+(?:by|at)\b|\b(?:job|work|shift)\s+(?:starts?|begins?)\s+at\b|\b(?:start|begin)\s+(?:at|by)\b/i.test(part));
  });
  if (serviceTime && !scheduleLines.some(line => line.toLowerCase().includes(serviceTime.toLowerCase())))
    scheduleLines.push(`Requested time: ${serviceTime}`);
  if (scheduleLines.length) fields.scheduleText = [...new Set(scheduleLines)].join('; ').slice(0, 500);
  const exactTimes = [...new Set(scheduleLines.map(localDateTime).filter(Boolean))];
  const scheduledLocal = exactTimes.length === 1 ? exactTimes[0] : '';
  if (exactTimes.length > 1) warnings.push('Multiple dated times were found; confirm which one belongs in the scheduled time field.');
  else if (scheduleLines.length && !scheduledLocal) warnings.push('Request timing needs review; confirm the date and scheduled time before dispatching.');
  const sectorFields: Record<string, string> = {};
  if (sector) for (const field of SECTOR_FIELDS[sector]) {
    let raw = labeled(lines, [field.label, ...(ALIASES[field.key] || [])]);
    if (!raw && field.key === 'volumeBbl') raw = text.match(/\b([\d,]+(?:\.\d+)?)\s*(?:bbls?|barrels)\b/i)?.[1] || '';
    if (!raw && field.key === 'waterType') raw = text.match(/\b(production water|fresh water|flowback|frac water)\b/i)?.[1] || '';
    if (!raw && field.key === 'estimatedTons') raw = text.match(/\b([\d,]+(?:\.\d+)?)\s*tons?\b/i)?.[1] || '';
    if (!raw && field.key === 'pieces') raw = text.match(/\b([\d,]+)\s*pieces?\b/i)?.[1] || '';
    if (!raw && field.key === 'pallets') raw = text.match(/\b([\d,]+)\s*pallets?\b/i)?.[1] || '';
    if (!raw) continue;
    const value = field.options ? optionValue(raw, field.options)
      : field.type === 'number' ? (/^\d[\d,]*(?:\.\d+)?/.exec(raw)?.[0] || '').replace(/,/g, '')
      : field.type === 'datetime-local' ? localDateTime(raw) : raw;
    if (value) sectorFields[field.key] = value.slice(0, 160);
    else warnings.push(`${field.label} could not be read; check it in the form.`);
  }
  const missing = [!customer && 'Customer', !sector && 'Transportation sector', !fields.title && 'Job name',
    !fields.pickup && !fields.destination && 'Job location',
    ...(sector ? SECTOR_FIELDS[sector].filter(field => field.required && !sectorFields[field.key]).map(field => field.label) : [])]
    .filter((value): value is string => !!value);
  return { customerId: customer?.id || '', customerLabel, customerSuggestions, sector, fields, sectorFields, scheduledLocal, missing, warnings };
}
