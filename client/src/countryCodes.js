// countryCodes.js — shared country-calling-code list for phone entry UI
// (ContactsPanel's per-contact selector, TenantFormScreen's per-tenant
// default). A phone typed without "+" is ambiguous without knowing which
// country it's from -- see src/phone.js's normalisePhone/isValidE164 on the
// backend for how this digits-only code is actually used.

export const COUNTRY_CODES = [
  { code: '234', label: 'Nigeria (+234)' },
  { code: '370', label: 'Lithuania (+370)' },
  { code: '44', label: 'United Kingdom (+44)' },
  { code: '1', label: 'US / Canada (+1)' },
  { code: '254', label: 'Kenya (+254)' },
  { code: '233', label: 'Ghana (+233)' },
  { code: '27', label: 'South Africa (+27)' },
  { code: '353', label: 'Ireland (+353)' },
  { code: '49', label: 'Germany (+49)' },
  { code: '48', label: 'Poland (+48)' },
];
