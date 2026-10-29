'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getInspectionProfile, listInspectionProfiles, publishInspectionDraft, saveInspectionDraft,
  saveInspectionSettings, uploadInspectionPhoto, type InspectionProfile, type ProfileSettings,
} from '@/lib/equipment/inspectionProfiles';

type Props = { companyId: string; units: string[]; canEdit: boolean };
const freshId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

export function InspectionProfilesPanel({ companyId, units, canEdit }: Props) {
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [profile, setProfile] = useState<InspectionProfile | null>(null);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ draftId: string; draftRevision: string } | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!companyId) return;
    try { setSettings(await listInspectionProfiles(companyId)); setMessage(''); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to load profiles'); }
  }, [companyId]);
  useEffect(() => { void refresh(); setProfile(null); setDraft(null); }, [refresh]);

  const open = async (profileId: string) => {
    setBusy(true); setMessage('');
    try {
      const response = await getInspectionProfile(companyId, profileId);
      setProfile(structuredClone(response.manifest));
      setSourceId(profileId); setBaseRevision(response.manifest.revision); setDraft(null);
      setImages(Object.fromEntries(Object.entries(response.downloads).map(([id, value]) => [id, value.url])));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to open profile'); }
    finally { setBusy(false); }
  };
  const update = (next: InspectionProfile) => { setProfile(next); setDraft(null); };
  const saveSettings = async (next: ProfileSettings) => {
    setBusy(true); setMessage('');
    try { setSettings(await saveInspectionSettings(companyId, next)); setMessage('Profile choices saved.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save choices'); await refresh(); }
    finally { setBusy(false); }
  };
  const saveDraft = async () => {
    if (!profile) return;
    setBusy(true); setMessage('');
    try {
      const saved = await saveInspectionDraft(companyId, profile, sourceId, baseRevision);
      setDraft(saved); setMessage('Draft saved. Review it, then publish when ready.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Draft save failed'); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!draft) return;
    setBusy(true); setMessage('');
    try {
      const result = await publishInspectionDraft(companyId, draft.draftId, draft.draftRevision);
      setDraft(null); await refresh(); await open(result.profileId);
      setMessage(`Published ${result.profileId}. Select it for drivers when ready.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Publish failed'); }
    finally { setBusy(false); }
  };
  const replacePhoto = async (areaId: string, file?: File) => {
    if (!file || !profile) return;
    setBusy(true); setMessage('');
    try {
      const image = await uploadInspectionPhoto(companyId, file);
      const areaImages = { ...profile.areaImages, [areaId]: image.imageId };
      update({ ...profile, images: [...profile.images.filter(row => Object.values(areaImages).includes(row.imageId)), image], areaImages });
      setImages(old => ({ ...old, [image.imageId]: URL.createObjectURL(file) }));
      setMessage('Photo uploaded. Save and publish the draft to use it in future inspections.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Photo upload failed'); }
    finally { setBusy(false); }
  };
  const restoreArea = async (areaId: string) => {
    if (!profile || !sourceId) return;
    setBusy(true);
    try {
      const original = await getInspectionProfile(companyId, sourceId, baseRevision || undefined);
      const area = original.manifest.catalog.areas.find(row => row.areaId === areaId);
      if (!area) return;
      const imageId = original.manifest.areaImages[areaId];
      const image = original.manifest.images.find(row => row.imageId === imageId);
      update({ ...profile, catalog: { ...profile.catalog, areas: profile.catalog.areas.map(row => row.areaId === areaId ? area : row) },
        areaImages: { ...profile.areaImages, [areaId]: imageId },
        images: image && !profile.images.some(row => row.imageId === imageId) ? [...profile.images, image] : profile.images });
      if (original.downloads[imageId]) setImages(old => ({ ...old, [imageId]: original.downloads[imageId].url }));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Restore failed'); }
    finally { setBusy(false); }
  };
  const restoreProfile = async () => {
    if (!sourceId || !baseRevision) return;
    setBusy(true);
    try {
      const original = await getInspectionProfile(companyId, sourceId, baseRevision);
      update(structuredClone(original.manifest));
      setImages(Object.fromEntries(Object.entries(original.downloads).map(([id, value]) => [id, value.url])));
      setMessage('Published version restored in the editor. Save a draft to keep this change.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Restore failed'); }
    finally { setBusy(false); }
  };

  if (!settings) return <div className="text-sm text-gray-400">Loading inspection profiles… {message}</div>;
  const editable = canEdit && settings.canManage;
  return <div className="space-y-5 text-sm">
    <div className="rounded border border-gray-700 bg-gray-800 p-4">
      <h2 className="text-lg font-semibold">DVIR inspection profiles</h2>
      <p className="mt-1 text-gray-400">Choose the truck inspections this company uses. These profiles are independent of job packages.</p>
      {message && <p role="status" className="mt-3 text-amber-300">{message}</p>}
      <button type="button" className="mt-3 rounded bg-gray-700 px-3 py-1" onClick={() => void refresh()} disabled={busy}>Refresh</button>
    </div>
    <div className="rounded border border-gray-700 bg-gray-800 p-4">
      <h3 className="font-semibold">Available profiles</h3>
      {!settings.available.length && <p className="mt-2 text-gray-400">No published profiles yet. WellBuilt defaults must be published before setup.</p>}
      {settings.available.map(entry => <div key={entry.profileId} className="mt-3 flex flex-wrap items-center gap-3 border-t border-gray-700 pt-3">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!editable || busy}
          checked={settings.selectedProfileIds.includes(entry.profileId)} onChange={event => {
            const selectedProfileIds = event.target.checked
              ? [...settings.selectedProfileIds, entry.profileId]
              : settings.selectedProfileIds.filter(id => id !== entry.profileId);
            void saveSettings({ ...settings, selectedProfileIds, defaultProfileId: selectedProfileIds.includes(settings.defaultProfileId || '') ? settings.defaultProfileId : null,
              truckAssignments: Object.fromEntries(Object.entries(settings.truckAssignments).filter(([, id]) => selectedProfileIds.includes(id))) });
          }} />{entry.title}</label>
        <span className="text-xs text-gray-400">{entry.source} · {entry.equipmentType}</span>
        <button type="button" className="rounded bg-blue-700 px-2 py-1" onClick={() => void open(entry.profileId)} disabled={busy}>Preview / edit</button>
      </div>)}
      {editable && <div className="mt-4">
        <label className="mr-2">Default profile</label>
        <select className="rounded bg-gray-900 p-2" value={settings.defaultProfileId || ''} disabled={busy}
          onChange={event => void saveSettings({ ...settings, defaultProfileId: event.target.value || null })}>
          <option value="">None</option>
          {settings.available.filter(row => settings.selectedProfileIds.includes(row.profileId)).map(row =>
            <option key={row.profileId} value={row.profileId}>{row.title}</option>)}
        </select>
      </div>}
    </div>
    {editable && <div className="rounded border border-gray-700 bg-gray-800 p-4">
      <h3 className="font-semibold">Truck assignments</h3>
      <p className="text-gray-400">Use the exact unit number recorded in the equipment registry.</p>
      {units.map(unit => <label key={unit} className="mt-2 flex items-center gap-3">{unit}
        <select className="rounded bg-gray-900 p-2" disabled={busy} value={settings.truckAssignments[unit] || ''}
          onChange={event => {
            const truckAssignments = { ...settings.truckAssignments };
            if (event.target.value) truckAssignments[unit] = event.target.value;
            else delete truckAssignments[unit];
            void saveSettings({ ...settings, truckAssignments });
          }}>
          <option value="">Company default</option>
          {settings.available.filter(row => settings.selectedProfileIds.includes(row.profileId)).map(row =>
            <option key={row.profileId} value={row.profileId}>{row.title}</option>)}
        </select>
      </label>)}
    </div>}
    {profile && <div className="rounded border border-gray-700 bg-gray-800 p-4">
      <h3 className="text-lg font-semibold">{profile.title}</h3>
      <p className="text-gray-400">{profile.catalog.areas.length} areas · revision {baseRevision}</p>
      {editable && <label className="mt-3 block">Profile title
        <input className="ml-2 rounded bg-gray-900 p-2" value={profile.title} disabled={busy}
          onChange={event => update({ ...profile, title: event.target.value })} /></label>}
      {profile.catalog.areas.map(area => <div key={area.areaId} className="mt-5 rounded border border-gray-600 p-3">
        <div className="flex flex-wrap items-center gap-3"><strong>{area.label}</strong><span className="text-gray-400">{area.assetRole}</span>
          {editable && <button type="button" className="rounded bg-gray-700 px-2 py-1" disabled={busy} onClick={() => void restoreArea(area.areaId)}>Restore published area</button>}
          {editable && <button type="button" disabled={busy || profile.catalog.areas.length <= 1} onClick={() => update({ ...profile,
            catalog: { ...profile.catalog, areas: profile.catalog.areas.filter(row => row.areaId !== area.areaId) },
            areaImages: Object.fromEntries(Object.entries(profile.areaImages).filter(([id]) => id !== area.areaId)) })}>Remove area</button>}
        </div>
        {editable && <label className="mt-2 block">Area name <input className="ml-2 rounded bg-gray-900 p-2" value={area.label} disabled={busy}
          onChange={event => update({ ...profile, catalog: { ...profile.catalog, areas: profile.catalog.areas.map(row => row.areaId === area.areaId
            ? { ...row, label: event.target.value } : row) } })} /></label>}
        {editable && <label className="mt-2 block">Equipment <select className="ml-2 rounded bg-gray-900 p-2" value={area.assetRole} disabled={busy}
          onChange={event => update({ ...profile, catalog: { ...profile.catalog, areas: profile.catalog.areas.map(row => row.areaId === area.areaId
            ? { ...row, assetRole: event.target.value as 'truck' | 'trailer' } : row) } })}>
          <option value="truck">Truck</option><option value="trailer" disabled={!profile.supportedModes.includes('tractor_tanker')}>Trailer</option>
        </select></label>}
        {images[profile.areaImages[area.areaId]] && <img className="mt-3 max-h-64 w-full object-contain" alt={`${area.label} reference`} src={images[profile.areaImages[area.areaId]]} />}
        {editable && <label className="mt-2 block">Replace photo <input type="file" accept="image/jpeg,image/png" disabled={busy}
          onChange={event => void replacePhoto(area.areaId, event.target.files?.[0])} /></label>}
        <ul className="mt-3 space-y-2">{area.items.map(item => <li key={item.itemId} className="flex gap-2">
          {editable ? <><input className="min-w-0 flex-1 rounded bg-gray-900 p-2" value={item.componentLabel} disabled={busy}
            onChange={event => update({ ...profile, catalog: { ...profile.catalog, areas: profile.catalog.areas.map(row => row.areaId === area.areaId
              ? { ...row, items: row.items.map(value => value.itemId === item.itemId ? { ...value, componentLabel: event.target.value } : value) } : row) } })} />
            <button type="button" disabled={busy || area.items.length <= 1} onClick={() => update({ ...profile, catalog: { ...profile.catalog,
              areas: profile.catalog.areas.map(row => row.areaId === area.areaId ? { ...row, items: row.items.filter(value => value.itemId !== item.itemId) } : row) } })}>Remove</button></>
            : <span>{item.componentLabel}</span>}
        </li>)}</ul>
        {editable && <button type="button" className="mt-3 rounded bg-gray-700 px-2 py-1" disabled={busy} onClick={() => update({ ...profile,
          catalog: { ...profile.catalog, areas: profile.catalog.areas.map(row => row.areaId === area.areaId
            ? { ...row, items: [...row.items, { itemId: freshId('item'), componentLabel: 'New inspection item' }] } : row) } })}>Add item</button>}
      </div>)}
      {editable && <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="rounded bg-gray-700 px-3 py-2" disabled={busy} onClick={() => void restoreProfile()}>Restore published profile</button>
        <button type="button" className="rounded bg-gray-700 px-3 py-2" disabled={busy} onClick={() => update({ ...profile,
          catalog: { ...profile.catalog, areas: [...profile.catalog.areas, { areaId: freshId('area'), label: 'New area', assetRole: 'truck',
            sortOrder: Math.max(0, ...profile.catalog.areas.map(row => row.sortOrder)) + 10,
            items: [{ itemId: freshId('item'), componentLabel: 'New inspection item' }] }] } })}>Add area</button>
        <button type="button" className="rounded bg-blue-700 px-3 py-2" disabled={busy} onClick={() => void saveDraft()}>Save draft</button>
        <button type="button" className="rounded bg-emerald-700 px-3 py-2 disabled:opacity-40" disabled={busy || !draft} onClick={() => void publish()}>Publish saved draft</button>
      </div>}
    </div>}
  </div>;
}
