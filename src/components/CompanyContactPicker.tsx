'use client';

import { useEffect, useState } from 'react';

interface Company { id: string; name: string }
interface Contact { id: string; firstName: string; lastName: string; companyId: string | null }

export default function CompanyContactPicker({
  companyId,
  contactId,
  onCompanyChange,
  onContactChange,
  companyType,
}: {
  companyId: string;
  contactId: string;
  onCompanyChange: (id: string) => void;
  onContactChange: (id: string) => void;
  companyType?: string;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    fetch(`/api/companies${companyType ? `?type=${companyType}` : ''}`)
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies || []));
  }, [companyType]);

  useEffect(() => {
    fetch('/api/contacts')
      .then((r) => r.json())
      .then((d) => setContacts(d.contacts || []));
  }, []);

  const filteredContacts = companyId ? contacts.filter((c) => c.companyId === companyId) : contacts;

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="label">Company</label>
        <select className="input" value={companyId} onChange={(e) => onCompanyChange(e.target.value)}>
          <option value="">— None —</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Contact</label>
        <select className="input" value={contactId} onChange={(e) => onContactChange(e.target.value)}>
          <option value="">— None —</option>
          {filteredContacts.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>)}
        </select>
      </div>
    </div>
  );
}
