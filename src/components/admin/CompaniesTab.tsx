'use client';

import { useEffect, useState, useRef } from 'react';
import { getFirestoreDb, getFirebaseStorage } from '@/lib/firebase';
import { collection, getDocs, doc, setDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { loadOperators, searchOperators, NdicOperator } from '@/lib/firestoreWells';

type Tier = 'field-basics' | 'full-field' | 'suite';

const TIER_LABELS: Record<Tier, string> = {
  'field-basics': 'Field Basics',
  'full-field': 'Full Field',
  'suite': 'Suite',
};

const TIER_COLORS: Record<Tier, string> = {
  'field-basics': 'bg-gray-600 text-gray-200',
  'full-field': 'bg-blue-600 text-blue-100',
  'suite': 'bg-yellow-600 text-yellow-100',
};

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  'field-basics': 'Single app — WB Tickets or WB Mobile',
  'full-field': 'Tickets + Mobile + Dashboard',
  'suite': 'Everything — Hub + Tickets + Mobile + Dashboard + Billing & Payroll',
};

const TIER_ORDER: Tier[] = ['field-basics', 'full-field', 'suite'];

interface RateEntry {
  jobType: string;
  method: 'per_bbl' | 'hourly';
  rate: number;
}

interface PayConfig {
  defaultSplit: number;       // e.g. 0.25 for 25%
  payrollRounding: 'match_billing' | 'none' | 'quarter_hour' | 'half_hour';
  payPeriod: 'weekly' | 'biweekly' | 'monthly';
  autoApproveHours?: number;  // hours before auto-approve (0 = disabled)
}

interface CompanyConfig {
  id: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  invoicePrefix?: string;
  invoiceBook?: boolean;
  ticketPrefix?: string;
  rateSheet?: Record<string, number>;  // legacy simple format
  rateSheets?: Record<string, RateEntry[]>;  // per-operator rate sheets
  payConfig?: PayConfig;
  notes?: string;
  assignedOperators?: string[];
  logoUrl?: string;
  primaryColor?: string;
  phone?: string;
  splitTickets?: boolean;
  tier?: Tier;
  enabledApps?: string[];
  requiredApps?: string[];
}

interface CompaniesTabProps {
  scopeCompanyId?: string;  // if set, only show this company
  isWbAdmin?: boolean;      // true = WellBuilt IT/admin (can add/delete companies)
}

