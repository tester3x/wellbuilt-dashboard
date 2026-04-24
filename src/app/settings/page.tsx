'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { AppHeader } from '@/components/AppHeader';
import {
  type CompanyConfig,
  loadCompanyById,
  loadAllCompanies,
} from '@/lib/companySettings';
import { CompanyProfileCard } from '@/components/settings/CompanyProfileCard';
import { InvoiceConfigCard } from '@/components/settings/InvoiceConfigCard';
import { OperationsCard } from '@/components/settings/OperationsCard';
import { OilCompaniesCard } from '@/components/settings/OilCompaniesCard';
import { RateSheetsCard } from '@/components/settings/RateSheetsCard';
import { PayConfigCard } from '@/components/settings/PayConfigCard';
import { BrandingCard } from '@/components/settings/BrandingCard';
import { BillingConfigCard } from '@/components/settings/BillingConfigCard';
import { TicketTemplateCard } from '@/components/settings/TicketTemplateCard';
import { PayrollTemplateCard } from '@/components/settings/PayrollTemplateCard';
import { PackagesCard } from '@/components/settings/PackagesCard';
import { SWDDirectoryCard } from '@/components/settings/SWDDirectoryCard';
import { CustomJobTypesCard } from '@/components/settings/CustomJobTypesCard';
import { PhotosCard } from '@/components/settings/PhotosCard';
import { JsaCard } from '@/components/settings/JsaCard';
import { LevelReportsCard } from '@/components/settings/LevelReportsCard';
import { JobTypeRnDCard } from '@/components/settings/JobTypeRnDCard';
import { RolesCard } from '@/components/settings/RolesCard';

export default function SettingsPage() {
  const { user, loading: authLoading, userCompany } = useAuth();
  const router = useRouter();

  const [company, setCompany] = useState<CompanyConfig | null>(null);
  const [allCompanies, setAllCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Determine if WB admin (no companyId = sees all companies)
  const isWbAdmin = user ? !user.companyId : false;

  // Auth guard — redirect if not authorized
  useEffect(() => {
    if (!authLoading && user && !hasCapability(user, 'viewSettings', userCompany)) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  // Load companies
  useEffect(() => {
    if (!user || authLoading) return;

    const load = async () => {
      setDataLoading(true);
      setError(null);
      try {
        if (isWbAdmin) {
          // WB admin: load all companies, show picker
          const companies = await loadAllCompanies();
          setAllCompanies(companies);
          // Default to first company if available
          if (companies.length > 0 && !selectedCompanyId) {
            setSelectedCompanyId(companies[0].id);
            setCompany(companies[0]);
          }
        } else if (user.companyId) {
          // Hauler admin: load their company
          const comp = await loadCompanyById(user.companyId);
          if (comp) {
            setCompany(comp);
            setSelectedCompanyId(comp.id);
          } else {
            setError('Company not found');
          }
        }
      } catch (err) {
        console.error('Failed to load company:', err);
        setError('Failed to load company data');
      } finally {
        setDataLoading(false);
      }
    };

    load();
  }, [user, authLoading, isWbAdmin]);

  // Handle company picker change
  const handleCompanyChange = async (companyId: string) => {
    setSelectedCompanyId(companyId);
    setDataLoading(true);
    try {
      const comp = await loadCompanyById(companyId);
      setCompany(comp);
    } catch {
      setError('Failed to load company');
    } finally {
      setDataLoading(false);
    }
  };

  // Re-fetch current company after any card saves
  const handleRefresh = async () => {
    if (!selectedCompanyId) return;
    try {
      const comp = await loadCompanyById(selectedCompanyId);
      setCompany(comp);
      // Also refresh the picker list if WB admin
      if (isWbAdmin) {
        const companies = await loadAllCompanies();
        setAllCompanies(companies);
      }
    } catch {
      console.error('Failed to refresh company');
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-900">
        <AppHeader />
        <div className="flex items-center justify-center py-24">
          <div className="text-gray-400">Loading...</div>
        </div>
      </div>
    );
  }

  if (!user || !hasCapability(user, 'viewSettings', userCompany)) {
    return null; // redirect will happen via useEffect
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-white">Company Settings</h2>
              {company && (
                <p className="text-gray-400 text-sm mt-1">{company.name}</p>
              )}
            </div>
          </div>

          {/* WB Admin: Company Picker */}
          {isWbAdmin && allCompanies.length > 0 && (
            <div className="mt-4">
              <label className="text-gray-400 text-xs block mb-1">Select Company</label>
              <select
                value={selectedCompanyId || ''}
                onChange={e => handleCompanyChange(e.target.value)}
                className="px-3 py-2 bg-gray-700 text-white rounded text-sm w-72"
              >
                {allCompanies.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.id}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Loading / Error / Content */}
        {dataLoading ? (
          <div className="text-gray-400 text-center py-12">Loading company data...</div>
        ) : error ? (
          <div className="text-red-400 text-center py-12">{error}</div>
        ) : !company ? (
          <div className="text-gray-500 text-center py-12">No company found</div>
        ) : (
          <div className="space-y-4">
            <CompanyProfileCard company={company} onSave={handleRefresh} />
            <PackagesCard company={company} onSave={handleRefresh} />
            <CustomJobTypesCard company={company} onSave={handleRefresh} />
            <InvoiceConfigCard company={company} onSave={handleRefresh} />
            <OperationsCard company={company} onSave={handleRefresh} />
            <LevelReportsCard company={company} onSave={handleRefresh} />
            <PhotosCard company={company} onSave={handleRefresh} />
            <JsaCard company={company} onSave={handleRefresh} />
            <OilCompaniesCard company={company} onSave={handleRefresh} />
            <SWDDirectoryCard company={company} onSave={handleRefresh} />
            <RateSheetsCard company={company} onSave={handleRefresh} />
            <BillingConfigCard company={company} onSave={handleRefresh} />
            <TicketTemplateCard company={company} onSave={handleRefresh} />
            <PayrollTemplateCard company={company} onSave={handleRefresh} />
            <PayConfigCard company={company} onSave={handleRefresh} />
            <BrandingCard company={company} onSave={handleRefresh} />
            {/* Roles & Permissions — anyone with viewSettings can see it, but only
                users with manageRolesAndCapabilities can actually edit (default: 'it'). */}
            <RolesCard
              company={company}
              onSave={handleRefresh}
              canEdit={hasCapability(user, 'manageRolesAndCapabilities', userCompany)}
            />
            {/* WB Admin only — R&D pipeline for job type auto-promote/prune */}
            {isWbAdmin && <JobTypeRnDCard />}
          </div>
        )}
      </main>
    </div>
  );
}
