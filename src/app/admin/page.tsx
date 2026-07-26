'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { isWbPlatformAdmin } from '@/lib/auth';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';
import { getFirebaseDatabase, getFirestoreDb } from '@/lib/firebase';
import {
  WELL_EDITOR_DEFAULTS,
  buildEditorSavePayload,
  effectiveBblPerFoot,
  normalizeWellEditorFields,
} from '@/lib/wellEditorFields';
import { ref, get, set, remove, onValue, query, orderByChild, equalTo, update } from 'firebase/database';
import { doc, getDoc } from 'firebase/firestore';
import {
  loadOperators,
  loadWellsForOperator,
  searchWellsByName,
  searchOperators,
  loadInactiveWellsForOperator,
  suggestDisplayName,
  type NdicWell,
  type NdicOperator,
} from '@/lib/firestoreWells';
import { DriversTab } from '@/components/admin/DriversTab';
import { CompaniesTab } from '@/components/admin/CompaniesTab';
import GpsRoutesTab from '@/components/admin/GpsRoutesTab';
import { EquipmentTab } from '@/components/admin/EquipmentTab';
import { BulkWellImportModal } from '@/components/admin/BulkWellImportModal';
import type { ImportRow } from '@/lib/bulkWellImport';
import { buildWellConfig } from '@/lib/wellConfigBuilder';
import { addMaintainedWell, removeMaintainedWell, subscribeMaintainedWellNames } from '@/lib/maintainedWells';

interface WellConfig {
  route?: string;
  bottomLevel?: number;
  tanks?: number;
  pullBbls?: number;
  // Tank dimensions — derive bblPerFoot from these
  tankCapacity?: number;  // BBL per tank (default 400)
  tankHeight?: number;    // feet per tank (default 20)
  bblPerFoot?: number;    // EFFECTIVE bbl/ft consumed by WB M/WB T math: bblPerFootOverride if set, else (tankCapacity / tankHeight) * activeTanks
  // Flow-math config (2026-06-14) — supports different tank sizes + real flow-rate calc
  activeTanks?: number;        // tanks actively flowing; defaults to physical `tanks`; drives the derived bblPerFoot
  bblPerFootOverride?: number | null; // manual bbl/ft override; when present, bblPerFoot is saved equal to this (raw kept so admin knows it was manual); null clears a prior override
  equalizedTanks?: boolean;    // tanks plumbed equalized (rise together) vs filled one-at-a-time
  requireActualBottom?: boolean; // force driver to enter a measured bottom instead of the configured value (WB T wiring later)
  // App-compatible field names (duplicates for compatibility)
  allowedBottom?: number;
  numTanks?: number;
  // NDIC well linkage — used by WB Tickets for WB Mobile integration
  ndicName?: string;   // Full NDIC well name (e.g. "GABRIEL 1-36-25H")
  ndicApiNo?: string;  // NDIC API number (e.g. "33-053-06789-00-00")
  avgFlowRate?: string;
  // Water properties — used for smart dispatch (service work sourcing)
  waterWeight?: number;     // lbs/gal (default ~8.34 for fresh, 8.5-10+ for produced)
  h2sStatus?: 'none' | 'low' | 'high' | 'unknown';  // H2S presence at well
  // Route recording — GPS breadcrumb capture for wells with bad Google Maps directions
  routeRecording?: boolean;
  // Well pad grouping — wells on the same pad share routes with a primary well
  routeGroupWell?: string;
}

