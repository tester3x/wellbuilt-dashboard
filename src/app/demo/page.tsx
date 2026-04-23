'use client';

// Phase 23 — public /demo route. Zero auth, zero Firebase writes,
// zero admin callables. All state is in-memory React state and
// disappears on navigation. The Phase 23 spec §6 (safety) requires
// this file to import NO Firebase SDK, NO useAuth, and NO admin
// callable names — the only outside import is the pure local
// classifier in @/lib/demoClassifyLocation.ts.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  classifyDemoLocation,
  DEMO_LOCATION_SEEDS,
  type DemoClassification,
  type DemoLocationType,
} from '@/lib/demoClassifyLocation';

type Step = 'landing' | 'setup' | 'results';

interface DemoLocation {
  id: string;
  name: string;
  userDeclaredType: DemoLocationType;
}

const MAX_LOCATIONS = 8;

function newId(): string {
  return `loc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function typeLabel(t: DemoLocationType): string {
  if (t === 'well') return 'Well';
  if (t === 'disposal') return 'Disposal';
  return 'Custom';
}

function typeAccent(t: DemoLocationType): string {
  if (t === 'well') return 'bg-green-800/40 text-green-200';
  if (t === 'disposal') return 'bg-sky-800/40 text-sky-200';
  return 'bg-amber-800/40 text-amber-200';
}

function confidenceAccent(c: 'strong' | 'weak'): string {
  return c === 'strong'
    ? 'bg-emerald-700/40 text-emerald-200'
    : 'bg-gray-700 text-gray-300';
}

export default function DemoPage() {
  const [step, setStep] = useState<Step>('landing');
  const [companyName, setCompanyName] = useState<string>('Demo Hauling Co.');
  const [operationType, setOperationType] = useState<string>(
    'water / disposal'
  );
  const [locations, setLocations] = useState<DemoLocation[]>(() =>
    DEMO_LOCATION_SEEDS.map((s) => ({
      id: newId(),
      name: s.name,
      userDeclaredType: s.userDeclaredType,
    }))
  );

  function addLocation(): void {
    if (locations.length >= MAX_LOCATIONS) return;
    setLocations((prev) => [
      ...prev,
      { id: newId(), name: '', userDeclaredType: 'well' },
    ]);
  }

  function removeLocation(id: string): void {
    setLocations((prev) => prev.filter((l) => l.id !== id));
  }

  function updateLocation(
    id: string,
    patch: Partial<DemoLocation>
  ): void {
    setLocations((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ...patch } : l))
    );
  }

  function resetDemo(): void {
    setStep('landing');
    setCompanyName('Demo Hauling Co.');
    setOperationType('water / disposal');
    setLocations(
      DEMO_LOCATION_SEEDS.map((s) => ({
        id: newId(),
        name: s.name,
        userDeclaredType: s.userDeclaredType,
      }))
    );
  }

  const results = useMemo(
    () =>
      locations
        .filter((l) => l.name.trim().length > 0)
        .map((l) => ({
          ...l,
          classification: classifyDemoLocation(l.name),
        })),
    [locations]
  );

  const grouped = useMemo(() => {
    const wells: typeof results = [];
    const disposals: typeof results = [];
    const custom: typeof results = [];
    for (const r of results) {
      if (r.classification.type === 'well') wells.push(r);
      else if (r.classification.type === 'disposal') disposals.push(r);
      else custom.push(r);
    }
    return { wells, disposals, custom };
  }, [results]);

  const canAdvanceSetup = results.length > 0 && companyName.trim().length > 0;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <DemoHeader />

      <main className="max-w-3xl mx-auto px-4 py-10">
        {step === 'landing' && (
          <LandingView onStart={() => setStep('setup')} />
        )}

        {step === 'setup' && (
          <SetupView
            companyName={companyName}
            operationType={operationType}
            locations={locations}
            canAdvance={canAdvanceSetup}
            onCompanyName={setCompanyName}
            onOperationType={setOperationType}
            onUpdateLocation={updateLocation}
            onRemoveLocation={removeLocation}
            onAddLocation={addLocation}
            onBack={() => setStep('landing')}
            onSubmit={() => setStep('results')}
          />
        )}

        {step === 'results' && (
          <ResultsView
            companyName={companyName}
            operationType={operationType}
            results={results}
            grouped={grouped}
            onReset={resetDemo}
            onBack={() => setStep('setup')}
          />
        )}
      </main>

      <DemoFooter />
    </div>
  );
}

// ── Header / Footer (lightweight, not the admin AppHeader) ─────────────────

function DemoHeader(): React.ReactElement {
  return (
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">WellBuilt</h1>
          <p className="text-xs text-gray-400">Try the setup experience</p>
        </div>
        <Link
          href="/login"
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          Sign in →
        </Link>
      </div>
    </header>
  );
}

function DemoFooter(): React.ReactElement {
  return (
    <footer className="max-w-3xl mx-auto px-4 py-6 text-center text-[11px] text-gray-500">
      This demo runs entirely in your browser. Nothing you type here is
      saved.
    </footer>
  );
}

// ── Landing ────────────────────────────────────────────────────────────────

function LandingView({
  onStart,
}: {
  onStart: () => void;
}): React.ReactElement {
  return (
    <section className="bg-gray-800 rounded-lg p-8 shadow-xl">
      <h2 className="text-3xl font-bold text-white mb-4">Try WellBuilt</h2>
      <p className="text-gray-300 mb-2">
        Set up a mock operation and see how WellBuilt recognizes your
        wells, disposals, and custom locations.
      </p>
      <p className="text-gray-400 text-sm mb-8">
        No account needed. Nothing is saved. Takes 30 seconds.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
      >
        Start Demo
      </button>

      <div className="mt-8 border-t border-gray-700 pt-6 text-xs text-gray-400 space-y-1">
        <p>You'll be asked for:</p>
        <ul className="list-disc list-inside text-gray-500 ml-2">
          <li>a company name</li>
          <li>one or more location names (we pre-fill three examples)</li>
        </ul>
        <p className="mt-2">
          Then you'll see how the WellBuilt truth layer resolves each
          name automatically.
        </p>
      </div>
    </section>
  );
}

// ── Setup wizard ───────────────────────────────────────────────────────────

function SetupView({
  companyName,
  operationType,
  locations,
  canAdvance,
  onCompanyName,
  onOperationType,
  onUpdateLocation,
  onRemoveLocation,
  onAddLocation,
  onBack,
  onSubmit,
}: {
  companyName: string;
  operationType: string;
  locations: DemoLocation[];
  canAdvance: boolean;
  onCompanyName: (v: string) => void;
  onOperationType: (v: string) => void;
  onUpdateLocation: (id: string, patch: Partial<DemoLocation>) => void;
  onRemoveLocation: (id: string) => void;
  onAddLocation: () => void;
  onBack: () => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <section className="space-y-6">
      {/* Step 1 — Company */}
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="text-xs text-gray-400 uppercase tracking-wide mb-3">
          Step 1 · Your operation
        </div>
        <label className="block mb-4">
          <span className="block text-sm text-gray-300 mb-1">
            Company name
          </span>
          <input
            type="text"
            value={companyName}
            onChange={(e) => onCompanyName(e.target.value)}
            placeholder="e.g. Demo Hauling Co."
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        <label className="block">
          <span className="block text-sm text-gray-300 mb-1">
            Operation type
          </span>
          <select
            value={operationType}
            onChange={(e) => onOperationType(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="water / disposal">Water / disposal</option>
            <option value="crude oil">Crude oil</option>
            <option value="aggregate">Aggregate</option>
            <option value="mixed">Mixed</option>
          </select>
        </label>
      </div>

      {/* Step 2 — Locations */}
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="text-xs text-gray-400 uppercase tracking-wide mb-3">
          Step 2 · Locations ({locations.length})
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Add 1–{MAX_LOCATIONS} locations you work. We've pre-filled
          three examples — one well, one disposal, one custom — so you
          can see all three classification paths.
        </p>
        <ul className="space-y-3">
          {locations.map((l) => (
            <li
              key={l.id}
              className="grid grid-cols-[1fr_auto_auto] gap-2 items-center"
            >
              <input
                type="text"
                value={l.name}
                onChange={(e) =>
                  onUpdateLocation(l.id, { name: e.target.value })
                }
                placeholder="e.g. GABRIEL 1-36-25H"
                className="px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <select
                value={l.userDeclaredType}
                onChange={(e) =>
                  onUpdateLocation(l.id, {
                    userDeclaredType: e.target.value as DemoLocationType,
                  })
                }
                className="px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                aria-label="Declared type"
              >
                <option value="well">Well</option>
                <option value="disposal">Disposal</option>
                <option value="custom">Custom</option>
              </select>
              <button
                type="button"
                onClick={() => onRemoveLocation(l.id)}
                disabled={locations.length <= 1}
                title={
                  locations.length <= 1
                    ? 'At least one location is required'
                    : 'Remove this location'
                }
                className="px-2 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-gray-300 rounded text-xs"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onAddLocation}
          disabled={locations.length >= MAX_LOCATIONS}
          className="mt-4 px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-gray-200 rounded"
        >
          + Add location
        </button>
      </div>

      {/* Nav */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canAdvance}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:cursor-not-allowed text-white rounded font-medium"
        >
          See results →
        </button>
      </div>
    </section>
  );
}

// ── Results ────────────────────────────────────────────────────────────────

interface ResultsViewEntry extends DemoLocation {
  classification: DemoClassification;
}

function ResultsView({
  companyName,
  operationType,
  results,
  grouped,
  onReset,
  onBack,
}: {
  companyName: string;
  operationType: string;
  results: ResultsViewEntry[];
  grouped: {
    wells: ResultsViewEntry[];
    disposals: ResultsViewEntry[];
    custom: ResultsViewEntry[];
  };
  onReset: () => void;
  onBack: () => void;
}): React.ReactElement {
  return (
    <section className="space-y-6">
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="text-xs text-gray-400 uppercase tracking-wide mb-2">
          Demo · Classification results
        </div>
        <h2 className="text-xl font-bold text-white">
          {companyName || 'Your operation'}
        </h2>
        <p className="text-sm text-gray-400 mt-1">
          Operation type:{' '}
          <span className="text-gray-300">{operationType}</span>
        </p>
        <div className="mt-3 flex gap-3 text-xs text-gray-400">
          <span>
            <span className="text-green-300 font-medium">
              {grouped.wells.length}
            </span>{' '}
            well{grouped.wells.length === 1 ? '' : 's'}
          </span>
          <span>
            <span className="text-sky-300 font-medium">
              {grouped.disposals.length}
            </span>{' '}
            disposal{grouped.disposals.length === 1 ? '' : 's'}
          </span>
          <span>
            <span className="text-amber-300 font-medium">
              {grouped.custom.length}
            </span>{' '}
            custom
          </span>
        </div>
      </div>

      <ResultsGroup
        title="Wells"
        description="NDIC-style names WellBuilt recognizes automatically."
        entries={grouped.wells}
      />

      <ResultsGroup
        title="Disposals"
        description="Matched against the SWD / disposal reference set."
        entries={grouped.disposals}
      />

      <ResultsGroup
        title="Custom operational"
        description="Pads, yards, or one-off names. WellBuilt keeps them first-class — they're real places that drivers use."
        entries={grouped.custom}
      />

      <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 text-xs text-gray-400">
        <p className="mb-2">
          <span className="text-gray-300 font-medium">
            What you're seeing:
          </span>{' '}
          the same classification pipeline WellBuilt runs against every
          well, disposal, and pad across a real operation. In the live
          system, custom names can be promoted to official references
          with one click, and known NDIC wells auto-resolve without any
          setup.
        </p>
        <p>
          Nothing entered on this page was saved.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
        >
          ← Edit locations
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReset}
            className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
          >
            Reset demo
          </button>
          <Link
            href="/register"
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-medium"
          >
            Create an account
          </Link>
        </div>
      </div>
    </section>
  );
}

function ResultsGroup({
  title,
  description,
  entries,
}: {
  title: string;
  description: string;
  entries: ResultsViewEntry[];
}): React.ReactElement {
  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h3 className="text-sm font-semibold text-white uppercase tracking-wide">
        {title}
      </h3>
      <p className="text-xs text-gray-400 mt-1 mb-4">{description}</p>
      {entries.length === 0 ? (
        <div className="text-xs text-gray-500">(none)</div>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => {
            const c = e.classification;
            const declaredMatches = e.userDeclaredType === c.type;
            return (
              <li
                key={e.id}
                className="bg-gray-900/50 border border-gray-700/50 rounded px-3 py-2"
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-white font-medium">{e.name}</span>
                  <span
                    className={`uppercase px-1.5 py-0.5 rounded text-[10px] ${typeAccent(
                      c.type
                    )}`}
                  >
                    {typeLabel(c.type)}
                  </span>
                  <span
                    className={`uppercase px-1.5 py-0.5 rounded text-[10px] ${confidenceAccent(
                      c.confidence
                    )}`}
                  >
                    {c.confidence}
                  </span>
                  {!declaredMatches && (
                    <span
                      className="text-[10px] text-gray-500"
                      title={`You declared: ${typeLabel(e.userDeclaredType)}`}
                    >
                      you said {typeLabel(e.userDeclaredType).toLowerCase()}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  {c.explanation}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
