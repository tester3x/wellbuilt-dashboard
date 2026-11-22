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
  sector: ['sector', 'service type', 'transportation sector'],
  title: ['job', 'job name', 'load name', 'work requested'],
  reference: ['reference', 'ref', 'po', 'po #', 'order #', 'load #', 'bol', 'ticket #'],
  pickup: ['pickup', 'pickup location', 'pickup address', 'pick up at', 'load at', 'origin', 'from'],
  destination: ['delivery', 'delivery location', 'delivery address', 'drop off', 'drop-off', 'dropoff', 'destination', 'deliver to', 'to'],
  cargo: ['cargo', 'equipment', 'freight', 'load description'],
  notes: ['notes', 'instructions', 'special instructions'],
  scheduledLocal: ['pickup time', 'pickup date/time', 'scheduled pickup', 'pickup appointment'],
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

function matchOfficialCustomer(raw: string, customers: IndependentCustomer[]): IndependentCustomer | undefined {
  const wanted = normalize(raw);
  const matches = customers.filter(customer => normalize(customer.name) === wanted);
  if (matches.length !== 1) return undefined;
  // An exact official name is still ambiguous if another company's alias uses it.
  if (customers.some(customer => customer.id !== matches[0].id
    && (customer.alternateNames || []).some(alias => normalize(alias) === wanted))) return undefined;
  return matches[0];
}

function closeCustomers(raw: string, customers: IndependentCustomer[], sector: IndependentSector | ''): ParsedJobRequest['customerSuggestions'] {
  const wanted = normalize(raw);
  if (wanted.length < 3) return [];
  return customers.filter(customer => [customer.name, ...(customer.alternateNames || [])].some(name => {
    const candidate = normalize(name);
    if (candidate === wanted) return true;
    if (wanted.length >= 4 && (candidate.startsWith(`${wanted} `) || wanted.startsWith(`${candidate} `))) return true;
    const words = wanted.split(' ').filter(word => word.length >= 3);
    return words.length > 0 && words.every(word => candidate.split(' ').some(part => part.startsWith(word)));
  })).sort((a, b) => Number(!!sector && b.sectors.includes(sector)) - Number(!!sector && a.sectors.includes(sector))
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
  const us = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\s+(\d{1,2}):(\d\d)\s*(AM|PM)?\b/i);
  if (!iso && !us) return '';
  const year = Number(iso?.[1] || us?.[3]), month = Number(iso?.[2] || us?.[1]), day = Number(iso?.[3] || us?.[2]);
  let hour = Number(iso?.[4] || us?.[4]);
  const minute = Number(iso?.[5] || us?.[5]);
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

/** Local, review-first extraction. Never creates a job or sends the source text anywhere. */
export function parsePastedJobRequest(text: string, directory: IndependentDirectory): ParsedJobRequest {
  const lines = text.slice(0, 10000).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const warnings: string[] = [];
  const fields: Partial<IndependentJobDetails> = {};
  const requestedSector = labeled(lines, ALIASES.sector);
  let sector = requestedSector ? sectorFrom(requestedSector) : inferSector(text);
  if (requestedSector && !sector) warnings.push(`Transportation sector “${requestedSector}” was not recognized.`);
  const customerLabel = labeled(lines, ALIASES.customer);
  const customer = customerLabel ? matchOfficialCustomer(customerLabel, directory.customers) : undefined;
  const customerSuggestions = customerLabel && !customer ? closeCustomers(customerLabel, directory.customers, sector) : [];
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
  if (!fields.pickup || !fields.destination) {
    const fromTo = text.match(/\bfrom\s+([^\n]+?)\s+to\s+([^\n.,;]+)/i);
    if (fromTo) { fields.pickup ||= fromTo[1].trim(); fields.destination ||= fromTo[2].trim(); }
  }
  const timeRaw = labeled(lines, ALIASES.scheduledLocal);
  const scheduledLocal = timeRaw ? localDateTime(timeRaw) : '';
  if (timeRaw && !scheduledLocal) warnings.push('Pickup time needs review; use a full date and time.');
  const sectorFields: Record<string, string> = {};
  if (sector) for (const field of SECTOR_FIELDS[sector]) {
    let raw = labeled(lines, [field.label, ...(ALIASES[field.key] || [])]);
    if (!raw && field.key === 'volumeBbl') raw = text.match(/\b([\d,]+(?:\.\d+)?)\s*(?:bbl|barrels)\b/i)?.[1] || '';
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
    !fields.pickup && 'Pickup location', !fields.destination && 'Delivery location',
    ...(sector ? SECTOR_FIELDS[sector].filter(field => field.required && !sectorFields[field.key]).map(field => field.label) : [])]
    .filter((value): value is string => !!value);
  return { customerId: customer?.id || '', customerLabel, customerSuggestions, sector, fields, sectorFields, scheduledLocal, missing, warnings };
}