interface RouteWells {
  [route: string]: string[];
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  // Model B tenant scope. Customer admin: their own companyId. WB platform admin:
  // a company they pick (selector in the header). Used for BOTH read scoping and
  // write attribution. well_config stays shared/untouched.
  const isPlatformAdmin = isWbPlatformAdmin(user);
  const [allCompanies, setAllCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const activeCompanyId = user?.companyId ?? (isPlatformAdmin ? selectedCompanyId : null);
  const router = useRouter();
  const [configs, setConfigs] = useState<Record<string, WellConfig>>({});
  const [routes, setRoutes] = useState<string[]>([]);
  const [routeWells, setRouteWells] = useState<RouteWells>({});
  const [selectedRoute, setSelectedRoute] = useState<string>('');
  const [selectedWell, setSelectedWell] = useState<string>('');

  // Model B read scoping: the Admin Panel always shows ONLY the active company's
  // maintained wells (customer = own companyId; WB platform admin = selected
  // company). well_config stays shared; we filter the DISPLAY by membership.
  // Handlers/dup-checks stay global (well_config is name-keyed + shared).
  const [maintainedNames, setMaintainedNames] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!activeCompanyId) { setMaintainedNames(null); return; }
    return subscribeMaintainedWellNames(activeCompanyId, setMaintainedNames);
  }, [activeCompanyId]);

  // WB platform admin: load the company list for the selector + default-select.
  useEffect(() => {
    if (!isPlatformAdmin) return;
    loadAllCompanies()
      .then(list => {
        setAllCompanies(list);
        setSelectedCompanyId(prev => prev ?? (list.find(c => c.id === 'liquid-gold')?.id ?? list[0]?.id ?? null));
      })
      .catch(() => {});
  }, [isPlatformAdmin]);

  const visibleConfigs = useMemo(() => {
    if (!maintainedNames) return {};   // no active company / membership loading = show nothing
    const out: Record<string, WellConfig> = {};
    for (const k of Object.keys(configs)) if (maintainedNames.has(k)) out[k] = configs[k];
    return out;
  }, [configs, maintainedNames]);
  const visibleRoutes = useMemo(() => {
    const set = new Set<string>(['Unrouted']);
    Object.values(visibleConfigs).forEach(c => set.add(c.route || 'Unrouted'));
    return Array.from(set).sort();
  }, [visibleConfigs]);
  const visibleRouteWells = useMemo(() => {
    const map: RouteWells = {};
    Object.entries(visibleConfigs).forEach(([name, c]) => {
      const r = c.route || 'Unrouted';
      (map[r] = map[r] || []).push(name);
    });
    return map;
  }, [visibleConfigs]);

  // New route/well forms
  const [newRouteName, setNewRouteName] = useState('');
  const [newWellName, setNewWellName] = useState('');
  // Search inputs are decoupled from the well name so users can name the well
  // however they want for drivers (e.g. "Sparrow SOG") while finding the legal
  // record by typing the canonical name (e.g. "Sparrow 1-10H") in the search box.
  const [newWellSearchTerm, setNewWellSearchTerm] = useState('');
  const [newWellSearchState, setNewWellSearchState] = useState<'all' | 'ND' | 'MT'>('all');
  const [newWellRoute, setNewWellRoute] = useState('');
  const [newWellBottom, setNewWellBottom] = useState('3');
  const [newWellTanks, setNewWellTanks] = useState('1');
  const [newWellPullBbls, setNewWellPullBbls] = useState('140');
  const [newWellTankCapacity, setNewWellTankCapacity] = useState('400');
  const [newWellTankHeight, setNewWellTankHeight] = useState('20');
  const [newWellWaterWeight, setNewWellWaterWeight] = useState('');
  const [newWellH2s, setNewWellH2s] = useState<'none' | 'low' | 'high' | 'unknown'>('unknown');
  // Flow-math config (2026-06-14)
  const [newWellActiveTanks, setNewWellActiveTanks] = useState('');          // blank = defaults to physical tanks
  const [newWellBblPerFootOverride, setNewWellBblPerFootOverride] = useState(''); // blank = use derived
  const [newWellEqualized, setNewWellEqualized] = useState(false);
  const [newWellRequireActualBottom, setNewWellRequireActualBottom] = useState(false);
  // Tank calculator (optional — for when there's no nameplate)
  // Shared Tank Capacity Calculator modal (used by both Add + Edit Well)
  const [tankCalcTarget, setTankCalcTarget] = useState<'add' | 'edit' | null>(null);
  const [calcDiameter, setCalcDiameter] = useState('');
  const [calcUsableHeight, setCalcUsableHeight] = useState('');

  // Edit well form
  const [editWellRoute, setEditWellRoute] = useState('');
  const [editWellBottom, setEditWellBottom] = useState('');
  const [editWellTanks, setEditWellTanks] = useState('');
  const [editWellPullBbls, setEditWellPullBbls] = useState('');
  const [editWellTankCapacity, setEditWellTankCapacity] = useState('');
  const [editWellTankHeight, setEditWellTankHeight] = useState('');
  const [editWellWaterWeight, setEditWellWaterWeight] = useState('');
  const [editWellH2s, setEditWellH2s] = useState<'none' | 'low' | 'high' | 'unknown'>('unknown');
  // Flow-math config (2026-06-14)
  const [editWellActiveTanks, setEditWellActiveTanks] = useState('');
  const [editWellBblPerFootOverride, setEditWellBblPerFootOverride] = useState('');
  // 7/26 default-truth: which engineering fields the SELECTED record actually
  // persists (any alias). false ⇒ the form shows an unsaved default and the
  // UI must say so instead of presenting it as stored.
  const [editFieldPresence, setEditFieldPresence] = useState({
    bottom: true, pullBbls: true, tankCapacity: true, tankHeight: true, bblPerFoot: true,
  });
  const [editWellEqualized, setEditWellEqualized] = useState(false);
  const [editWellRequireActualBottom, setEditWellRequireActualBottom] = useState(false);

  // Read-only route info for Edit Well panel
  const [wellRouteInfo, setWellRouteInfo] = useState<{ labels: string[]; count: number } | null>(null);
  const [wellPadGroup, setWellPadGroup] = useState<string[] | null>(null);

  // NDIC well picker — shared between Add and Edit forms
  const [ndicOperators, setNdicOperators] = useState<NdicOperator[]>([]);
  const [ndicOperatorSearch, setNdicOperatorSearch] = useState('');
  const [ndicOperatorResults, setNdicOperatorResults] = useState<NdicOperator[]>([]);
  const [ndicCheckedOperators, setNdicCheckedOperators] = useState<string[]>([]);
  const [ndicOperatorWells, setNdicOperatorWells] = useState<NdicWell[]>([]);
  const [ndicWellSearch, setNdicWellSearch] = useState('');
  const [ndicWellResults, setNdicWellResults] = useState<NdicWell[]>([]);
  const [ndicSelectedWell, setNdicSelectedWell] = useState<NdicWell | null>(null);
  const [ndicLoadingWells, setNdicLoadingWells] = useState(false);
  const [showNdicPicker, setShowNdicPicker] = useState(false);
  // Which form is using the NDIC picker: 'add' or 'edit'
  const [ndicPickerTarget, setNdicPickerTarget] = useState<'add' | 'edit'>('add');

  // Auto-link: pre-loaded operator wells for instant matching
  const [autoLinkWells, setAutoLinkWells] = useState<NdicWell[]>([]);
  const [autoLinkStatus, setAutoLinkStatus] = useState<'idle' | 'loading' | 'matched' | 'no_match'>('idle');

  // NDIC picker for edit form — stored NDIC link
  const [editNdicName, setEditNdicName] = useState('');
  const [editNdicApiNo, setEditNdicApiNo] = useState('');

  const [message, setMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'routes' | 'wells' | 'drivers' | 'companies' | 'gpsroutes' | 'equipment'>('wells');
  const [showBulkImport, setShowBulkImport] = useState(false);

  // Read ?tab= from URL to deep-link into specific admin section (e.g. from pulsing Admin badge)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const validTabs = ['routes', 'wells', 'drivers', 'companies', 'gpsroutes', 'equipment'];
    if (tab && validTabs.includes(tab)) {
      setActiveTab(tab as any);
    }
  }, []);

  // Search filters
  const [wellSearch, setWellSearch] = useState('');
  const [routeSearch, setRouteSearch] = useState('');

  // Firebase path key restrictions - these characters break database paths
  const FORBIDDEN_CHARS = /[.$#\[\]\/]/;
  const [badCharAttempts, setBadCharAttempts] = useState(0);

  // Filter out forbidden characters and beep after 3 attempts
  const filterForbiddenChars = (value: string, setter: (v: string) => void) => {
    const filtered = value.replace(FORBIDDEN_CHARS, '');
    if (filtered !== value) {
      // Bad character was typed
      const newAttempts = badCharAttempts + 1;
      setBadCharAttempts(newAttempts);
      if (newAttempts >= 3) {
        // Dramatic descending "nooooo" death sound
        try {
          const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
          const now = ctx.currentTime;

          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sawtooth'; // Buzzy, dramatic tone
          // Start high, slide down dramatically
          osc.frequency.setValueAtTime(600, now);
          osc.frequency.exponentialRampToValueAtTime(100, now + 0.6);
          // Fade out
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
          osc.start(now);
          osc.stop(now + 0.6);
        } catch {
          // No audio available
        }
        setBadCharAttempts(0); // Reset counter after beep
      }
    }
    setter(filtered);
  };

  const validateName = (name: string): string | null => {
    if (!name.trim()) return 'Name cannot be empty';
    return null; // valid (forbidden chars already filtered out on input)
  };

  // Parse level input: "10 4" | "10.33" | "10'4\"" | "10'4" → decimal feet
  const parseLevelToFeet = (input: string): number => {
    const s = input.trim();
    if (!s) return 0;
    // "10'4\"" or "10'4" — feet'inches
    const feetInchMatch = s.match(/^(\d+)\s*['']\s*(\d+)\s*[""]?\s*$/);
    if (feetInchMatch) return parseInt(feetInchMatch[1]) + parseInt(feetInchMatch[2]) / 12;
    // "10 4" — space separated feet inches
    const spaceMatch = s.match(/^(\d+)\s+(\d+)\s*$/);
    if (spaceMatch) return parseInt(spaceMatch[1]) + parseInt(spaceMatch[2]) / 12;
    // Plain number (decimal feet)
    const num = parseFloat(s);
    return isNaN(num) ? 0 : num;
  };

  // Format decimal feet to display: 3.33 → "3'4\""
  const feetToDisplay = (ft: number): string => {
    const wholeFeet = Math.floor(ft);
    const inches = Math.round((ft - wholeFeet) * 12);
    return `${wholeFeet}'${inches}"`;
  };

  // Edit well name state
  const [editWellName, setEditWellName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Edit route name state
  const [editRouteName, setEditRouteName] = useState('');
  const [isRenamingRoute, setIsRenamingRoute] = useState(false);

  // Delete confirmation modals
  const [showDeleteRouteModal, setShowDeleteRouteModal] = useState(false);
  const [deleteRouteAction, setDeleteRouteAction] = useState<'unassign' | 'delete' | null>(null);
  const [showDeleteWellModal, setShowDeleteWellModal] = useState(false);

  // Redirect if not admin/IT
  useEffect(() => {
    if (!loading && (!user || (user.role !== 'admin' && user.role !== 'it'))) {
      router.push('/');
    }
  }, [user, loading, router]);

  // Load configs
  useEffect(() => {
    const db = getFirebaseDatabase();
    const configRef = ref(db, 'well_config');

    const unsubscribe = onValue(configRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val() as Record<string, WellConfig>;
        setConfigs(data);

        // Extract routes and organize wells by route
        const routeSet = new Set<string>(['Unrouted']);
        const wellsByRoute: RouteWells = { 'Unrouted': [] };

        Object.entries(data).forEach(([wellName, config]) => {
          const route = config.route || 'Unrouted';
          routeSet.add(route);
          if (!wellsByRoute[route]) {
            wellsByRoute[route] = [];
          }
          wellsByRoute[route].push(wellName);
        });

        // Sort wells alphabetically within each route
        Object.keys(wellsByRoute).forEach(route => {
          wellsByRoute[route].sort();
        });

        setRoutes(Array.from(routeSet).sort());
        setRouteWells(wellsByRoute);
      }
    });

    return () => unsubscribe();
  }, []);

  // Load selected well config into edit form
  useEffect(() => {
    if (selectedWell && configs[selectedWell]) {
      const config = configs[selectedWell];
      setEditWellName(selectedWell); // Set the editable name
      setEditWellRoute(config.route || 'Unrouted');
      // 7/26 default-truth: seed from the presence-aware normalizer so a
      // legacy record's REAL values (e.g. Gab 1's allowedBottom=1.33, hidden
      // behind `bottomLevel || 3`) load into the form, and so missing
      // engineering fields are KNOWN to be defaults (editFieldPresence) and
      // rendered as "Default — not saved" instead of looking persisted.
      const norm = normalizeWellEditorFields(config as unknown as Record<string, unknown>);
      setEditWellBottom(String(norm.bottomFeet.value ?? WELL_EDITOR_DEFAULTS.bottomFeet));
      setEditWellTanks(String(norm.tanks.value ?? WELL_EDITOR_DEFAULTS.tanks));
      setEditWellPullBbls(String(norm.pullBbls.value ?? WELL_EDITOR_DEFAULTS.pullBbls));
      setEditWellTankCapacity(String(norm.tankCapacity.value ?? WELL_EDITOR_DEFAULTS.tankCapacity));
      setEditWellTankHeight(String(norm.tankHeight.value ?? WELL_EDITOR_DEFAULTS.tankHeight));
      setEditFieldPresence({
        bottom: norm.bottomFeet.present,
        pullBbls: norm.pullBbls.present,
        tankCapacity: norm.tankCapacity.present,
        tankHeight: norm.tankHeight.present,
        bblPerFoot: norm.bblPerFoot.present,
      });
      setEditWellWaterWeight(config.waterWeight ? String(config.waterWeight) : '');
      setEditWellH2s((config as any).h2sStatus || 'unknown');
      // Flow-math config — activeTanks defaults to physical tanks when unset
      setEditWellActiveTanks(config.activeTanks != null ? String(config.activeTanks) : '');
      setEditWellBblPerFootOverride(config.bblPerFootOverride != null ? String(config.bblPerFootOverride) : '');
      setEditWellEqualized(!!config.equalizedTanks);
      setEditWellRequireActualBottom(!!config.requireActualBottom);
      // Load NDIC linkage if present
      setEditNdicName(config.ndicName || '');
      setEditNdicApiNo(config.ndicApiNo || '');
    }
  }, [selectedWell, configs]);

  // Auto-link NDIC for Edit Well — if selected well has no ndicName, try to find a match
  useEffect(() => {
    if (!selectedWell || autoLinkWells.length === 0) return;
    const config = configs[selectedWell];
    if (config?.ndicName) return; // Already linked

    const matches = searchWellsByName(selectedWell, autoLinkWells, 10);
    if (matches.length === 1) {
      setEditNdicName(matches[0].well_name);
      setEditNdicApiNo(matches[0].api_no);
    } else if (matches.length > 1) {
      const exactish = matches.find(m =>
        m.well_name.toLowerCase().startsWith(selectedWell.toLowerCase() + ' ') ||
        m.well_name.toLowerCase().startsWith(selectedWell.toLowerCase() + '-')
      );
      if (exactish) {
        setEditNdicName(exactish.well_name);
        setEditNdicApiNo(exactish.api_no);
      }
    }
  }, [selectedWell, autoLinkWells, configs]);

  // Load route info + pad group for selected well (read-only display)
  useEffect(() => {
    if (!selectedWell) {
      setWellRouteInfo(null);
      setWellPadGroup(null);
      return;
    }

    // Pad group — find all wells sharing the same routeGroupWell
    const config = configs[selectedWell];
    if (config?.routeGroupWell) {
      const members = Object.entries(configs)
        .filter(([, cfg]) => cfg.routeGroupWell === config.routeGroupWell)
        .map(([name]) => name)
        .sort();
      setWellPadGroup(members);
    } else {
      setWellPadGroup(null);
    }

    // Approved routes from Firestore
    const slug = selectedWell.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 120);
    // Use the group's primary well slug if grouped
    const routeSlug = config?.routeGroupWell
      ? config.routeGroupWell.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 120)
      : slug;

    const fsDb = getFirestoreDb();
    getDoc(doc(fsDb, 'route_overrides', routeSlug)).then(snap => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.approvedRoutes?.length > 0) {
          setWellRouteInfo({
            count: data.approvedRoutes.length,
            labels: data.approvedRoutes.map((r: any) => r.label || 'Unlabeled'),
          });
        } else if (data.active && data.waypoints) {
          setWellRouteInfo({ count: 1, labels: ['Legacy Route'] });
        } else {
          setWellRouteInfo(null);
        }
      } else {
        setWellRouteInfo(null);
      }
    }).catch(() => setWellRouteInfo(null));
  }, [selectedWell, configs]);

  // Load NDIC operators on mount (once), then pre-load all operator wells for auto-linking
  useEffect(() => {
    loadOperators().then(ops => {
      setNdicOperators(ops);
      // Pre-load wells from all operators for auto-link (cached after first load)
      Promise.all(ops.map(op => loadWellsForOperator(op.name).catch(() => [] as NdicWell[])))
        .then(results => {
          const all = results.flat();
          setAutoLinkWells(all);
          console.log(`[admin] Pre-loaded ${all.length} operator wells for auto-link`);
        });
    }).catch(err => {
      console.error('[admin] Failed to load NDIC operators:', err);
    });
  }, []);

  // Auto-link: when search term changes and we have operator wells, search for a match.
  // The search input is decoupled from the well name so the user can search by legal
  // name (e.g. "Sparrow 1-10H") without that becoming the saved/displayed well name.
  // State filter scopes the search so generic names (e.g. "Sparrow") don't get
  // trapped on the wrong state's match.
  useEffect(() => {
    const term = newWellSearchTerm.trim();
    if (term.length < 2 || autoLinkWells.length === 0) {
      if (!ndicSelectedWell) setAutoLinkStatus('idle');
      return;
    }
    if (ndicSelectedWell) return;

    const timer = setTimeout(() => {
      setAutoLinkStatus('loading');
      const pool = newWellSearchState === 'all'
        ? autoLinkWells
        : autoLinkWells.filter(w => w.state === newWellSearchState);
      const matches = searchWellsByName(term, pool, 10);

      const acceptMatch = (m: NdicWell) => {
        setNdicSelectedWell(m);
        setAutoLinkStatus('matched');
        // Suggest a driver-friendly display name only if the user hasn't typed one yet.
        // Functional setState reads the latest value without needing it in deps.
        setNewWellName(prev => prev.trim() === '' ? extractDisplayName(m.well_name) : prev);
      };

      if (matches.length === 1) {
        acceptMatch(matches[0]);
      } else if (matches.length > 1) {
        const exactish = matches.find(m =>
          m.well_name.toLowerCase().startsWith(term.toLowerCase() + ' ') ||
          m.well_name.toLowerCase().startsWith(term.toLowerCase() + '-')
        );
        if (exactish) {
          acceptMatch(exactish);
        } else {
          setAutoLinkStatus('no_match');
        }
      } else {
        setAutoLinkStatus('no_match');
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [newWellSearchTerm, newWellSearchState, autoLinkWells, ndicSelectedWell]);

  // When NDIC operator search changes, filter results
  useEffect(() => {
    if (ndicOperatorSearch.length >= 1) {
      setNdicOperatorResults(searchOperators(ndicOperatorSearch, ndicOperators));
    } else {
      setNdicOperatorResults([]);
    }
  }, [ndicOperatorSearch, ndicOperators]);

  // When checked operators change, load all their wells
  useEffect(() => {
    if (ndicCheckedOperators.length === 0) {
      setNdicOperatorWells([]);
      setNdicWellResults([]);
      return;
    }
    setNdicLoadingWells(true);
    Promise.all(ndicCheckedOperators.map(async op => {
      const [active, inactive] = await Promise.all([
        loadWellsForOperator(op),
        loadInactiveWellsForOperator(op),
      ]);
      return [...active, ...inactive];
    }))
      .then(results => {
        const merged = results.flat();
        // Deduplicate by API number (active takes priority over inactive)
        const seen = new Map<string, typeof merged[0]>();
        for (const well of merged) {
          if (!seen.has(well.api_no)) {
            seen.set(well.api_no, well);
          }
        }
        const deduped = Array.from(seen.values());
        deduped.sort((a, b) => a.well_name.localeCompare(b.well_name));
        setNdicOperatorWells(deduped);
        setNdicLoadingWells(false);
      })
      .catch(err => {
        console.error('[admin] Failed to load wells for operators:', err);
        setNdicLoadingWells(false);
      });
  }, [ndicCheckedOperators]);

  // When NDIC well search changes, filter results
  useEffect(() => {
    if (ndicWellSearch.length >= 2 && ndicOperatorWells.length > 0) {
      setNdicWellResults(searchWellsByName(ndicWellSearch, ndicOperatorWells, 50));
    } else if (ndicWellSearch.length < 2) {
      // Show all wells for scrolling when search is empty
      setNdicWellResults(ndicOperatorWells);
    }
  }, [ndicWellSearch, ndicOperatorWells]);

  // Extract short display name from NDIC well name
  // "GABRIEL 1-36-25H" → "Gabriel 1"
  // Shared suggester — same logic the bulk importer uses (drops lease
  // designations like FEDERAL, keeps base name + first well number).
  const extractDisplayName = (ndicName: string): string => suggestDisplayName(ndicName);

  // Handle NDIC well selection — fills in the appropriate form
  const handleNdicWellSelect = (well: NdicWell) => {
    const displayName = extractDisplayName(well.well_name);

    if (ndicPickerTarget === 'add') {
      setNewWellName(displayName);
    } else {
      setEditWellName(displayName);
      setEditNdicName(well.well_name);
      setEditNdicApiNo(well.api_no);
    }

    setNdicSelectedWell(well);
    // Don't close picker yet — user can see the selection and confirm
  };

  // Open the NDIC picker for a specific form
  const openNdicPicker = (target: 'add' | 'edit') => {
    setNdicPickerTarget(target);
    setShowNdicPicker(true);
    setNdicOperatorSearch('');
    setNdicCheckedOperators([]);
    setNdicSelectedWell(null);
    setNdicWellResults([]);
    setNdicOperatorResults([]);
    // Pre-fill well search with the name being edited/added
    if (target === 'edit' && selectedWell) {
      setNdicWellSearch(selectedWell);
    } else if (target === 'add' && (newWellSearchTerm.trim() || newWellName.trim())) {
      // Prefer the search term (user typed a legal name to find the record).
      // Fall back to the well name only if no search term was entered.
      setNdicWellSearch(newWellSearchTerm.trim() || newWellName.trim());
    } else {
      setNdicWellSearch('');
    }
  };

  // Confirm NDIC selection and close picker
  const confirmNdicSelection = () => {
    if (!ndicSelectedWell) return;

    if (ndicPickerTarget === 'add') {
      // ndicName/ndicApiNo will be read from ndicSelectedWell in handleAddWell
    } else {
      setEditNdicName(ndicSelectedWell.well_name);
      setEditNdicApiNo(ndicSelectedWell.api_no);
    }

    setShowNdicPicker(false);
  };

  // Clear NDIC link
  const clearNdicLink = (target: 'add' | 'edit') => {
    if (target === 'add') {
      setNdicSelectedWell(null);
    } else {
      setEditNdicName('');
      setEditNdicApiNo('');
    }
  };

  // Load selected route name into edit field
  useEffect(() => {
    if (selectedRoute) {
      setEditRouteName(selectedRoute);
    }
  }, [selectedRoute]);

  const showMessage = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3000);
  };

  // Add new route
  const handleAddRoute = async () => {
    const routeName = newRouteName.trim();
    const nameError = validateName(routeName);
    if (nameError) {
      showMessage(nameError);
      return;
    }
    if (routes.includes(routeName)) {
      showMessage('Route already exists');
      return;
    }
    // Routes are created implicitly when wells are assigned
    // For now, just add to local state
    setRoutes([...routes, routeName].sort());
    setRouteWells({ ...routeWells, [routeName]: [] });
    setNewRouteName('');
    showMessage(`Route "${routeName}" created`);
  };

  // Delete route - show modal for choice
  const handleDeleteRoute = () => {
    if (!selectedRoute || selectedRoute === 'Unrouted') {
      showMessage('Select a route to delete');
      return;
    }
    setShowDeleteRouteModal(true);
  };

  // Execute the actual route deletion based on user choice
  const executeDeleteRouteWithAction = async (action: 'unassign' | 'delete') => {
    if (!selectedRoute) return;

    const db = getFirebaseDatabase();
    const wellsInRoute = routeWells[selectedRoute] || [];

    if (action === 'unassign') {
      // Move all wells to Unassigned
      const updates: Record<string, string> = {};
      for (const wellName of wellsInRoute) {
        updates[`well_config/${wellName}/route`] = 'Unrouted';
      }
      if (Object.keys(updates).length > 0) {
        await update(ref(db), updates);
      }
      showMessage(`Route "${selectedRoute}" deleted, ${wellsInRoute.length} wells moved to Unrouted`);
    } else if (action === 'delete') {
      // Permanently delete wells and their history
      for (const wellName of wellsInRoute) {
        // Delete well config
        await remove(ref(db, `well_config/${wellName}`));

        // Delete all processed packets for this well
        const processedRef = ref(db, 'packets/processed');
        const snapshot = await get(processedRef);
        if (snapshot.exists()) {
          const deleteUpdates: Record<string, null> = {};
          snapshot.forEach((child) => {
            const data = child.val();
            if (data.wellName?.toLowerCase().replace(/\s/g, '') === wellName.toLowerCase().replace(/\s/g, '')) {
              deleteUpdates[`packets/processed/${child.key}`] = null;
            }
          });
          if (Object.keys(deleteUpdates).length > 0) {
            await update(ref(db), deleteUpdates);
          }
        }

        // Delete outgoing status
        const outgoingRef = ref(db, 'packets/outgoing');
        const outSnapshot = await get(outgoingRef);
        if (outSnapshot.exists()) {
          const outDeleteUpdates: Record<string, null> = {};
          outSnapshot.forEach((child) => {
            const data = child.val();
            if (data.wellName?.toLowerCase().replace(/\s/g, '') === wellName.toLowerCase().replace(/\s/g, '')) {
              outDeleteUpdates[`packets/outgoing/${child.key}`] = null;
            }
          });
          if (Object.keys(outDeleteUpdates).length > 0) {
            await update(ref(db), outDeleteUpdates);
          }
        }

        // Delete performance data
        await remove(ref(db, `performance/${wellName}`));
      }
      showMessage(`Route "${selectedRoute}" and ${wellsInRoute.length} wells permanently deleted`);
    }

    setShowDeleteRouteModal(false);
    setDeleteRouteAction(null);
    setSelectedRoute('');
  };

  // Rename route
  const handleRenameRoute = async () => {
    if (!selectedRoute || selectedRoute === 'Unrouted') {
      showMessage('Select a route to rename');
      return;
    }

    const newName = editRouteName.trim();
    const nameError = validateName(newName);
    if (nameError) {
      showMessage(nameError);
      return;
    }

    if (newName === selectedRoute) {
      showMessage('Name unchanged');
      return;
    }

    if (routes.includes(newName)) {
      showMessage('A route with that name already exists');
      return;
    }

    setIsRenamingRoute(true);
    showMessage(`Renaming route to "${newName}"...`);

    try {
      const db = getFirebaseDatabase();
      const wellsInRoute = routeWells[selectedRoute] || [];

      // Update all wells to use the new route name
      const updates: Record<string, string> = {};
      for (const wellName of wellsInRoute) {
        updates[`well_config/${wellName}/route`] = newName;
      }

      if (Object.keys(updates).length > 0) {
        await update(ref(db), updates);
      }

      showMessage(`Route renamed from "${selectedRoute}" to "${newName}"`);
      setSelectedRoute(newName);
    } catch (error) {
      console.error('Error renaming route:', error);
      showMessage('Error renaming route. Check console for details.');
    } finally {
      setIsRenamingRoute(false);
    }
  };

  // Add new well
  const handleAddWell = async () => {
    const wellName = newWellName.trim();
    const nameError = validateName(wellName);
    if (nameError) {
      showMessage(nameError);
      return;
    }
    // Case-insensitive duplicate check
    const duplicate = Object.keys(configs).find(k => k.toLowerCase() === wellName.toLowerCase());
    if (duplicate) {
      showMessage(`Well already exists as "${duplicate}"`);
      return;
    }

    const db = getFirebaseDatabase();
    const overrideRaw = parseFloat(newWellBblPerFootOverride);
    const hasOverride = newWellBblPerFootOverride.trim() !== '' && !isNaN(overrideRaw) && overrideRaw > 0;

    // Shared builder — identical well_config shape as Bulk Import.
    const config = buildWellConfig({
      route: newWellRoute,
      bottomFeet: parseLevelToFeet(newWellBottom),
      tanks: parseInt(newWellTanks) || undefined,
      activeTanks: parseInt(newWellActiveTanks) || undefined,
      pullBbls: parseInt(newWellPullBbls) || undefined,
      tankCapacity: parseInt(newWellTankCapacity) || undefined,
      tankHeight: parseFloat(newWellTankHeight) || undefined,
      bblPerFootOverride: hasOverride ? overrideRaw : null,
      equalizedTanks: newWellEqualized,
      requireActualBottom: newWellRequireActualBottom,
      ndicName: ndicSelectedWell?.well_name,
      ndicApiNo: ndicSelectedWell?.api_no,
      waterWeight: newWellWaterWeight ? parseFloat(newWellWaterWeight) : undefined,
      h2sStatus: newWellH2s,
    });

    await set(ref(db, `well_config/${wellName}`), config);
    // Tenant membership (Model B) — does not touch the shared well_config doc.
    if (activeCompanyId) await addMaintainedWell(activeCompanyId, wellName);
    showMessage(`Well "${wellName}" created${ndicSelectedWell ? ` (linked: ${ndicSelectedWell.api_no})` : ''}`);
    setNewWellName('');
    setNewWellSearchTerm('');
    setNdicSelectedWell(null);
    setAutoLinkStatus('idle');
  };

  // Bulk import writes (P2). Receives only rows the modal approved for import.
  // Writes the SAME well_config shape as manual add (via buildWellConfig) with
  // the agreed safe defaults; route comes from the row (CSV value as-is, else
  // the modal's default). RTDB key sanitized exactly like manual add. The live
  // well_config subscription fills the list — no manual refetch.
  const FORBIDDEN_PATH_CHARS = /[.#$[\]/]/g;
  const handleBulkImportWells = async (
    rows: ImportRow[],
    onProgress?: (current: number, total: number) => void,
  ): Promise<{ imported: number; failed: number }> => {
    const db = getFirebaseDatabase();
    const existing = new Set(Object.keys(configs).map(k => k.toLowerCase()));
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      onProgress?.(i + 1, rows.length);
      const r = rows[i];
      // Write under the (possibly user-edited) driver display name — this key is
      // effectively permanent once packets/pull history accrue.
      const name = (r.displayName || r.name).replace(FORBIDDEN_PATH_CHARS, '').trim();
      // Last-second guard against empty names / collisions created mid-import.
      if (!name || existing.has(name.toLowerCase())) {
        failed++;
        continue;
      }
      const config = buildWellConfig({
        route: r.route,
        ndicName: r.match?.well_name,
        ndicApiNo: r.match?.api_no,
        waterWeight: 8.33,
        h2sStatus: 'unknown',
        // bottom 3 / tanks 1 / activeTanks 1 / pullBbls 140 / capacity 400 /
        // height 20 / bblPerFoot 20 all applied as builder defaults.
      });
      try {
        await set(ref(db, `well_config/${name}`), config);
        if (activeCompanyId) await addMaintainedWell(activeCompanyId, name);
        existing.add(name.toLowerCase());
        imported++;
      } catch {
        failed++;
      }
    }
    return { imported, failed };
  };

  // Update well config (with optional rename)
  const handleUpdateWell = async () => {
    if (!selectedWell) {
      showMessage('Select a well first');
      return;
    }

    const db = getFirebaseDatabase();
    const newName = editWellName.trim();
    const isNameChanged = newName !== selectedWell;

    // Validate new name
    const nameError = validateName(newName);
    if (nameError) {
      showMessage(nameError);
      return;
    }

    // Check if new name already exists (if renaming)
    if (isNameChanged && configs[newName]) {
      showMessage('A well with that name already exists');
      return;
    }

    const editTankCap = parseInt(editWellTankCapacity) || 400;
    const editTankHt = parseFloat(editWellTankHeight) || 20;
    const editNumTanks = parseInt(editWellTanks) || 1;
    // Manual bbl/ft override wins; else the tested builder derives from
    // capacity/height × active tanks (active defaults to physical when blank).
    const editOverrideRaw = parseFloat(editWellBblPerFootOverride);
    const editHasOverride = editWellBblPerFootOverride.trim() !== '' && !isNaN(editOverrideRaw) && editOverrideRaw > 0;

    const editParsedBottom = parseLevelToFeet(editWellBottom) || 3;
    // 7/26 default-truth: the payload comes from the ONE tested builder.
    // Pressing Save is explicit acceptance of the DISPLAYED inputs (the form
    // is seeded from the persisted aliases, so Gab 1's real 1.33 bottom is
    // what gets re-written, never a hidden default). The payload carries only
    // editor-owned fields — update() merge preserves loadLine, routeGroupWell,
    // routeColor, avgFlowRate*, routeRecording and every CF-written field.
    const config = buildEditorSavePayload({
      route: editWellRoute,
      bottomFeet: editParsedBottom,
      tanks: editNumTanks,
      activeTanks: parseInt(editWellActiveTanks) > 0 ? parseInt(editWellActiveTanks) : null,
      pullBbls: parseInt(editWellPullBbls) || 140,
      tankCapacity: editTankCap,
      tankHeight: editTankHt,
      bblPerFootOverride: editHasOverride ? editOverrideRaw : null,
      equalizedTanks: editWellEqualized,
      requireActualBottom: editWellRequireActualBottom,
      h2sStatus: editWellH2s,
      ndicName: editNdicName || undefined,
      ndicApiNo: editNdicApiNo || undefined,
      waterWeight: editWellWaterWeight ? parseFloat(editWellWaterWeight) : undefined,
    }) as unknown as WellConfig;

    if (isNameChanged) {
      // Rename the well - update all references
      setIsRenaming(true);
      showMessage(`Renaming well to "${newName}"... This may take a moment.`);

      try {
        // 1. Create new config entry
        await set(ref(db, `well_config/${newName}`), config);

        // 2. Update all processed packets with this well name
        const processedQuery = query(
          ref(db, 'packets/processed'),
          orderByChild('wellName'),
          equalTo(selectedWell)
        );
        const processedSnap = await get(processedQuery);
        const processedUpdates: Record<string, any> = {};
        processedSnap.forEach((child) => {
          processedUpdates[`packets/processed/${child.key}/wellName`] = newName;
        });
        if (Object.keys(processedUpdates).length > 0) {
          await update(ref(db), processedUpdates);
        }

        // 3. Update outgoing response
        const outgoingQuery = query(
          ref(db, 'packets/outgoing'),
          orderByChild('wellName'),
          equalTo(selectedWell)
        );
        const outgoingSnap = await get(outgoingQuery);
        const outgoingUpdates: Record<string, any> = {};
        outgoingSnap.forEach((child) => {
          outgoingUpdates[`packets/outgoing/${child.key}/wellName`] = newName;
        });
        if (Object.keys(outgoingUpdates).length > 0) {
          await update(ref(db), outgoingUpdates);
        }

        // 4. Update performance data - need to copy the entire node
        const perfSnap = await get(ref(db, `performance/${selectedWell}`));
        if (perfSnap.exists()) {
          await set(ref(db, `performance/${newName}`), perfSnap.val());
          await remove(ref(db, `performance/${selectedWell}`));
        }

        // 5. Delete old config entry
        await remove(ref(db, `well_config/${selectedWell}`));

        // 6. Move tenant membership (Model B) old name -> new name
        if (activeCompanyId) {
          await removeMaintainedWell(activeCompanyId, selectedWell);
          await addMaintainedWell(activeCompanyId, newName);
        }

        showMessage(`Well renamed from "${selectedWell}" to "${newName}"`);
        setSelectedWell(newName);
      } catch (error) {
        console.error('Error renaming well:', error);
        showMessage('Error renaming well. Check console for details.');
      } finally {
        setIsRenaming(false);
      }
    } else {
      // Merge update — preserves avgFlowRate, avgFlowRateMinutes, and other
      // fields written by Cloud Functions that aren't in the admin edit form
      const updateData: Record<string, any> = { ...config };
      await update(ref(db, `well_config/${selectedWell}`), updateData);
      showMessage(`Well "${selectedWell}" updated`);
    }
  };

  // Delete well - show modal for choice
  const handleDeleteWell = () => {
    if (!selectedWell) {
      showMessage('Select a well first');
      return;
    }
    setShowDeleteWellModal(true);
  };

  // Execute the actual well deletion based on user choice
  const executeDeleteWellWithAction = async (action: 'unassign' | 'delete') => {
    if (!selectedWell) return;

    const db = getFirebaseDatabase();

    if (action === 'unassign') {
      // Just move to Unassigned route, keep all data
      await set(ref(db, `well_config/${selectedWell}/route`), 'Unrouted');
      showMessage(`Well "${selectedWell}" moved to Unrouted`);
    } else if (action === 'delete') {
      // Permanently delete well and all its history
      const wellName = selectedWell;

      // Delete well config
      await remove(ref(db, `well_config/${wellName}`));

      // Drop tenant membership (Model B)
      if (activeCompanyId) await removeMaintainedWell(activeCompanyId, wellName);

      // Delete all processed packets for this well
      const processedRef = ref(db, 'packets/processed');
      const snapshot = await get(processedRef);
      if (snapshot.exists()) {
        const deleteUpdates: Record<string, null> = {};
        snapshot.forEach((child) => {
          const data = child.val();
          if (data.wellName?.toLowerCase().replace(/\s/g, '') === wellName.toLowerCase().replace(/\s/g, '')) {
            deleteUpdates[`packets/processed/${child.key}`] = null;
          }
        });
        if (Object.keys(deleteUpdates).length > 0) {
          await update(ref(db), deleteUpdates);
        }
      }

      // Delete outgoing status
      const outgoingRef = ref(db, 'packets/outgoing');
      const outSnapshot = await get(outgoingRef);
      if (outSnapshot.exists()) {
        const outDeleteUpdates: Record<string, null> = {};
        outSnapshot.forEach((child) => {
          const data = child.val();
          if (data.wellName?.toLowerCase().replace(/\s/g, '') === wellName.toLowerCase().replace(/\s/g, '')) {
            outDeleteUpdates[`packets/outgoing/${child.key}`] = null;
          }
        });
        if (Object.keys(outDeleteUpdates).length > 0) {
          await update(ref(db), outDeleteUpdates);
        }
      }

      // Delete performance data
      await remove(ref(db, `performance/${wellName}`));

      showMessage(`Well "${wellName}" and all history permanently deleted`);
    }

    setShowDeleteWellModal(false);
    setSelectedWell('');
  };

  if (loading) {
    return <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="text-white">Loading...</div>
    </div>;
  }

  if (!user || (user.role !== 'admin' && user.role !== 'it')) {
    return null;
  }

  return (
    <div className="h-screen bg-gray-900 flex flex-col overflow-hidden">
      <AppHeader />
      <SubHeader backHref="/" title="Admin Panel" />

      <main className="p-6 flex-1 flex flex-col min-h-0 overflow-auto">
        {message && (
          <div className="mb-4 p-3 bg-blue-900 text-blue-200 rounded">{message}</div>
        )}

        {/* Section Title */}
        <h2 className="text-xl font-bold text-white mb-3">
          {activeTab === 'wells' ? 'Well Configuration' :
           activeTab === 'routes' ? 'Route Groups' :
           activeTab === 'gpsroutes' ? 'GPS Route Recording' :
           activeTab === 'drivers' ? 'Employee Management' :
           activeTab === 'equipment' ? 'Equipment Documents' :
           'Customer Management'}
        </h2>

        {/* WB platform admin: company selector — scopes Maintained Wells /
            Route Groups / GPS Routes to the chosen company. Customer admins use
            their own companyId (no selector). */}
        {isPlatformAdmin && ['wells', 'routes', 'gpsroutes'].includes(activeTab) && allCompanies.length > 0 && (
          <div className="mb-4">
            <label className="text-gray-400 text-xs block mb-1">Select Company</label>
            <select
              value={selectedCompanyId || ''}
              onChange={e => setSelectedCompanyId(e.target.value)}
              className="px-3 py-2 bg-gray-700 text-white rounded text-sm w-72"
            >
              {allCompanies.map(c => (
                <option key={c.id} value={c.id}>{c.name || c.id}</option>
              ))}
            </select>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <button
            onClick={() => setActiveTab('wells')}
            className={`px-4 py-2 rounded ${activeTab === 'wells' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Maintained Wells
          </button>
          <button
            onClick={() => setActiveTab('routes')}
            className={`px-4 py-2 rounded ${activeTab === 'routes' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Route Groups
          </button>
          <button
            onClick={() => setActiveTab('gpsroutes')}
            className={`px-4 py-2 rounded ${activeTab === 'gpsroutes' ? 'bg-cyan-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            GPS Routes
          </button>
          <div className="w-px bg-gray-600 mx-1 self-stretch" />
          <button
            onClick={() => setActiveTab('drivers')}
            className={`px-4 py-2 rounded ${activeTab === 'drivers' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Employees
          </button>
          <button
            onClick={() => setActiveTab('companies')}
            className={`px-4 py-2 rounded ${activeTab === 'companies' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Customers
          </button>
          <button
            onClick={() => setActiveTab('equipment')}
            className={`px-4 py-2 rounded ${activeTab === 'equipment' ? 'bg-emerald-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Equipment
          </button>
        </div>

        {/* Routes Tab */}
        {activeTab === 'routes' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Route List */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Routes</h2>
                <input
                  type="text"
                  value={routeSearch}
                  onChange={(e) => setRouteSearch(e.target.value)}
                  placeholder="Search..."
                  className="w-1/3 px-3 py-1 bg-gray-700 text-white rounded text-sm"
                />
              </div>
              <div className="space-y-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
                {visibleRoutes
                  .filter(route => route.toLowerCase().includes(routeSearch.toLowerCase()))
                  .map(route => (
                  <div
                    key={route}
                    onClick={() => setSelectedRoute(route)}
                    className={`p-3 rounded cursor-pointer ${selectedRoute === route ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                  >
                    <div className="text-white font-medium">{route}</div>
                    <div className="text-gray-400 text-sm">{(visibleRouteWells[route] || []).length} wells</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Route Actions */}
            <div className="space-y-4">
              {/* Add Route */}
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Add New Route</h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newRouteName}
                    onChange={(e) => filterForbiddenChars(e.target.value, setNewRouteName)}
                    placeholder="Route name"
                    className="flex-1 px-3 py-2 bg-gray-700 text-white rounded"
                  />
                  <button
                    onClick={handleAddRoute}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Selected Route Info */}
              {selectedRoute && (
                <div className="bg-gray-800 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3">Edit Route</h3>

                  {/* Route Name (editable for non-Unassigned) */}
                  {selectedRoute !== 'Unrouted' ? (
                    <div className="mb-3">
                      <label className="text-gray-400 text-sm">Route Name</label>
                      <input
                        type="text"
                        value={editRouteName}
                        onChange={(e) => filterForbiddenChars(e.target.value, setEditRouteName)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                        disabled={isRenamingRoute}
                      />
                      {editRouteName !== selectedRoute && (
                        <p className="text-yellow-400 text-xs mt-1">
                          Will update {(routeWells[selectedRoute] || []).length} wells
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="mb-3">
                      <div className="text-gray-400 text-sm">Route Name</div>
                      <div className="text-white">Unrouted (cannot rename)</div>
                    </div>
                  )}

                  <div className="mb-3">
                    <div className="text-gray-400 text-sm mb-2">Wells in this route:</div>
                    <div className="text-white text-sm">
                      {(visibleRouteWells[selectedRoute] || []).join(', ') || 'No wells'}
                    </div>
                  </div>

                  {selectedRoute !== 'Unrouted' && (
                    <div className="flex gap-2">
                      <button
                        onClick={handleRenameRoute}
                        disabled={isRenamingRoute || editRouteName === selectedRoute}
                        className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                      >
                        {isRenamingRoute ? 'Renaming...' : 'Save'}
                      </button>
                      <button
                        onClick={handleDeleteRoute}
                        disabled={isRenamingRoute}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Wells Tab */}
        {activeTab === 'wells' && (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0">
            {/* Well List */}
            <div className="bg-gray-800 rounded-lg p-4 flex flex-col min-h-0 overflow-hidden">
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h2 className="text-lg font-semibold text-white">Maintained Wells</h2>
                <input
                  type="text"
                  value={wellSearch}
                  onChange={(e) => setWellSearch(e.target.value)}
                  placeholder="Search..."
                  className="w-1/3 px-3 py-1 bg-gray-700 text-white rounded text-sm"
                />
              </div>
              {Object.keys(visibleConfigs).length === 0 ? (
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center px-6">
                  <p className="text-gray-300 font-medium">No maintained wells configured.</p>
                  <p className="text-gray-500 text-sm mt-2 mb-4">
                    Import your well list to start monitoring, routing, and reporting.
                  </p>
                  <button
                    onClick={() => setShowBulkImport(true)}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm"
                  >
                    Bulk Import Wells
                  </button>
                </div>
              ) : (
              <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
                {Object.keys(visibleConfigs)
                  .filter(wellName => wellName.toLowerCase().includes(wellSearch.toLowerCase()))
                  .sort()
                  .map(wellName => (
                  <div
                    key={wellName}
                    onClick={() => setSelectedWell(wellName)}
                    className={`p-3 rounded cursor-pointer ${selectedWell === wellName ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                  >
                    <div className="text-white font-medium">
                      {wellName}
                      {configs[wellName].routeRecording && (
                        <span className="ml-2 text-xs text-orange-400 font-bold">REC</span>
                      )}
                    </div>
                    <div className="text-gray-400 text-sm">Route: {configs[wellName].route || 'Unrouted'}</div>
                    {/* 7/26 default-truth: fallback values must never look
                        persisted. Bottom honors the allowedBottom alias
                        (Gab 1's real 1.33 was hidden by `bottomLevel || 3`);
                        a rate derived from unsaved defaults is a marked
                        preview, never presented as a stored BBL/ft. */}
                    {(() => {
                      const n = normalizeWellEditorFields(configs[wellName] as unknown as Record<string, unknown>);
                      const eff = effectiveBblPerFoot(n);
                      const rateText = `${Number(eff.rate.toFixed(2))} BBL/ft`;
                      return (
                        <div className="flex gap-3 text-xs text-gray-500 mt-0.5 flex-wrap">
                          <span>Tanks: {n.tanks.value ?? WELL_EDITOR_DEFAULTS.tanks}</span>
                          <span>
                            Bottom: {feetToDisplay(n.bottomFeet.value ?? WELL_EDITOR_DEFAULTS.bottomFeet)}
                            {n.bottomFeet.present ? '' : ' (default)'}
                          </span>
                          <span>
                            Pull: {n.pullBbls.value ?? WELL_EDITOR_DEFAULTS.pullBbls} BBL
                            {n.pullBbls.present ? '' : ' (default)'}
                          </span>
                          <span className={eff.source === 'derived-defaults' ? 'text-amber-600' : ''}>
                            {eff.source === 'derived-defaults' ? `~${rateText.replace(' BBL/ft', '')} BBL/ft (preview)` : rateText}
                          </span>
                          {configs[wellName].avgFlowRate && (
                            <span>AFR: {configs[wellName].avgFlowRate}</span>
                          )}
                        </div>
                      );
                    })()}
                    {configs[wellName].ndicApiNo && (
                      <div className="text-teal-400 text-xs">API: {configs[wellName].ndicApiNo}</div>
                    )}
                  </div>
                ))}
              </div>
              )}
            </div>

            {/* Well Actions — scrollable right column */}
            <div className="space-y-4 overflow-y-auto min-h-0">
              {/* Add Well */}
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-white font-medium">Add Maintained Well</h3>
                  <button
                    onClick={() => setShowBulkImport(true)}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
                  >
                    Bulk Import Wells
                  </button>
                </div>
                <div className="space-y-3">
                  {/* State + Database search row — finds the legal NDIC/MBOGC record */}
                  <div className="flex gap-2">
                    <select
                      value={newWellSearchState}
                      onChange={(e) => setNewWellSearchState(e.target.value as 'all' | 'ND' | 'MT')}
                      className="px-2 py-2 bg-gray-700 text-white rounded text-sm"
                      title="Limit search to one state — typing a generic name like 'Sparrow' otherwise matches across states"
                    >
                      <option value="all">All states</option>
                      <option value="ND">North Dakota</option>
                      <option value="MT">Montana</option>
                    </select>
                    <input
                      type="text"
                      value={newWellSearchTerm}
                      onChange={(e) => setNewWellSearchTerm(e.target.value)}
                      placeholder="Search well database (e.g. Sparrow 1-10H)"
                      className="flex-1 px-3 py-2 bg-gray-700 text-white rounded"
                    />
                    <button
                      onClick={() => openNdicPicker('add')}
                      className="px-3 py-2 bg-teal-700 hover:bg-teal-600 text-white text-sm rounded whitespace-nowrap"
                      title="Open the operator + well picker to find a legal record manually"
                    >
                      Link Well
                    </button>
                  </div>
                  {/* Auto-link / linked status */}
                  {ndicSelectedWell ? (
                    <div className="bg-gray-900 rounded p-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-teal-400">{autoLinkStatus === 'matched' ? 'Auto-Linked' : 'Well Linked'}</span>
                        <button
                          onClick={() => { clearNdicLink('add'); setAutoLinkStatus('idle'); }}
                          className="text-red-400 hover:text-red-300 text-xs"
                        >
                          Unlink
                        </button>
                      </div>
                      <div className="text-gray-300 mt-1">{ndicSelectedWell.well_name}</div>
                      <div className="text-gray-500">API: {ndicSelectedWell.api_no} {ndicSelectedWell.state && `(${ndicSelectedWell.state})`}</div>
                    </div>
                  ) : autoLinkStatus === 'no_match' && newWellSearchTerm.trim().length >= 2 ? (
                    <div className="bg-red-900/30 border border-red-700/50 rounded p-2 text-xs text-red-300">
                      No auto-match found{newWellSearchState !== 'all' ? ` in ${newWellSearchState === 'ND' ? 'North Dakota' : 'Montana'}` : ''} — use <strong>Link Well</strong> to search manually
                    </div>
                  ) : autoLinkStatus === 'loading' ? (
                    <div className="text-gray-500 text-xs">Searching...</div>
                  ) : null}
                  {/* Driver-facing well name — what shows in the apps */}
                  <div>
                    <label className="text-gray-400 text-xs">Well Name (what drivers see in the app)</label>
                    <input
                      type="text"
                      value={newWellName}
                      onChange={(e) => filterForbiddenChars(e.target.value, setNewWellName)}
                      placeholder="e.g. Sparrow SOG"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded mt-1"
                    />
                    <p className="text-amber-400 text-xs mt-1">
                      ⚠️ Well name is permanent — get it right the first time. To change it later you'd have to delete and recreate the well.
                    </p>
                  </div>
                  <select
                    value={newWellRoute}
                    onChange={(e) => setNewWellRoute(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                  >
                    <option value="">Select Route</option>
                    {visibleRoutes.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-gray-400 text-sm">Bottom (ft)</label>
                      <input
                        type="text"
                        value={newWellBottom}
                        onChange={(e) => setNewWellBottom(e.target.value)}
                        placeholder="3, 1 4, 1'4&quot;"
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                      <div className="text-xs text-gray-500 mt-0.5">= {feetToDisplay(parseLevelToFeet(newWellBottom))}</div>
                    </div>
                    <div>
                      <label className="text-gray-400 text-sm">Tanks</label>
                      <input
                        type="number"
                        value={newWellTanks}
                        onChange={(e) => setNewWellTanks(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                    </div>
                    <div>
                      <label className="text-gray-400 text-sm">Pull BBLs</label>
                      <input
                        type="number"
                        value={newWellPullBbls}
                        onChange={(e) => setNewWellPullBbls(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                    </div>
                  </div>
                  {/* Tank dimensions */}
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <label className="text-gray-400 text-sm">Tank Capacity (BBL)</label>
                      <input
                        type="number"
                        value={newWellTankCapacity}
                        onChange={(e) => setNewWellTankCapacity(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                    </div>
                    <div>
                      <label className="text-gray-400 text-sm">Tank Height (ft)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={newWellTankHeight}
                        onChange={(e) => setNewWellTankHeight(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                    </div>
                  </div>
                  {/* Flow-math: active/flowing tanks + manual bbl/ft override */}
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <label className="text-gray-400 text-sm">Active / Flowing Tanks</label>
                      <input
                        type="number"
                        value={newWellActiveTanks}
                        onChange={(e) => setNewWellActiveTanks(e.target.value)}
                        placeholder={`default ${parseInt(newWellTanks) || 1}`}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                      <div className="text-xs text-gray-500 mt-0.5">Blank = all {parseInt(newWellTanks) || 1} physical tank{(parseInt(newWellTanks) || 1) > 1 ? 's' : ''}</div>
                    </div>
                    <div>
                      <label className="text-gray-400 text-sm">BBL/ft Override</label>
                      <input
                        type="number"
                        step="0.1"
                        value={newWellBblPerFootOverride}
                        onChange={(e) => setNewWellBblPerFootOverride(e.target.value)}
                        placeholder="auto (derived)"
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                      <div className="text-xs text-gray-500 mt-0.5">Manual — replaces derived</div>
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {(() => {
                      const cap = parseInt(newWellTankCapacity) || 400;
                      const ht = parseFloat(newWellTankHeight) || 20;
                      const physical = parseInt(newWellTanks) || 1;
                      const active = parseInt(newWellActiveTanks) || physical;
                      const ovr = parseFloat(newWellBblPerFootOverride);
                      const hasOvr = newWellBblPerFootOverride.trim() !== '' && !isNaN(ovr) && ovr > 0;
                      const eff = hasOvr ? ovr : (cap / ht) * active;
                      return `Effective BBL/ft: ${eff.toFixed(1)} per foot ${hasOvr ? '(manual override)' : `(${active} active tank${active > 1 ? 's' : ''})`}`;
                    })()}
                  </div>
                  {/* Tank calculator — measure diameter when no nameplate */}
                  <button
                    type="button"
                    onClick={() => { setCalcDiameter(''); setCalcUsableHeight(newWellTankHeight || ''); setTankCalcTarget('add'); }}
                    className="text-xs text-amber-500 hover:text-amber-400 mt-1"
                  >
                    ▸ No nameplate? Calculate from diameter
                  </button>
                  {/* Water properties */}
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="text-gray-400 text-sm">Water Weight (lbs/gal)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={newWellWaterWeight}
                        onChange={(e) => setNewWellWaterWeight(e.target.value)}
                        placeholder="e.g. 8.34"
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                    </div>
                    <div>
                      <label className="text-gray-400 text-sm">H₂S Status</label>
                      <select
                        value={newWellH2s}
                        onChange={(e) => setNewWellH2s(e.target.value as any)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      >
                        <option value="unknown">Unknown</option>
                        <option value="none">None</option>
                        <option value="low">Low</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    Fresh water ≈ 8.34 lbs/gal · Produced water ≈ 8.5–10+ lbs/gal
                  </div>
                  {/* Flow-math behavior flags */}
                  <div className="flex flex-col gap-2 mt-3">
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                      <input
                        type="checkbox"
                        checked={newWellEqualized}
                        onChange={(e) => setNewWellEqualized(e.target.checked)}
                      />
                      Equalized tank system (tanks rise together)
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                      <input
                        type="checkbox"
                        checked={newWellRequireActualBottom}
                        onChange={(e) => setNewWellRequireActualBottom(e.target.checked)}
                      />
                      Require driver to enter actual bottom
                    </label>
                  </div>
                  {(() => {
                    const isDuplicate = newWellName.trim().length > 0 && Object.keys(configs).some(k => k.toLowerCase() === newWellName.trim().toLowerCase());
                    const canAdd = ndicSelectedWell && !isDuplicate;
                    return (
                      <button
                        onClick={handleAddWell}
                        disabled={!canAdd}
                        className={`w-full px-4 py-2 text-white rounded mt-2 ${isDuplicate ? 'bg-red-800 cursor-not-allowed' : canAdd ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-600 cursor-not-allowed'}`}
                      >
                        {isDuplicate ? 'Well Already Exists' : ndicSelectedWell ? 'Add Well' : 'Link Well First'}
                      </button>
                    );
                  })()}
                </div>
              </div>

              {/* Edit Well */}
              {selectedWell && (
                <div className="bg-gray-800 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3">Edit Well</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-gray-400 text-sm">Well Name</label>
                      <input
                        type="text"
                        value={editWellName}
                        readOnly
                        className="w-full px-3 py-2 bg-gray-900 text-gray-400 rounded cursor-not-allowed"
                        title="Well name is permanent. To use a different name, delete and recreate the well."
                      />
                      <p className="text-gray-500 text-xs mt-1">
                        Well name is permanent. To use a different name, delete and recreate the well.
                      </p>
                    </div>
                    {/* NDIC Linkage */}
                    <div className="bg-gray-900 rounded p-2">
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-gray-400 text-sm">Well Database Link</label>
                        <button
                          onClick={() => openNdicPicker('edit')}
                          className="px-2 py-1 bg-teal-700 hover:bg-teal-600 text-white text-xs rounded"
                          disabled={isRenaming}
                        >
                          {editNdicName ? 'Change' : 'Link Well'}
                        </button>
                      </div>
                      {editNdicName ? (
                        <div>
                          <div className="text-teal-400 text-xs">{editNdicName}</div>
                          <div className="text-gray-500 text-xs">API: {editNdicApiNo}</div>
                          <button
                            onClick={() => clearNdicLink('edit')}
                            className="text-red-400 hover:text-red-300 text-xs mt-1"
                          >
                            Unlink
                          </button>
                        </div>
                      ) : (
                        <div className="text-gray-600 text-xs">Not linked to well database</div>
                      )}
                    </div>
                    {/* GPS Routes info (read-only) */}
                    {(wellRouteInfo || wellPadGroup) && (
                      <div className="bg-gray-900 rounded p-2 space-y-1.5">
                        {wellRouteInfo && (
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs bg-green-800 text-green-300 px-2 py-0.5 rounded-full">
                                {wellRouteInfo.count} GPS Route{wellRouteInfo.count !== 1 ? 's' : ''}
                              </span>
                            </div>
                            <div className="text-gray-500 text-xs mt-1">
                              {wellRouteInfo.labels.join(', ')}
                            </div>
                          </div>
                        )}
                        {wellPadGroup && wellPadGroup.length > 1 && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs bg-orange-900/50 text-orange-300 border border-orange-800 px-1.5 py-0.5 rounded">
                              Pad: {wellPadGroup.length} wells
                            </span>
                            <span className="text-gray-500 text-xs">{wellPadGroup.join(', ')}</span>
                          </div>
                        )}
                        {!wellRouteInfo && wellPadGroup && (
                          <div className="text-gray-600 text-xs">No approved routes yet</div>
                        )}
                      </div>
                    )}
                    <div>
                      <label className="text-gray-400 text-sm">Route</label>
                      <select
                        value={editWellRoute}
                        onChange={(e) => setEditWellRoute(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                        disabled={isRenaming}
                      >
                        {visibleRoutes.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-gray-400 text-sm">Bottom (ft)</label>
                        <input
                          type="text"
                          value={editWellBottom}
                          onChange={(e) => setEditWellBottom(e.target.value)}
                          placeholder="3, 1 4, 1'4&quot;"
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                        <div className="text-xs text-gray-500 mt-0.5">= {feetToDisplay(parseLevelToFeet(editWellBottom))}</div>
                        {!editFieldPresence.bottom && (
                          <div className="text-xs text-amber-500 mt-0.5">Default — not saved</div>
                        )}
                      </div>
                      <div>
                        <label className="text-gray-400 text-sm">Tanks</label>
                        <input
                          type="number"
                          value={editWellTanks}
                          onChange={(e) => setEditWellTanks(e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                      </div>
                      <div>
                        <label className="text-gray-400 text-sm">Pull BBLs</label>
                        <input
                          type="number"
                          value={editWellPullBbls}
                          onChange={(e) => setEditWellPullBbls(e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                        {!editFieldPresence.pullBbls && (
                          <div className="text-xs text-amber-500 mt-0.5">Default — not saved</div>
                        )}
                      </div>
                    </div>
                    {/* Tank dimensions */}
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <div>
                        <label className="text-gray-400 text-sm">Tank Capacity (BBL)</label>
                        <input
                          type="number"
                          value={editWellTankCapacity}
                          onChange={(e) => setEditWellTankCapacity(e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                        {!editFieldPresence.tankCapacity && (
                          <div className="text-xs text-amber-500 mt-0.5">Default — not saved</div>
                        )}
                      </div>
                      <div>
                        <label className="text-gray-400 text-sm">Tank Height (ft)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={editWellTankHeight}
                          onChange={(e) => setEditWellTankHeight(e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                        {!editFieldPresence.tankHeight && (
                          <div className="text-xs text-amber-500 mt-0.5">Default — not saved</div>
                        )}
                      </div>
                    </div>
                    {/* Flow-math: active/flowing tanks + manual bbl/ft override */}
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <div>
                        <label className="text-gray-400 text-sm">Active / Flowing Tanks</label>
                        <input
                          type="number"
                          value={editWellActiveTanks}
                          onChange={(e) => setEditWellActiveTanks(e.target.value)}
                          placeholder={`default ${parseInt(editWellTanks) || 1}`}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                        <div className="text-xs text-gray-500 mt-0.5">Blank = all {parseInt(editWellTanks) || 1} physical tank{(parseInt(editWellTanks) || 1) > 1 ? 's' : ''}</div>
                      </div>
                      <div>
                        <label className="text-gray-400 text-sm">BBL/ft Override</label>
                        <input
                          type="number"
                          step="0.1"
                          value={editWellBblPerFootOverride}
                          onChange={(e) => setEditWellBblPerFootOverride(e.target.value)}
                          placeholder="auto (derived)"
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                        <div className="text-xs text-gray-500 mt-0.5">Manual — replaces derived</div>
                      </div>
                    </div>
                    <div className="text-xs mt-1">
                      {(() => {
                        // 7/26 default-truth: the rate line must say WHERE the
                        // number comes from — persisted truth, saved-tank
                        // derivation, manual override, or a preview built from
                        // unsaved defaults. A preview must never read as stored.
                        const cap = parseInt(editWellTankCapacity) || 400;
                        const ht = parseFloat(editWellTankHeight) || 20;
                        const physical = parseInt(editWellTanks) || 1;
                        const active = parseInt(editWellActiveTanks) || physical;
                        const ovr = parseFloat(editWellBblPerFootOverride);
                        const hasOvr = editWellBblPerFootOverride.trim() !== '' && !isNaN(ovr) && ovr > 0;
                        const eff = hasOvr ? ovr : (cap / ht) * active;
                        const tanksLabel = `(${active} active tank${active > 1 ? 's' : ''})`;
                        if (hasOvr) {
                          return <span className="text-amber-400">{`Manual override: ${eff.toFixed(1)} BBL/ft`}</span>;
                        }
                        const enginePersisted = editFieldPresence.tankCapacity && editFieldPresence.tankHeight;
                        if (editFieldPresence.bblPerFoot && enginePersisted) {
                          return <span className="text-green-500">{`Saved: ${eff.toFixed(1)} BBL/ft ${tanksLabel}`}</span>;
                        }
                        if (enginePersisted) {
                          return <span className="text-gray-400">{`Preview from saved tanks: ${eff.toFixed(1)} BBL/ft ${tanksLabel} — press Save Changes to store the rate`}</span>;
                        }
                        return <span className="text-amber-500">{`Preview — derived from unsaved defaults: ${eff.toFixed(1)} BBL/ft ${tanksLabel}. Default — not saved until you press Save Changes.`}</span>;
                      })()}
                    </div>
                    <button
                      type="button"
                      onClick={() => { setCalcDiameter(''); setCalcUsableHeight(editWellTankHeight || ''); setTankCalcTarget('edit'); }}
                      className="text-xs text-amber-500 hover:text-amber-400 mt-1"
                      disabled={isRenaming}
                    >
                      ▸ No nameplate? Calculate from diameter
                    </button>
                    {/* Water properties */}
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div>
                        <label className="text-gray-400 text-sm">Water Weight (lbs/gal)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={editWellWaterWeight}
                          onChange={(e) => setEditWellWaterWeight(e.target.value)}
                          placeholder="e.g. 8.34"
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                      </div>
                      <div>
                        <label className="text-gray-400 text-sm">H₂S Status</label>
                        <select
                          value={editWellH2s}
                          onChange={(e) => setEditWellH2s(e.target.value as any)}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        >
                          <option value="unknown">Unknown</option>
                          <option value="none">None</option>
                          <option value="low">Low</option>
                          <option value="high">High</option>
                        </select>
                      </div>
                    </div>
                    <div className="text-xs text-gray-600 mt-1">
                      Fresh water ≈ 8.34 lbs/gal · Produced water ≈ 8.5–10+ lbs/gal
                    </div>
                    {/* Flow-math behavior flags */}
                    <div className="flex flex-col gap-2 mt-3">
                      <label className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={editWellEqualized}
                          onChange={(e) => setEditWellEqualized(e.target.checked)}
                          disabled={isRenaming}
                        />
                        Equalized tank system (tanks rise together)
                      </label>
                      <label className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={editWellRequireActualBottom}
                          onChange={(e) => setEditWellRequireActualBottom(e.target.checked)}
                          disabled={isRenaming}
                        />
                        Require driver to enter actual bottom
                      </label>
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={handleUpdateWell}
                        disabled={isRenaming}
                        className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                      >
                        {isRenaming ? 'Renaming...' : 'Save Changes'}
                      </button>
                      <button
                        onClick={handleDeleteWell}
                        disabled={isRenaming}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tank Capacity Calculator Modal — shared by Add + Edit Well */}
        {tankCalcTarget && (() => {
          const d = parseFloat(calcDiameter);
          const h = parseFloat(calcUsableHeight);
          const valid = d > 0 && h > 0;
          const capacityBbl = valid ? (Math.PI * (d / 2) * (d / 2) * h) / 5.6146 : 0;
          const capacityRounded = Math.round(capacityBbl);
          const bblPerFt = valid ? capacityBbl / h : 0; // height cancels → true per-foot rate, unaffected by capacity rounding
          const bblPerIn = bblPerFt / 12;
          const currentOverride = tankCalcTarget === 'add' ? newWellBblPerFootOverride : editWellBblPerFootOverride;
          const hasOverride = currentOverride.trim() !== '' && !isNaN(parseFloat(currentOverride)) && parseFloat(currentOverride) > 0;
          const applyToWell = () => {
            if (!valid) return;
            if (tankCalcTarget === 'add') {
              setNewWellTankCapacity(String(capacityRounded));
              setNewWellTankHeight(calcUsableHeight);
              setNewWellBblPerFootOverride(''); // calculated rate drives derived bblPerFoot
            } else {
              setEditWellTankCapacity(String(capacityRounded));
              setEditWellTankHeight(calcUsableHeight);
              setEditWellBblPerFootOverride('');
            }
            setTankCalcTarget(null);
          };
          return (
            <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50" onClick={() => setTankCalcTarget(null)}>
              <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-xl font-semibold text-white mb-1">Tank Capacity Calculator</h3>
                <p className="text-xs text-gray-400 mb-4">Calculated capacity assumes a perfect cylinder filled to this usable height.</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-gray-400 text-sm">Diameter (ft)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={calcDiameter}
                      onChange={(e) => setCalcDiameter(e.target.value)}
                      placeholder="e.g. 13.5"
                      autoFocus
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                    />
                  </div>
                  <div>
                    <label className="text-gray-400 text-sm">Usable liquid height (ft)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={calcUsableHeight}
                      onChange={(e) => setCalcUsableHeight(e.target.value)}
                      placeholder="e.g. 22.4"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                    />
                  </div>
                </div>
                <div className="bg-gray-900 rounded p-3 mt-4 space-y-1">
                  <div className="flex justify-between text-sm"><span className="text-gray-400">Calculated Capacity</span><span className="text-amber-400 font-bold">{valid ? `${capacityRounded} BBL` : '—'}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">Calculated BBL/ft</span><span className="text-amber-400 font-bold">{valid ? bblPerFt.toFixed(2) : '—'}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">Calculated BBL/in</span><span className="text-amber-400 font-bold">{valid ? bblPerIn.toFixed(2) : '—'}</span></div>
                </div>
                {hasOverride && (
                  <p className="text-xs text-amber-500 mt-3">Apply will clear the manual BBL/ft override so the calculated rate takes effect.</p>
                )}
                <div className="flex gap-2 mt-5">
                  <button onClick={() => setTankCalcTarget(null)} className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded">Cancel</button>
                  <button onClick={applyToWell} disabled={!valid} className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">Apply to Well</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Delete Route Modal */}
        {showDeleteRouteModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
              <h3 className="text-xl font-semibold text-white mb-4">Delete Route: {selectedRoute}</h3>
              <p className="text-gray-300 mb-2">
                This route has {(routeWells[selectedRoute] || []).length} wells. What would you like to do with them?
              </p>
              <div className="text-gray-400 text-sm mb-4">
                Wells: {(routeWells[selectedRoute] || []).join(', ') || 'None'}
              </div>

              <div className="space-y-3">
                <button
                  onClick={() => executeDeleteRouteWithAction('unassign')}
                  className="w-full px-4 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-left"
                >
                  <div className="font-medium">Move to Unrouted</div>
                  <div className="text-sm text-yellow-200">Keep wells and history, just remove from this route</div>
                </button>

                <button
                  onClick={() => executeDeleteRouteWithAction('delete')}
                  className="w-full px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded text-left"
                >
                  <div className="font-medium">Permanently Delete Everything</div>
                  <div className="text-sm text-red-200">Delete wells, all pull history, and performance data forever</div>
                </button>

                <button
                  onClick={() => {
                    setShowDeleteRouteModal(false);
                    setDeleteRouteAction(null);
                  }}
                  className="w-full px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Well Modal */}
        {showDeleteWellModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
              <h3 className="text-xl font-semibold text-white mb-4">Delete Well: {selectedWell}</h3>
              <p className="text-gray-300 mb-4">
                What would you like to do with this well?
              </p>

              <div className="space-y-3">
                <button
                  onClick={() => executeDeleteWellWithAction('unassign')}
                  className="w-full px-4 py-3 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-left"
                >
                  <div className="font-medium">Move to Unrouted</div>
                  <div className="text-sm text-yellow-200">Keep well and all history, just remove from current route</div>
                </button>

                <button
                  onClick={() => executeDeleteWellWithAction('delete')}
                  className="w-full px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded text-left"
                >
                  <div className="font-medium">Permanently Delete Everything</div>
                  <div className="text-sm text-red-200">Delete well config, all pull history, and performance data forever</div>
                </button>

                <button
                  onClick={() => setShowDeleteWellModal(false)}
                  className="w-full px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* NDIC Well Picker Modal */}
        {showNdicPicker && (
          <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-semibold text-white">Link Well</h3>
                <button
                  onClick={() => setShowNdicPicker(false)}
                  className="text-gray-400 hover:text-white text-2xl leading-none"
                >
                  &times;
                </button>
              </div>
              <div className="bg-gray-700 rounded px-3 py-2 mb-3 text-sm">
                <span className="text-gray-400">Linking: </span>
                <span className="text-white font-medium">
                  {ndicPickerTarget === 'edit' ? (selectedWell || 'Unknown') : (newWellName.trim() || 'New Well')}
                </span>
              </div>

              {/* Step 1: Search operator */}
              <div className="mb-3">
                <label className="text-gray-400 text-sm">Operator (Company)</label>
                <input
                  type="text"
                  value={ndicOperatorSearch}
                  onChange={(e) => {
                    setNdicOperatorSearch(e.target.value);
                    setNdicSelectedWell(null);
                  }}
                  placeholder="Search operators (e.g., Slawson, Continental)"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded mt-1"
                  autoFocus
                />
                {ndicOperatorResults.length > 0 && (
                  <div className="bg-gray-900 rounded mt-1 max-h-48 overflow-y-auto">
                    {ndicOperatorResults.map(op => (
                      <div
                        key={op.name}
                        onClick={() => {
                          setNdicCheckedOperators(prev =>
                            prev.includes(op.name)
                              ? prev.filter(n => n !== op.name)
                              : [...prev, op.name]
                          );
                        }}
                        className={`px-3 py-2 hover:bg-gray-700 cursor-pointer text-white text-sm flex items-center gap-2 ${ndicCheckedOperators.includes(op.name) ? 'bg-gray-700' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={ndicCheckedOperators.includes(op.name)}
                          readOnly
                          className="accent-teal-500 pointer-events-none"
                        />
                        <span className="flex-1">
                          {op.name}
                          {op.state && (
                            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${op.state === 'MT' ? 'bg-yellow-900 text-yellow-300' : 'bg-blue-900 text-blue-300'}`}>{op.state}</span>
                          )}
                          {op.well_count && (
                            <span className="text-gray-500 ml-2">({op.well_count} wells)</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Checked operator pills */}
                {ndicCheckedOperators.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {ndicCheckedOperators.map(name => {
                      const matchingOps = ndicOperators.filter(o => o.name === name);
                      return (
                        <span
                          key={name}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-teal-900 text-teal-300 text-xs rounded"
                        >
                          {name}
                          {matchingOps.map(op => op.state && (
                            <span key={op.state} className={`text-xs px-1 rounded ${op.state === 'MT' ? 'bg-yellow-900 text-yellow-300' : 'bg-blue-900 text-blue-300'}`}>{op.state}</span>
                          ))}
                          <button
                            onClick={() => setNdicCheckedOperators(prev => prev.filter(n => n !== name))}
                            className="text-teal-500 hover:text-white ml-1"
                          >&times;</button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Step 2: Search well (after operator selected) */}
              {ndicCheckedOperators.length > 0 && (
                <div className="mb-3">
                  <label className="text-gray-400 text-sm">Well Name</label>
                  <input
                    type="text"
                    value={ndicWellSearch}
                    onChange={(e) => {
                      setNdicWellSearch(e.target.value);
                      setNdicSelectedWell(null);
                    }}
                    placeholder={ndicLoadingWells ? 'Loading wells...' : 'Search wells...'}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded mt-1"
                    disabled={ndicLoadingWells}
                  />
                </div>
              )}

              {/* Well results list */}
              {ndicCheckedOperators.length > 0 && ndicWellResults.length > 0 && (
                <div className="flex-1 overflow-y-auto bg-gray-900 rounded mb-3" style={{ maxHeight: '400px' }}>
                  {ndicWellResults.map(well => (
                    <div
                      key={well.api_no}
                      onClick={() => handleNdicWellSelect(well)}
                      className={`px-3 py-2 cursor-pointer border-b border-gray-800 ${
                        ndicSelectedWell?.api_no === well.api_no
                          ? 'bg-teal-900 border-teal-600'
                          : 'hover:bg-gray-700'
                      }`}
                    >
                      <div className="text-white text-sm">
                        {well.well_name}
                        {well.state && (
                          <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${well.state === 'MT' ? 'bg-yellow-900 text-yellow-300' : 'bg-blue-900 text-blue-300'}`}>{well.state}</span>
                        )}
                      </div>
                      <div className="text-gray-500 text-xs">
                        API: {well.api_no}
                        {well.county && ` | ${well.county} Co.`}
                        {well.field_name && ` | ${well.field_name}`}
                      </div>
                      {ndicSelectedWell?.api_no === well.api_no && (
                        <div className="text-teal-400 text-xs mt-1">
                          Display name: <strong>{extractDisplayName(well.well_name)}</strong>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {ndicCheckedOperators.length > 0 && !ndicLoadingWells && ndicOperatorWells.length > 0 && (
                <div className="text-gray-500 text-xs text-right mb-1">
                  {ndicWellSearch.length >= 2
                    ? `${ndicWellResults.length} of ${ndicOperatorWells.length} wells`
                    : `${ndicOperatorWells.length} wells`}
                </div>
              )}

              {ndicCheckedOperators.length > 0 && ndicWellResults.length === 0 && !ndicLoadingWells && (
                <div className="text-gray-500 text-sm text-center py-4">
                  {ndicWellSearch.length >= 2 ? 'No wells match your search' : 'Type to search wells or scroll the list'}
                </div>
              )}

              {ndicLoadingWells && (
                <div className="text-teal-400 text-sm text-center py-4">Loading wells...</div>
              )}

              {/* Selected well summary + confirm */}
              {ndicSelectedWell && (
                <div className="bg-teal-900 rounded p-3 mb-3">
                  <div className="text-teal-300 text-sm font-medium">Selected:</div>
                  <div className="text-white">{ndicSelectedWell.well_name}</div>
                  <div className="text-gray-300 text-sm">API: {ndicSelectedWell.api_no}</div>
                  <div className="text-gray-300 text-sm">
                    Display name: <strong>{extractDisplayName(ndicSelectedWell.well_name)}</strong>
                  </div>
                  {ndicSelectedWell.latitude && ndicSelectedWell.longitude && (
                    <div className="text-gray-400 text-xs mt-1">
                      GPS: {ndicSelectedWell.latitude}, {ndicSelectedWell.longitude}
                    </div>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={confirmNdicSelection}
                  disabled={!ndicSelectedWell}
                  className="flex-1 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Confirm Link
                </button>
                <button
                  onClick={() => setShowNdicPicker(false)}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* GPS Routes Tab */}
        {activeTab === 'gpsroutes' && (
          <GpsRoutesTab maintainedWellNames={maintainedNames ?? new Set<string>()} />
        )}

        {/* Drivers Tab */}
        {activeTab === 'drivers' && (
          <DriversTab
            scopeCompanyId={user?.companyId}
            isWbAdmin={!user?.companyId && (user?.role === 'it' || user?.role === 'admin')}
          />
        )}

        {/* Companies Tab */}
        {activeTab === 'companies' && (
          <CompaniesTab
            scopeCompanyId={user?.companyId}
            isWbAdmin={!user?.companyId && (user?.role === 'it' || user?.role === 'admin')}
          />
        )}

        {/* Equipment Tab */}
        {activeTab === 'equipment' && (
          <EquipmentTab
            scopeCompanyId={user?.companyId}
            isWbAdmin={!user?.companyId && (user?.role === 'it' || user?.role === 'admin')}
          />
        )}
      </main>

      {/* Bulk Maintained Well Import (P2: writes via buildWellConfig) */}
      <BulkWellImportModal
        isOpen={showBulkImport}
        onClose={() => setShowBulkImport(false)}
        routes={visibleRoutes}
        existingWellNames={Object.keys(configs)}
        onImport={handleBulkImportWells}
      />
    </div>
  );
}
