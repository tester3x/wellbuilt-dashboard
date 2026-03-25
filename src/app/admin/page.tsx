'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';
import { getFirebaseDatabase, getFirestoreDb } from '@/lib/firebase';
import { ref, get, set, remove, onValue, query, orderByChild, equalTo, update } from 'firebase/database';
import { doc, getDoc } from 'firebase/firestore';
import {
  loadOperators,
  loadWellsForOperator,
  searchWellsByName,
  searchOperators,
  loadInactiveWellsForOperator,
  type NdicWell,
  type NdicOperator,
} from '@/lib/firestoreWells';
import { DriversTab } from '@/components/admin/DriversTab';
import { CompaniesTab } from '@/components/admin/CompaniesTab';
import GpsRoutesTab from '@/components/admin/GpsRoutesTab';
import { EquipmentTab } from '@/components/admin/EquipmentTab';

interface WellConfig {
  route?: string;
  bottomLevel?: number;
  tanks?: number;
  pullBbls?: number;
  // Tank dimensions — derive bblPerFoot from these
  tankCapacity?: number;  // BBL per tank (default 400)
  tankHeight?: number;    // feet per tank (default 20)
  bblPerFoot?: number;    // calculated: (tankCapacity / tankHeight) * numTanks
  // App-compatible field names (duplicates for compatibility)
  allowedBottom?: number;
  numTanks?: number;
  // NDIC well linkage — used by WB Tickets for WB Mobile integration
  ndicName?: string;   // Full NDIC well name (e.g. "GABRIEL 1-36-25H")
  ndicApiNo?: string;  // NDIC API number (e.g. "33-053-06789-00-00")
  avgFlowRate?: string;
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
  const router = useRouter();
  const [configs, setConfigs] = useState<Record<string, WellConfig>>({});
  const [routes, setRoutes] = useState<string[]>([]);
  const [routeWells, setRouteWells] = useState<RouteWells>({});
  const [selectedRoute, setSelectedRoute] = useState<string>('');
  const [selectedWell, setSelectedWell] = useState<string>('');

  // New route/well forms
  const [newRouteName, setNewRouteName] = useState('');
  const [newWellName, setNewWellName] = useState('');
  const [newWellRoute, setNewWellRoute] = useState('');
  const [newWellBottom, setNewWellBottom] = useState('3');
  const [newWellTanks, setNewWellTanks] = useState('1');
  const [newWellPullBbls, setNewWellPullBbls] = useState('140');
  const [newWellTankCapacity, setNewWellTankCapacity] = useState('400');
  const [newWellTankHeight, setNewWellTankHeight] = useState('20');
  // Tank calculator (optional — for when there's no nameplate)
  const [showTankCalc, setShowTankCalc] = useState(false);
  const [calcDiameter, setCalcDiameter] = useState('');

  // Edit well form
  const [editWellRoute, setEditWellRoute] = useState('');
  const [editWellBottom, setEditWellBottom] = useState('');
  const [editWellTanks, setEditWellTanks] = useState('');
  const [editWellPullBbls, setEditWellPullBbls] = useState('');
  const [editWellTankCapacity, setEditWellTankCapacity] = useState('');
  const [editWellTankHeight, setEditWellTankHeight] = useState('');

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

  // NDIC picker for edit form — stored NDIC link
  const [editNdicName, setEditNdicName] = useState('');
  const [editNdicApiNo, setEditNdicApiNo] = useState('');