export function CompaniesTab({ scopeCompanyId, isWbAdmin = false }: CompaniesTabProps) {
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');

  // Add / Edit company
  const [showForm, setShowForm] = useState(false);
  const [editingCompany, setEditingCompany] = useState<CompanyConfig | null>(null);
  const [formId, setFormId] = useState('');
  const [formName, setFormName] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formCity, setFormCity] = useState('');
  const [formState, setFormState] = useState('ND');
  const [formZip, setFormZip] = useState('');
  const [formInvoicePrefix, setFormInvoicePrefix] = useState('');
  const [formInvoiceBook, setFormInvoiceBook] = useState(false);
  const [formTicketPrefix, setFormTicketPrefix] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formNotes, setFormNotes] = useState('');

  // Expanded company
  const [expandedCompany, setExpandedCompany] = useState<string | null>(null);

  // Operator assignment
  const [showOperatorModal, setShowOperatorModal] = useState<string | null>(null); // company ID
  const [operatorSearch, setOperatorSearch] = useState('');
  const [operatorSuggestions, setOperatorSuggestions] = useState<NdicOperator[]>([]);
  const [selectedOperator, setSelectedOperator] = useState<string | null>(null);
  const [allOperators, setAllOperators] = useState<NdicOperator[]>([]);
  const operatorSearchRef = useRef<HTMLInputElement>(null);

  // Branding state
  const [brandingCompany, setBrandingCompany] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [extractedPalette, setExtractedPalette] = useState<string[]>([]);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [extractedColor, setExtractedColor] = useState<string | null>(null);
  const [manualColor, setManualColor] = useState('');
  const [brandingSaving, setBrandingSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Rate sheet state
  const [rateSheetCompany, setRateSheetCompany] = useState<CompanyConfig | null>(null);
  const [rateSheetOperator, setRateSheetOperator] = useState('');
  const [rateSheetEntries, setRateSheetEntries] = useState<RateEntry[]>([]);
  const [rateSheetSaving, setRateSheetSaving] = useState(false);

  // Pay config state
  const [payConfigCompany, setPayConfigCompany] = useState<CompanyConfig | null>(null);
  const [payConfigSplit, setPayConfigSplit] = useState('25');
  const [payConfigRounding, setPayConfigRounding] = useState<PayConfig['payrollRounding']>('match_billing');
  const [payConfigPeriod, setPayConfigPeriod] = useState<PayConfig['payPeriod']>('weekly');
  const [payConfigAutoApprove, setPayConfigAutoApprove] = useState('48');

  const firestore = getFirestoreDb();

  const loadCompanies = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(firestore, 'companies'));
      const list: CompanyConfig[] = [];
      snap.forEach(d => {
        list.push({ id: d.id, ...d.data() } as CompanyConfig);
      });
      list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      setCompanies(list);
    } catch (err) {
      console.error('Failed to load companies:', err);
      setMessage('Failed to load companies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadCompanies(); }, []);

  // Pre-load NDIC operators for the autocomplete
  useEffect(() => {
    loadOperators().then(ops => setAllOperators(ops)).catch(() => {});
  }, []);

  const resetForm = () => {
    setFormId('');
    setFormName('');
    setFormAddress('');
    setFormCity('');
    setFormState('ND');
    setFormZip('');
    setFormInvoicePrefix('');
    setFormInvoiceBook(false);
    setFormTicketPrefix('');
    setFormPhone('');
    setFormNotes('');
    setEditingCompany(null);
  };

  const openAddForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (company: CompanyConfig) => {
    setEditingCompany(company);
    setFormId(company.id);
    setFormName(company.name || '');
    setFormAddress(company.address || '');
    setFormCity(company.city || '');
    setFormState(company.state || 'ND');
    setFormZip(company.zip || '');
    setFormInvoicePrefix(company.invoicePrefix || '');
    setFormInvoiceBook(company.invoiceBook || false);
    setFormTicketPrefix(company.ticketPrefix || '');
    setFormPhone(company.phone || '');
    setFormNotes(company.notes || '');
    setShowForm(true);
  };

  const saveCompany = async () => {
    const id = editingCompany ? editingCompany.id : formId.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id || !formName.trim()) {
      setMessage('Company ID and Name are required');
      return;
    }

    const data: Record<string, any> = {
      name: formName.trim(),
    };
    if (formAddress.trim()) data.address = formAddress.trim();
    if (formCity.trim()) data.city = formCity.trim();
    if (formState.trim()) data.state = formState.trim();
    if (formZip.trim()) data.zip = formZip.trim();
    if (formInvoicePrefix.trim()) data.invoicePrefix = formInvoicePrefix.trim();
    data.invoiceBook = formInvoiceBook;
    if (formTicketPrefix.trim()) data.ticketPrefix = formTicketPrefix.trim();
    if (formPhone.trim()) data.phone = formPhone.trim();
    if (formNotes.trim()) data.notes = formNotes.trim();

    try {
      if (editingCompany) {
        await updateDoc(doc(firestore, 'companies', id), data);
        setMessage(`Updated: ${formName.trim()}`);
      } else {
        await setDoc(doc(firestore, 'companies', id), data);
        setMessage(`Created: ${formName.trim()}`);
      }
      setShowForm(false);
      resetForm();
      await loadCompanies();
    } catch (err) {
      console.error('Failed to save company:', err);
      setMessage('Failed to save company');
    }
  };

  const deleteCompany = async (company: CompanyConfig) => {
    if (!confirm(`Delete ${company.name || company.id}? This will remove the company configuration.`)) return;
    try {
      await deleteDoc(doc(firestore, 'companies', company.id));
      setMessage(`Deleted: ${company.name || company.id}`);
      await loadCompanies();
    } catch (err) {
      console.error('Failed to delete company:', err);
      setMessage('Failed to delete company');
    }
  };

  // ── Operator assignment helpers ──

  const openOperatorModal = (companyId: string) => {
    setShowOperatorModal(companyId);
    setOperatorSearch('');
    setOperatorSuggestions([]);
    setSelectedOperator(null);
    setTimeout(() => operatorSearchRef.current?.focus(), 100);
  };

  const handleOperatorSearchChange = (text: string) => {
    setOperatorSearch(text);
    if (text.length < 1) {
      setOperatorSuggestions([]);
      return;
    }
    const results = searchOperators(text, allOperators, 10);
    // Filter out already-assigned operators
    const company = companies.find(c => c.id === showOperatorModal);
    const existing = new Set(company?.assignedOperators || []);
    setOperatorSuggestions(results.filter(op => !existing.has(op.name)));
  };

  const addOperator = async (companyId: string, operatorName: string) => {
    const company = companies.find(c => c.id === companyId);
    if (!company) return;

    const existing = company.assignedOperators || [];
    if (existing.includes(operatorName)) {
      setMessage(`${operatorName} is already assigned`);
      setShowOperatorModal(null);
      setOperatorSearch('');
      return;
    }

    const updated = [...existing, operatorName].sort();

    try {
      await updateDoc(doc(firestore, 'companies', companyId), {
        assignedOperators: updated,
      });
      setMessage(`Added: ${operatorName}`);
      setShowOperatorModal(null);
      setOperatorSearch('');
      await loadCompanies();
    } catch (err) {
      console.error('Failed to add operator:', err);
      setMessage('Failed to add operator');
    }
  };

  const removeOperator = async (companyId: string, operatorName: string) => {
    const company = companies.find(c => c.id === companyId);
    if (!company) return;

    const updated = (company.assignedOperators || []).filter(op => op !== operatorName);

    try {
      await updateDoc(doc(firestore, 'companies', companyId), {
        assignedOperators: updated,
      });
      setMessage(`Removed: ${operatorName}`);
      await loadCompanies();
    } catch (err) {
      console.error('Failed to remove operator:', err);
      setMessage('Failed to remove operator');
    }
  };

  // ── Rate Sheet helpers ──

  const JOB_TYPES = ['Production %', 'Service Work', 'Rig Move', 'Hot Shot', 'Frac Water', 'Other'];
  const BILLING_METHODS: { value: 'per_bbl' | 'hourly'; label: string }[] = [
    { value: 'per_bbl', label: '$/BBL' },
    { value: 'hourly', label: '$/hr' },
  ];

  const openRateSheet = (company: CompanyConfig, operator: string) => {
    setRateSheetCompany(company);
    setRateSheetOperator(operator);
    const existing = company.rateSheets?.[operator] || [];
    setRateSheetEntries(existing.length > 0 ? [...existing] : [
      { jobType: 'Production %', method: 'per_bbl', rate: 0 },
    ]);
  };

  const addRateEntry = () => {
    setRateSheetEntries(prev => [...prev, { jobType: '', method: 'per_bbl', rate: 0 }]);
  };

  const removeRateEntry = (idx: number) => {
    setRateSheetEntries(prev => prev.filter((_, i) => i !== idx));
  };

  const updateRateEntry = (idx: number, field: keyof RateEntry, value: any) => {
    setRateSheetEntries(prev => prev.map((entry, i) =>
      i === idx ? { ...entry, [field]: value } : entry
    ));
  };

  const saveRateSheet = async () => {
    if (!rateSheetCompany || !rateSheetOperator) return;
    setRateSheetSaving(true);
    try {
      const validEntries = rateSheetEntries.filter(e => e.jobType && e.rate > 0);
      const updatedSheets = { ...(rateSheetCompany.rateSheets || {}) };
      if (validEntries.length > 0) {
        updatedSheets[rateSheetOperator] = validEntries;
      } else {
        delete updatedSheets[rateSheetOperator];
      }
      await updateDoc(doc(firestore, 'companies', rateSheetCompany.id), {
        rateSheets: updatedSheets,
      });
      setMessage(`Rate sheet saved for ${rateSheetOperator}`);
      setRateSheetCompany(null);
      await loadCompanies();
    } catch (err) {
      console.error('Failed to save rate sheet:', err);
      setMessage('Failed to save rate sheet');
    } finally {
      setRateSheetSaving(false);
    }
  };

  // ── Pay Config helpers ──

  const openPayConfig = (company: CompanyConfig) => {
    setPayConfigCompany(company);
    const cfg = company.payConfig;
    setPayConfigSplit(cfg?.defaultSplit ? String(Math.round(cfg.defaultSplit * 100)) : '25');
    setPayConfigRounding(cfg?.payrollRounding || 'match_billing');
    setPayConfigPeriod(cfg?.payPeriod || 'weekly');
    setPayConfigAutoApprove(cfg?.autoApproveHours != null ? String(cfg.autoApproveHours) : '48');
  };

  const savePayConfig = async () => {
    if (!payConfigCompany) return;
    try {
      const config: PayConfig = {
        defaultSplit: Number(payConfigSplit) / 100,
        payrollRounding: payConfigRounding,
        payPeriod: payConfigPeriod,
        autoApproveHours: Number(payConfigAutoApprove) || 48,
      };
      await updateDoc(doc(firestore, 'companies', payConfigCompany.id), {
        payConfig: config,
      });
      setMessage(`Pay config saved for ${payConfigCompany.name}`);
      setPayConfigCompany(null);
      await loadCompanies();
    } catch (err) {
      console.error('Failed to save pay config:', err);
      setMessage('Failed to save pay config');
    }
  };

  // ── Branding helpers ──

  /** Extract up to 5 prominent colors from an image */
  const extractColorPalette = (imageUrl: string): Promise<string[]> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 100;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve([]); return; }

        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        // Bucket colors (quantize to reduce space)
        const colorCounts: Record<string, { r: number; g: number; b: number; count: number }> = {};

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 128) continue;

          const brightness = (r + g + b) / 3;
          if (brightness > 240 || brightness < 15) continue;

          // Quantize to nearest 24 (slightly coarser for better grouping)
          const qr = Math.round(r / 24) * 24;
          const qg = Math.round(g / 24) * 24;
          const qb = Math.round(b / 24) * 24;
          const key = `${qr},${qg},${qb}`;

          if (!colorCounts[key]) {
            colorCounts[key] = { r: qr, g: qg, b: qb, count: 0 };
          }
          colorCounts[key].count++;
        }

        // Score each color: prefer saturated + frequent
        const scored = Object.entries(colorCounts).map(([key, val]) => {
          const maxC = Math.max(val.r, val.g, val.b);
          const minC = Math.min(val.r, val.g, val.b);
          const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
          const score = val.count * (1 + saturation * 3);
          const hex = '#' + [val.r, val.g, val.b].map(c => Math.min(255, c).toString(16).padStart(2, '0')).join('');
          return { hex: hex.toUpperCase(), score, r: val.r, g: val.g, b: val.b };
        });

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Pick top colors that are visually distinct from each other
        const palette: string[] = [];
        const colorDistance = (a: typeof scored[0], b: typeof scored[0]) =>
          Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

        for (const color of scored) {
          if (palette.length >= 5) break;
          // Check if this color is distinct enough from already-picked colors
          const picked = palette.map(hex => scored.find(s => s.hex === hex)!);
          const tooClose = picked.some(p => colorDistance(color, p) < 60);
          if (!tooClose) {
            palette.push(color.hex);
          }
        }

        resolve(palette);
      };
      img.onerror = () => resolve([]);
      img.src = imageUrl;
    });
  };

  const handleLogoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate type
    if (!['image/png', 'image/jpeg', 'image/jpg'].includes(file.type)) {
      setMessage('Logo must be PNG or JPG');
      return;
    }

    // Validate size (500KB max)
    if (file.size > 500 * 1024) {
      setMessage('Logo must be under 500KB');
      return;
    }

    setLogoFile(file);
    const previewUrl = URL.createObjectURL(file);
    setLogoPreview(previewUrl);

    // Extract color palette from logo
    try {
      const palette = await extractColorPalette(previewUrl);
      setExtractedPalette(palette);
      setExtractedColor(palette[0] || null);
      setManualColor(palette[0] || '');
    } catch {
      setExtractedPalette([]);
      setExtractedColor(null);
    }
  };

  const openBrandingEditor = (company: CompanyConfig) => {
    setBrandingCompany(company.id);
    setLogoFile(null);
    setLogoPreview(company.logoUrl || null);
    setExtractedColor(company.primaryColor || null);
    setManualColor(company.primaryColor || '');

    // Extract color palette from existing logo (so user doesn't have to re-upload)
    if (company.logoUrl) {
      extractColorPalette(company.logoUrl)
        .then(palette => setExtractedPalette(palette))
        .catch(() => setExtractedPalette([]));
    } else {
      setExtractedPalette([]);
    }
  };

  const saveBranding = async () => {
    if (!brandingCompany) return;
    setBrandingSaving(true);

    try {
      const updates: Record<string, any> = {};
      let logoError = '';

      // Upload logo if a new file was selected
      if (logoFile) {
        try {
          const bucket = 'wellbuilt-sync.firebasestorage.app';
          const objectPath = `companies/${brandingCompany}/logo.png`;
          // Use storage.googleapis.com (has CORS configured) instead of firebasestorage.googleapis.com
          const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;

          const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': logoFile.type },
            body: logoFile,
          });

          if (!uploadRes.ok) {
            const errBody = await uploadRes.text();
            throw new Error(`Upload failed (${uploadRes.status}): ${errBody.slice(0, 100)}`);
          }

          const uploadData = await uploadRes.json();
          // Build a public download URL
          updates.logoUrl = `https://storage.googleapis.com/${bucket}/${objectPath}`;
        } catch (storageErr: any) {
          console.error('Logo upload failed:', storageErr);
          const errMsg = storageErr?.code || storageErr?.message || String(storageErr);
          logoError = `Logo failed: ${errMsg.slice(0, 150)}`;
        }
      }

      // Save primary color
      const color = manualColor.trim();
      if (color && /^#[0-9A-Fa-f]{6}$/.test(color)) {
        updates.primaryColor = color.toUpperCase();
      }

      if (Object.keys(updates).length > 0) {
        await updateDoc(doc(firestore, 'companies', brandingCompany), updates);
        if (logoError) {
          setMessage(logoError);
        } else {
          setMessage('Branding saved!');
        }
        await loadCompanies();
      } else {
        setMessage('No changes to save');
      }

      setBrandingCompany(null);
    } catch (err) {
      console.error('Failed to save branding:', err);
      setMessage('Failed to save branding');
    } finally {
      setBrandingSaving(false);
    }
  };

  // Company-scoped filtering: if scopeCompanyId is set, only show that company
  const scopedCompanies = scopeCompanyId
    ? companies.filter(c => c.id === scopeCompanyId)
    : companies;

  const filteredCompanies = search.trim()
    ? scopedCompanies.filter(c =>
        (c.name || c.id).toLowerCase().includes(search.toLowerCase()) ||
        c.id.toLowerCase().includes(search.toLowerCase())
      )
    : scopedCompanies;

  if (loading) {
    return (
      <div className="text-gray-400 text-center py-12">Loading companies...</div>
    );
  }

  return (
    <div className="space-y-6">
      {message && (
        <div className="p-3 bg-blue-900 text-blue-200 rounded text-sm">{message}</div>
      )}

      {/* ── Company List ── */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-medium">
            {scopeCompanyId ? 'Your Company' : `Companies (${scopedCompanies.length})`}
          </h3>
          <div className="flex gap-2">
            {!scopeCompanyId && (
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search..."
                className="px-3 py-1.5 bg-gray-700 text-white rounded text-sm placeholder-gray-500 w-40"
              />
            )}
            {isWbAdmin && (
              <button
                onClick={openAddForm}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm rounded"
              >
                + Add Company
              </button>
            )}
          </div>
        </div>

        {filteredCompanies.length === 0 ? (
          <div className="text-gray-500 text-center py-6">
            {search ? 'No companies match search' : 'No companies configured yet'}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredCompanies.map(company => (
              <div key={company.id} className="bg-gray-700 rounded overflow-hidden">
                {/* Company row */}
                <div
                  className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-600"
                  onClick={() => setExpandedCompany(expandedCompany === company.id ? null : company.id)}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-white font-medium">{company.name || company.id}</span>
                    <span className="text-gray-500 text-xs font-mono">{company.id}</span>
                    {company.invoicePrefix && (
                      <span className="px-1.5 py-0.5 bg-blue-700 text-blue-200 text-xs rounded">
                        {company.invoicePrefix}
                      </span>
                    )}
                    {company.invoiceBook && (
                      <span className="px-1.5 py-0.5 bg-teal-700 text-teal-200 text-xs rounded">
                        Invoice Book
                      </span>
                    )}
                    <span className={`px-1.5 py-0.5 text-xs rounded ${TIER_COLORS[company.tier || 'suite']}`}>
                      {TIER_LABELS[company.tier || 'suite']}
                    </span>
                    {(company.assignedOperators?.length || 0) > 0 && (
                      <span className="px-1.5 py-0.5 bg-yellow-700 text-yellow-200 text-xs rounded">
                        {company.assignedOperators!.length} oil {company.assignedOperators!.length === 1 ? 'co' : 'cos'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {isWbAdmin && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteCompany(company); }}
                        className="px-2 py-0.5 text-xs rounded bg-red-900/50 hover:bg-red-700 text-red-300"
                      >
                        Delete
                      </button>
                    )}
                    <span className="text-gray-400 text-sm">
                      {expandedCompany === company.id ? '▲' : '▼'}
                    </span>
                  </div>
                </div>

                {/* Expanded details */}
                {expandedCompany === company.id && (
                  <div className="border-t border-gray-600 p-3 space-y-3">
                    {/* ── Company Details ── */}
                    <div className="border-b border-gray-600 pb-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-blue-400 text-sm font-medium">Company Details</h4>
                        <button
                          onClick={() => openEditForm(company)}
                          className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
                        >
                          Edit Details
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <span className="text-gray-400">Address:</span>
                          <span className="text-white ml-2">{company.address || '—'}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">City:</span>
                          <span className="text-white ml-2">
                            {[company.city, company.state, company.zip].filter(Boolean).join(', ') || '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-400">Phone:</span>
                          <span className="text-white ml-2">{company.phone || '—'}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">Invoice Prefix:</span>
                          <span className="text-white ml-2">{company.invoicePrefix || '—'}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">Ticket Prefix:</span>
                          <span className="text-white ml-2">{company.ticketPrefix || '—'}</span>
                        </div>
                        <div>
                          <span className="text-gray-400">Invoice Book:</span>
                          <span className="text-white ml-2">{company.invoiceBook ? 'Yes' : 'No'}</span>
                        </div>
                      </div>
                    </div>
                    {company.notes && (
                      <div className="text-sm">
                        <span className="text-gray-400">Notes:</span>
                        <span className="text-gray-300 ml-2">{company.notes}</span>
                      </div>
                    )}

                    {/* ── Subscription Tier ── */}
                    <div className="border-t border-gray-600 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-green-400 text-sm font-medium">Subscription</h4>
                        <span className={`px-2 py-0.5 text-xs rounded font-medium ${TIER_COLORS[company.tier || 'suite']}`}>
                          {TIER_LABELS[company.tier || 'suite']}
                        </span>
                      </div>
                      <p className="text-gray-400 text-xs mb-2">
                        {TIER_DESCRIPTIONS[company.tier || 'suite']}
                      </p>
                      {isWbAdmin && (
                        <div className="flex gap-1.5">
                          {TIER_ORDER.map(tier => (
                            <button
                              key={tier}
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await updateDoc(doc(firestore, 'companies', company.id), { tier });
                                  setMessage(`${company.name} → ${TIER_LABELS[tier]}`);
                                  await loadCompanies();
                                } catch (err) {
                                  setMessage('Failed to update tier');
                                }
                              }}
                              className={`px-2.5 py-1 text-xs rounded transition-all ${
                                (company.tier || 'suite') === tier
                                  ? TIER_COLORS[tier] + ' ring-1 ring-white/30'
                                  : 'bg-gray-600/50 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
                              }`}
                            >
                              {TIER_LABELS[tier]}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* ── Oil Companies (Assigned Operators) ── */}
                    <div className="border-t border-gray-600 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-yellow-400 text-sm font-medium">
                          Oil Companies ({company.assignedOperators?.length || 0})
                        </h4>
                        <button
                          onClick={(e) => { e.stopPropagation(); openOperatorModal(company.id); }}
                          className="px-2 py-1 text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-white"
                        >
                          + Add Oil Company
                        </button>
                      </div>
                      {(company.assignedOperators?.length || 0) === 0 ? (
                        <div className="text-gray-500 text-xs py-2">
                          No oil companies assigned yet. Add the operators this company hauls for.
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {company.assignedOperators!.map(op => (
                            <div
                              key={op}
                              className="flex items-center gap-1.5 px-2 py-1 bg-yellow-900/40 border border-yellow-700/50 rounded text-sm"
                            >
                              <span className="text-yellow-200">{op}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); removeOperator(company.id, op); }}
                                className="text-red-400 hover:text-red-300 text-xs ml-1"
                                title="Remove"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* ── Rate Sheets (per operator) ── */}
                    {(company.assignedOperators?.length || 0) > 0 && (
                      <div className="border-t border-gray-600 pt-3">
                        <h4 className="text-green-400 text-sm font-medium mb-2">
                          Rate Sheets
                        </h4>
                        <div className="space-y-1">
                          {company.assignedOperators!.map(op => {
                            const rates = company.rateSheets?.[op];
                            const hasRates = rates && rates.length > 0;
                            return (
                              <div
                                key={op}
                                className="flex items-center justify-between px-2 py-1.5 bg-gray-700/30 rounded text-sm"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-gray-300">{op}</span>
                                  {hasRates ? (
                                    <span className="text-green-400 text-xs">
                                      {rates!.length} rate{rates!.length !== 1 ? 's' : ''}
                                      {' · '}
                                      {rates!.map(r => `${r.jobType}: $${r.rate}${r.method === 'per_bbl' ? '/bbl' : '/hr'}`).join(', ')}
                                    </span>
                                  ) : (
                                    <span className="text-gray-500 text-xs">No rates set</span>
                                  )}
                                </div>
                                <button
                                  onClick={(e) => { e.stopPropagation(); openRateSheet(company, op); }}
                                  className="px-2 py-0.5 text-xs rounded bg-green-700 hover:bg-green-600 text-white"
                                >
                                  {hasRates ? 'Edit' : '+ Set Rates'}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── Pay Config ── */}
                    <div className="border-t border-gray-600 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-cyan-400 text-sm font-medium">
                          Payroll Config
                        </h4>
                        <button
                          onClick={(e) => { e.stopPropagation(); openPayConfig(company); }}
                          className="px-2 py-1 text-xs rounded bg-cyan-700 hover:bg-cyan-600 text-white"
                        >
                          {company.payConfig ? 'Edit Config' : '+ Set Up Payroll'}
                        </button>
                      </div>
                      {company.payConfig ? (
                        <div className="flex flex-wrap gap-3 text-xs">
                          <span className="text-gray-400">
                            Split: <span className="text-cyan-300">{Math.round(company.payConfig.defaultSplit * 100)}%</span>
                          </span>
                          <span className="text-gray-400">
                            Period: <span className="text-cyan-300">{company.payConfig.payPeriod}</span>
                          </span>
                          <span className="text-gray-400">
                            Rounding: <span className="text-cyan-300">
                              {company.payConfig.payrollRounding === 'match_billing' ? 'Match billing' : company.payConfig.payrollRounding}
                            </span>
                          </span>
                          <span className="text-gray-400">
                            Auto-approve: <span className="text-cyan-300">{company.payConfig.autoApproveHours || 48}h</span>
                          </span>
                        </div>
                      ) : (
                        <div className="text-gray-500 text-xs py-1">
                          Not configured yet. Set up employee split, pay period, and rounding.
                        </div>
                      )}
                    </div>

                    {/* ── Branding ── */}
                    <div className="border-t border-gray-600 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-purple-400 text-sm font-medium">
                          Branding
                        </h4>
                        <button
                          onClick={(e) => { e.stopPropagation(); openBrandingEditor(company); }}
                          className="px-2 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white"
                        >
                          {company.logoUrl || company.primaryColor ? 'Edit Branding' : '+ Set Up Branding'}
                        </button>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        {company.logoUrl ? (
                          <img
                            src={company.logoUrl}
                            alt={`${company.name} logo`}
                            className="h-10 w-auto rounded bg-white/10 p-1"
                          />
                        ) : (
                          <span className="text-gray-500 text-xs">No logo uploaded</span>
                        )}
                        {company.primaryColor ? (
                          <div className="flex items-center gap-2">
                            <div
                              className="w-6 h-6 rounded border border-gray-500"
                              style={{ backgroundColor: company.primaryColor }}
                            />
                            <span className="text-gray-300 font-mono text-xs">{company.primaryColor}</span>
                          </div>
                        ) : (
                          <span className="text-gray-500 text-xs">Default gold (#FFD700)</span>
                        )}
                      </div>
                    </div>

                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Add Operator Modal ── */}
      {showOperatorModal && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Add Oil Company</h3>
            <p className="text-gray-400 text-xs mb-4">
              Search NDIC operators and click to add.
            </p>

            <input
              ref={operatorSearchRef}
              type="text"
              value={operatorSearch}
              onChange={e => handleOperatorSearchChange(e.target.value)}
              placeholder="Type operator name (e.g., HESS, SLAWSON)..."
              className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
              autoFocus
            />

            {/* Results — exact same pattern as NDIC picker in admin page */}
            {operatorSuggestions.length > 0 && (
              <div className="bg-gray-900 rounded mt-1 max-h-48 overflow-y-auto">
                {operatorSuggestions.map(op => (
                  <div
                    key={op.name}
                    onClick={() => addOperator(showOperatorModal!, op.name)}
                    className="px-3 py-2 hover:bg-gray-700 cursor-pointer text-white text-sm"
                  >
                    {op.name}
                    {op.well_count && (
                      <span className="text-gray-500 ml-2">({op.well_count} wells)</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {operatorSearch.length >= 2 && operatorSuggestions.length === 0 && (
              <p className="text-gray-500 text-sm mt-2">No matching operators found</p>
            )}

            <div className="flex justify-end mt-4">
              <button
                onClick={() => { setShowOperatorModal(null); setOperatorSearch(''); setSelectedOperator(null); }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add / Edit Company Modal ── */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto">
            <h3 className="text-white font-medium mb-4">
              {editingCompany ? `Edit: ${editingCompany.name || editingCompany.id}` : 'Add New Company'}
            </h3>

            <div className="space-y-3">
              {!editingCompany && (
                <div>
                  <label className="text-gray-400 text-sm block mb-1">
                    Company ID (lowercase, no spaces — used as Firestore doc ID)
                  </label>
                  <input
                    type="text"
                    value={formId}
                    onChange={e => setFormId(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                    placeholder="e.g., hess, slawson"
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                    autoFocus
                  />
                </div>
              )}
              <div>
                <label className="text-gray-400 text-sm block mb-1">Company Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g., HESS CORPORATION"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  autoFocus={!!editingCompany}
                />
              </div>
              <div>
                <label className="text-gray-400 text-sm block mb-1">Address</label>
                <input
                  type="text"
                  value={formAddress}
                  onChange={e => setFormAddress(e.target.value)}
                  placeholder="Street address"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-gray-400 text-sm block mb-1">City</label>
                  <input
                    type="text"
                    value={formCity}
                    onChange={e => setFormCity(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-gray-400 text-sm block mb-1">State</label>
                  <input
                    type="text"
                    value={formState}
                    onChange={e => setFormState(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                    maxLength={2}
                  />
                </div>
                <div>
                  <label className="text-gray-400 text-sm block mb-1">ZIP</label>
                  <input
                    type="text"
                    value={formZip}
                    onChange={e => setFormZip(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-gray-400 text-sm block mb-1">Phone</label>
                <input
                  type="text"
                  value={formPhone}
                  onChange={e => {
                    const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                    if (digits.length <= 3) setFormPhone(digits.length ? `(${digits}` : '');
                    else if (digits.length <= 6) setFormPhone(`(${digits.slice(0,3)}) ${digits.slice(3)}`);
                    else setFormPhone(`(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`);
                  }}
                  placeholder="(xxx) xxx-xxxx"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-gray-400 text-sm block mb-1">Invoice Prefix</label>
                  <input
                    type="text"
                    value={formInvoicePrefix}
                    onChange={e => setFormInvoicePrefix(e.target.value)}
                    placeholder="e.g., LG"
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-gray-400 text-sm block mb-1">Ticket Prefix</label>
                  <input
                    type="text"
                    value={formTicketPrefix}
                    onChange={e => setFormTicketPrefix(e.target.value)}
                    placeholder="e.g., WT"
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="invoiceBook"
                  checked={formInvoiceBook}
                  onChange={e => setFormInvoiceBook(e.target.checked)}
                  className="rounded"
                />
                <label htmlFor="invoiceBook" className="text-gray-300 text-sm">
                  Uses Invoice Book (sequential invoice numbering)
                </label>
              </div>
              <div>
                <label className="text-gray-400 text-sm block mb-1">Notes</label>
                <textarea
                  value={formNotes}
                  onChange={e => setFormNotes(e.target.value)}
                  placeholder="Any special instructions..."
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm h-20 resize-none"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={saveCompany}
                disabled={!formName.trim() || (!editingCompany && !formId.trim())}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {editingCompany ? 'Update' : 'Create'}
              </button>
              <button
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Branding Editor Modal ── */}
      {brandingCompany && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Company Branding</h3>
            <p className="text-gray-400 text-xs mb-4">
              Upload a logo and set your accent color. Drivers will see this on their tickets and invoices.
            </p>

            {/* Logo Upload */}
            <div className="mb-4">
              <label className="text-gray-400 text-sm block mb-2">Company Logo</label>
              <div className="flex items-center gap-4">
                {logoPreview ? (
                  <div className="relative">
                    <img
                      src={logoPreview}
                      alt="Logo preview"
                      className="h-16 w-auto rounded bg-white/10 p-1"
                    />
                    <button
                      onClick={() => { setLogoFile(null); setLogoPreview(null); setExtractedColor(null); setExtractedPalette([]); }}
                      className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="h-16 w-16 rounded border-2 border-dashed border-gray-600 flex items-center justify-center">
                    <span className="text-gray-500 text-2xl">+</span>
                  </div>
                )}
                <div>
                  <button
                    onClick={() => logoInputRef.current?.click()}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded"
                  >
                    {logoPreview ? 'Change Logo' : 'Upload Logo'}
                  </button>
                  <p className="text-gray-500 text-xs mt-1">PNG or JPG, max 500KB</p>
                </div>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={handleLogoSelect}
                  className="hidden"
                />
              </div>
            </div>

            {/* Color Section */}
            <div className="mb-4">
              <label className="text-gray-400 text-sm block mb-2">Accent Color</label>

              {/* Extracted palette swatches */}
              {extractedPalette.length > 0 && (
                <div className="mb-3">
                  <div className="text-gray-500 text-xs mb-1.5">Colors from your logo — click to select:</div>
                  <div className="flex gap-2">
                    {extractedPalette.map((color, i) => (
                      <button
                        key={i}
                        onClick={() => { setManualColor(color); setExtractedColor(color); }}
                        className="relative group"
                        title={color}
                      >
                        <div
                          className="w-10 h-10 rounded-lg border-2 transition-all"
                          style={{
                            backgroundColor: color,
                            borderColor: manualColor === color ? '#FFFFFF' : 'transparent',
                            boxShadow: manualColor === color ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
                          }}
                        />
                        {manualColor === color && (
                          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-white rounded-full" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Manual hex input + picker fallback */}
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={manualColor || '#FFD700'}
                  onChange={e => setManualColor(e.target.value.toUpperCase())}
                  className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                  title="Custom color picker"
                />
                <input
                  type="text"
                  value={manualColor}
                  onChange={e => setManualColor(e.target.value.toUpperCase())}
                  placeholder="#FFD700"
                  maxLength={7}
                  className="px-3 py-2 bg-gray-700 text-white rounded text-sm font-mono w-28"
                />
                <span className="text-gray-500 text-xs">or pick custom</span>
              </div>
            </div>

            {/* Preview Strip */}
            {manualColor && /^#[0-9A-Fa-f]{6}$/.test(manualColor) && (
              <div
                className="mb-4 p-3 rounded-lg border"
                style={{ borderColor: manualColor, backgroundColor: '#1a1a0a' }}
              >
                <div className="flex items-center gap-2 justify-center mb-1">
                  <span style={{ color: manualColor }} className="text-sm font-bold tracking-widest">EN ROUTE</span>
                </div>
                <div className="text-white text-center text-sm font-semibold">Sample Well Name</div>
                <div className="flex justify-center mt-2">
                  <div
                    className="px-6 py-2 rounded-lg text-sm font-bold text-black"
                    style={{ backgroundColor: manualColor }}
                  >
                    Arrived
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={saveBranding}
                disabled={brandingSaving}
                className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50"
              >
                {brandingSaving ? 'Saving...' : 'Save Branding'}
              </button>
              <button
                onClick={() => setBrandingCompany(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rate Sheet Modal ── */}
      {rateSheetCompany && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4">
            <h3 className="text-white font-medium mb-1">Rate Sheet</h3>
            <p className="text-gray-400 text-xs mb-4">
              {rateSheetCompany.name} → {rateSheetOperator}
            </p>

            <div className="space-y-3 mb-4 max-h-80 overflow-y-auto">
              {rateSheetEntries.map((entry, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  {/* Job Type */}
                  <select
                    value={entry.jobType}
                    onChange={e => updateRateEntry(idx, 'jobType', e.target.value)}
                    className="flex-1 px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                  >
                    <option value="">Select job type...</option>
                    {JOB_TYPES.map(jt => (
                      <option key={jt} value={jt}>{jt}</option>
                    ))}
                  </select>

                  {/* Billing Method */}
                  <select
                    value={entry.method}
                    onChange={e => updateRateEntry(idx, 'method', e.target.value)}
                    className="w-24 px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                  >
                    {BILLING_METHODS.map(bm => (
                      <option key={bm.value} value={bm.value}>{bm.label}</option>
                    ))}
                  </select>

                  {/* Rate */}
                  <div className="relative w-28">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={entry.rate || ''}
                      onChange={e => updateRateEntry(idx, 'rate', parseFloat(e.target.value) || 0)}
                      className="w-full pl-6 pr-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                      placeholder="0.00"
                    />
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => removeRateEntry(idx)}
                    className="text-red-400 hover:text-red-300 text-sm px-1"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={addRateEntry}
              className="text-green-400 hover:text-green-300 text-xs mb-4"
            >
              + Add Rate
            </button>

            <div className="flex gap-2">
              <button
                onClick={saveRateSheet}
                disabled={rateSheetSaving}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded disabled:opacity-50"
              >
                {rateSheetSaving ? 'Saving...' : 'Save Rates'}
              </button>
              <button
                onClick={() => setRateSheetCompany(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Pay Config Modal ── */}
      {payConfigCompany && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Payroll Configuration</h3>
            <p className="text-gray-400 text-xs mb-4">{payConfigCompany.name}</p>

            <div className="space-y-4">
              {/* Employee Split */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Employee Split (%)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={payConfigSplit}
                    onChange={e => setPayConfigSplit(e.target.value)}
                    className="w-24 px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  />
                  <span className="text-gray-400 text-sm">%</span>
                  <span className="text-gray-500 text-xs ml-2">
                    (driver gets {payConfigSplit}% of amount billed)
                  </span>
                </div>
              </div>

              {/* Pay Period */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Pay Period</label>
                <select
                  value={payConfigPeriod}
                  onChange={e => setPayConfigPeriod(e.target.value as PayConfig['payPeriod'])}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Bi-Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>

              {/* Payroll Rounding */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Payroll Time Rounding</label>
                <select
                  value={payConfigRounding}
                  onChange={e => setPayConfigRounding(e.target.value as PayConfig['payrollRounding'])}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  <option value="match_billing">Match billing rounding (per operator)</option>
                  <option value="none">No rounding (to the minute)</option>
                  <option value="quarter_hour">Quarter hour</option>
                  <option value="half_hour">Half hour</option>
                </select>
                {payConfigRounding === 'match_billing' && (
                  <p className="text-gray-500 text-xs mt-1">
                    Payroll hours will match whatever rounding each oil company uses for billing.
                  </p>
                )}
              </div>

              {/* Auto-Approve */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Auto-Approve Deadline (hours)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={payConfigAutoApprove}
                    onChange={e => setPayConfigAutoApprove(e.target.value)}
                    className="w-24 px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  />
                  <span className="text-gray-400 text-sm">hours</span>
                </div>
                <p className="text-gray-500 text-xs mt-1">
                  If driver doesn&apos;t respond within this time, timesheet is auto-approved. Set 0 to disable.
                </p>
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <button
                onClick={savePayConfig}
                className="flex-1 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded"
              >
                Save Config
              </button>
              <button
                onClick={() => setPayConfigCompany(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