  const [message, setMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'routes' | 'wells' | 'drivers' | 'companies' | 'gpsroutes' | 'equipment'>('wells');

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
      setEditWellBottom(String(config.bottomLevel || 3));
      setEditWellTanks(String(config.tanks || config.numTanks || 1));
      setEditWellPullBbls(String(config.pullBbls || 140));
      setEditWellTankCapacity(String(config.tankCapacity || 400));
      setEditWellTankHeight(String(config.tankHeight || 20));
      // Load NDIC linkage if present
      setEditNdicName(config.ndicName || '');
      setEditNdicApiNo(config.ndicApiNo || '');
    }
  }, [selectedWell, configs]);

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

  // Load NDIC operators on mount (once)
  useEffect(() => {
    loadOperators().then(setNdicOperators).catch(err => {
      console.error('[admin] Failed to load NDIC operators:', err);
    });
  }, []);

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
  const extractDisplayName = (ndicName: string): string => {
    const cleaned = ndicName.replace(/#/g, '').trim();
    const match = cleaned.match(/^([A-Za-z\s]+?)\s*(\d+)\s*-/);
    if (!match) return ndicName; // Return as-is if no NDIC pattern
    const baseName = match[1].trim();
    const number = match[2];
    const titleCase = baseName.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    return `${titleCase} ${number}`;
  };

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
    } else if (target === 'add' && newWellName.trim()) {
      setNdicWellSearch(newWellName.trim());
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
    if (configs[wellName]) {
      showMessage('Well already exists');
      return;
    }

    const db = getFirebaseDatabase();
    const tankCap = parseInt(newWellTankCapacity) || 400;
    const tankHt = parseInt(newWellTankHeight) || 20;
    const numTanks = parseInt(newWellTanks) || 1;
    const bblPerFoot = (tankCap / tankHt) * numTanks;

    const config: WellConfig = {
      route: newWellRoute || 'Unrouted',
      bottomLevel: parseFloat(newWellBottom) || 3,
      tanks: numTanks,
      // Also write app-compatible field names
      allowedBottom: parseFloat(newWellBottom) || 3,
      numTanks,
      pullBbls: parseInt(newWellPullBbls) || 140,
      // Tank dimensions + derived bblPerFoot
      tankCapacity: tankCap,
      tankHeight: tankHt,
      bblPerFoot,
      // NDIC linkage (from NDIC picker, if used)
      ...(ndicSelectedWell ? {
        ndicName: ndicSelectedWell.well_name,
        ndicApiNo: ndicSelectedWell.api_no,
      } : {}),
    };

    await set(ref(db, `well_config/${wellName}`), config);
    showMessage(`Well "${wellName}" created${ndicSelectedWell ? ` (linked: ${ndicSelectedWell.api_no})` : ''}`);
    setNewWellName('');
    setNdicSelectedWell(null);
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
    const editTankHt = parseInt(editWellTankHeight) || 20;
    const editNumTanks = parseInt(editWellTanks) || 1;
    const editBblPerFoot = (editTankCap / editTankHt) * editNumTanks;

    const config: WellConfig = {
      route: editWellRoute || 'Unrouted',
      bottomLevel: parseFloat(editWellBottom) || 3,
      tanks: editNumTanks,
      // Also write app-compatible field names
      allowedBottom: parseFloat(editWellBottom) || 3,
      numTanks: editNumTanks,
      pullBbls: parseInt(editWellPullBbls) || 140,
      // Tank dimensions + derived bblPerFoot
      tankCapacity: editTankCap,
      tankHeight: editTankHt,
      bblPerFoot: editBblPerFoot,
      // NDIC linkage
      ...(editNdicName ? { ndicName: editNdicName } : {}),
      ...(editNdicApiNo ? { ndicApiNo: editNdicApiNo } : {}),
    };

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
    <div className="min-h-screen bg-gray-900">
      <AppHeader />
      <SubHeader backHref="/" title="Admin Panel" />

      <main className="p-6">
        {message && (
          <div className="mb-4 p-3 bg-blue-900 text-blue-200 rounded">{message}</div>
        )}

        {/* Section Title */}
        <h2 className="text-xl font-bold text-white mb-3">
          {activeTab === 'wells' ? 'Well Configuration' :
           activeTab === 'routes' ? 'Route Groups' :
           activeTab === 'gpsroutes' ? 'GPS Route Recording' :
           activeTab === 'drivers' ? 'Driver Management' :
           activeTab === 'equipment' ? 'Equipment Documents' :
           'Customer Management'}
        </h2>

        {/* Tabs */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <button
            onClick={() => setActiveTab('wells')}
            className={`px-4 py-2 rounded ${activeTab === 'wells' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            Wells
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
            Drivers
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
                {routes
                  .filter(route => route.toLowerCase().includes(routeSearch.toLowerCase()))
                  .map(route => (
                  <div
                    key={route}
                    onClick={() => setSelectedRoute(route)}
                    className={`p-3 rounded cursor-pointer ${selectedRoute === route ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
                  >
                    <div className="text-white font-medium">{route}</div>
                    <div className="text-gray-400 text-sm">{(routeWells[route] || []).length} wells</div>
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
                      {(routeWells[selectedRoute] || []).join(', ') || 'No wells'}
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
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Well List */}
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Wells</h2>
                <input
                  type="text"
                  value={wellSearch}
                  onChange={(e) => setWellSearch(e.target.value)}
                  placeholder="Search..."
                  className="w-1/3 px-3 py-1 bg-gray-700 text-white rounded text-sm"
                />
              </div>
              <div className="space-y-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
                {Object.keys(configs)
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
                    <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                      <span>Tanks: {configs[wellName].tanks || configs[wellName].numTanks || 1}</span>
                      <span>Bottom: {configs[wellName].bottomLevel || 3}&apos;</span>
                      <span>Pull: {configs[wellName].pullBbls || 140} BBL</span>
                      <span>{configs[wellName].bblPerFoot ? `${configs[wellName].bblPerFoot} BBL/ft` : `${(configs[wellName].tanks || configs[wellName].numTanks || 1) * 20} BBL/ft`}</span>
                      {configs[wellName].avgFlowRate && (
                        <span>AFR: {configs[wellName].avgFlowRate}</span>
                      )}
                    </div>
                    {configs[wellName].ndicApiNo && (
                      <div className="text-teal-400 text-xs">API: {configs[wellName].ndicApiNo}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Well Actions */}
            <div className="space-y-4">
              {/* Add Well */}
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Add New Well</h3>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newWellName}
                      onChange={(e) => filterForbiddenChars(e.target.value, setNewWellName)}
                      placeholder="Well name (e.g., Gabriel 1)"
                      className="flex-1 px-3 py-2 bg-gray-700 text-white rounded"
                    />
                    <button
                      onClick={() => openNdicPicker('add')}
                      className="px-3 py-2 bg-teal-700 hover:bg-teal-600 text-white text-sm rounded whitespace-nowrap"
                      title="Search well database to auto-fill name and link API number"
                    >
                      Link Well
                    </button>
                  </div>
                  {ndicSelectedWell && (
                    <div className="bg-gray-900 rounded p-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-teal-400">Well Linked</span>
                        <button
                          onClick={() => clearNdicLink('add')}
                          className="text-red-400 hover:text-red-300 text-xs"
                        >
                          Unlink
                        </button>
                      </div>
                      <div className="text-gray-300 mt-1">{ndicSelectedWell.well_name}</div>
                      <div className="text-gray-500">API: {ndicSelectedWell.api_no}</div>
                    </div>
                  )}
                  <select
                    value={newWellRoute}
                    onChange={(e) => setNewWellRoute(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                  >
                    <option value="">Select Route</option>
                    {routes.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-gray-400 text-sm">Bottom (ft)</label>
                      <input
                        type="number"
                        value={newWellBottom}
                        onChange={(e) => setNewWellBottom(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
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
                        value={newWellTankHeight}
                        onChange={(e) => setNewWellTankHeight(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                      />
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    BBL/ft: {(((parseInt(newWellTankCapacity) || 400) / (parseInt(newWellTankHeight) || 20)) * (parseInt(newWellTanks) || 1)).toFixed(1)} per foot ({parseInt(newWellTanks) || 1} tank{(parseInt(newWellTanks) || 1) > 1 ? 's' : ''})
                  </div>
                  {/* Tank calculator — measure diameter when no nameplate */}
                  <button
                    type="button"
                    onClick={() => setShowTankCalc(!showTankCalc)}
                    className="text-xs text-amber-500 hover:text-amber-400 mt-1"
                  >
                    {showTankCalc ? '▾ Hide calculator' : '▸ No nameplate? Calculate from diameter'}
                  </button>
                  {showTankCalc && (
                    <div className="bg-gray-800 rounded p-3 mt-1 border border-gray-700">
                      <div className="flex gap-3 items-end">
                        <div className="flex-1">
                          <label className="text-gray-400 text-xs">Diameter (ft, e.g. 13.5)</label>
                          <input
                            type="number"
                            step="0.1"
                            value={calcDiameter}
                            onChange={(e) => {
                              setCalcDiameter(e.target.value);
                              const d = parseFloat(e.target.value);
                              const h = parseInt(newWellTankHeight) || 20;
                              if (d > 0 && h > 0) {
                                const r = d / 2;
                                const cubicFt = Math.PI * r * r * h;
                                const bbl = Math.round(cubicFt / 5.6146);
                                setNewWellTankCapacity(String(bbl));
                              }
                            }}
                            placeholder="e.g. 13.5"
                            className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                          />
                        </div>
                        <div className="text-gray-400 text-xs pb-2">×</div>
                        <div className="flex-1">
                          <label className="text-gray-400 text-xs">Height (ft)</label>
                          <input
                            type="number"
                            value={newWellTankHeight}
                            onChange={(e) => {
                              setNewWellTankHeight(e.target.value);
                              const d = parseFloat(calcDiameter);
                              const h = parseInt(e.target.value) || 20;
                              if (d > 0 && h > 0) {
                                const r = d / 2;
                                const cubicFt = Math.PI * r * r * h;
                                const bbl = Math.round(cubicFt / 5.6146);
                                setNewWellTankCapacity(String(bbl));
                              }
                            }}
                            className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                          />
                        </div>
                        <div className="text-amber-400 text-sm font-bold pb-2">
                          = {calcDiameter && parseFloat(calcDiameter) > 0
                            ? `${Math.round(Math.PI * Math.pow(parseFloat(calcDiameter) / 2, 2) * (parseInt(newWellTankHeight) || 20) / 5.6146)} BBL`
                            : '—'}
                        </div>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={handleAddWell}
                    className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded mt-2"
                  >
                    Add Well
                  </button>
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
                        onChange={(e) => filterForbiddenChars(e.target.value, setEditWellName)}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                        disabled={isRenaming}
                      />
                      {editWellName !== selectedWell && (
                        <p className="text-yellow-400 text-xs mt-1">
                          ⚠️ Renaming will update all historical data
                        </p>
                      )}
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
                        {routes.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-gray-400 text-sm">Bottom (ft)</label>
                        <input
                          type="number"
                          value={editWellBottom}
                          onChange={(e) => setEditWellBottom(e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
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
                      </div>
                      <div>
                        <label className="text-gray-400 text-sm">Tank Height (ft)</label>
                        <input
                          type="number"
                          value={editWellTankHeight}
                          onChange={(e) => setEditWellTankHeight(e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                          disabled={isRenaming}
                        />
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      BBL/ft: {(((parseInt(editWellTankCapacity) || 400) / (parseInt(editWellTankHeight) || 20)) * (parseInt(editWellTanks) || 1)).toFixed(1)} per foot
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
          <GpsRoutesTab />
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
    </div>
  );
}
