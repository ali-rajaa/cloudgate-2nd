// Onboarding: create the organisation, add details, upload documents, submit for review.
import { db, state, h, field, busy, toast, rpc, select, go, notice, pageHead, badge, uploadFile, normalisePhone, phoneDisplay, refreshOrg, friendly } from './core.js';

export function routes(register) {
  register('/start', { title: 'Set up your account', render: start });
  register('/onboarding', { title: 'Your application', render: onboarding });
}

export const SECTORS = ['Blue Area', 'F-5', 'F-6', 'F-6 Markaz (Supermarket)', 'F-7', 'F-7 Markaz (Jinnah Super)', 'F-8', 'F-8 Markaz', 'F-10', 'F-10 Markaz', 'F-11', 'F-11 Markaz',
  'G-5', 'G-6', 'G-6 Markaz (Melody)', 'G-7', 'G-8', 'G-8 Markaz', 'G-9', 'G-9 Markaz (Karachi Company)', 'G-10', 'G-10 Markaz', 'G-11', 'G-11 Markaz', 'G-13', 'G-14',
  'I-8', 'I-8 Markaz', 'I-9', 'I-10', 'E-7', 'E-11', 'DHA', 'Bahria Town', 'Other'];

export const DOCS = {
  vendor: [
    ['registration', 'Business registration', 'SECP certificate, partnership deed, or sole proprietor details'],
    ['ntn', 'NTN certificate', 'From FBR\'s Active Taxpayer List'],
    ['ifa_licence', 'Islamabad Food Authority licence', 'Required for every food business'],
    ['dts', 'Department of Tourist Services registration', 'Restaurants and cafes only'],
    ['signatory_cnic', 'CNIC of the person signing', 'Front and back in one file'],
    ['authority_letter', 'Authority letter', 'Only if the signatory isn\'t the owner'],
    ['bank_letter', 'Bank letter', 'For the account in the business\'s name'],
    ['address_proof', 'Proof of address', 'A utility bill or rent agreement'],
  ],
  ngo: [
    ['registration', 'Registration certificate', 'Societies Act, Trusts Act, Section 42 company, or Ministry of Interior for international NGOs'],
    ['constitution', 'Constitution or trust deed', ''],
    ['office_bearers', 'List of office bearers', ''],
    ['authority_letter', 'Authority letter or board resolution', 'Naming the person who will use Rizq Rasan'],
    ['signatory_cnic', 'CNIC of the person signing', 'Front and back in one file'],
    ['address_proof', 'Proof of address', 'A utility bill or rent agreement'],
  ],
};
const REQUIRED = { vendor: ['registration', 'ntn', 'ifa_licence', 'signatory_cnic', 'bank_letter'], ngo: ['registration', 'authority_letter', 'signatory_cnic'] };

async function start() {
  if (state.org) { go('/onboarding'); return h('div'); }
  // Details from sign-up: saved on this device, or with the account (when the
  // email link is opened on another device).
  const meta = state.user?.user_metadata || {};
  const pending = JSON.parse(localStorage.getItem('rr-pending-org') || 'null')
    || (meta.org_type && meta.org_name ? { type: meta.org_type, name: meta.org_name, phone: meta.phone } : null);
  const type = field({ name: 'type', label: 'Account type', type: 'select', required: true, value: pending?.type,
    options: [{ value: 'vendor', label: 'Food business with surplus food' }, { value: 'ngo', label: 'NGO, shelter or kitchen that feeds people' }] });
  const name = field({ name: 'name', label: 'Business or organisation name', required: true, value: pending?.name || '' });
  const submit = h('button.btn.btn--primary', { type: 'submit' }, 'Continue');
  const form = h('form.app-form.card', { novalidate: true }, type.wrap, name.wrap, submit);
  const create = async () => {
    const id = await rpc('create_organisation', { p_type: type.value(), p_name: name.value(), p_business_kind: null, p_phone: pending?.phone || state.profile?.phone || null });
    await rpc('accept_policies', { p_org: id, p_policies: ['terms', 'privacy', type.value() === 'vendor' ? 'vendor-agreement' : 'ngo-agreement'], p_version: '0.1' });
    localStorage.removeItem('rr-pending-org');
    window.dispatchEvent(new Event('rr:state'));
    go('/onboarding');
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!type.value()) return type.error('Choose one.');
    if (name.value().length < 2) return name.error('Enter the name.');
    busy(submit, create);
  });
  // Details given at sign-up on this device: create the organisation straight away.
  if (pending?.type && pending?.name) {
    try { await create(); return h('div'); }
    catch (e) { toast(friendly(e), 'error'); }
  }
  return h('section.app-narrow', pageHead('Set up your account', 'Tell us who you are. You\'ll add details and documents next.'), form);
}

async function onboarding({ app }) {
  if (!state.org) { go('/start'); return h('div'); }
  await refreshOrg();
  const o = state.org;
  const docs = await select(db.from('documents').select('*').eq('organisation_id', o.id).order('created_at'));
  const owner = state.membershipRole === 'owner';

  if (o.status === 'approved') {
    return h('section.app-narrow', pageHead('You\'re approved', null),
      notice('info', o.type === 'vendor' ? 'You can list surplus food now.' : 'You can find and claim food near you now.'),
      h('p', h('a.btn.btn--primary', { href: o.type === 'vendor' ? '#/vendor/new' : '#/ngo' }, o.type === 'vendor' ? 'List food' : 'Find food')));
  }

  const locked = ['pending_review', 'rejected', 'suspended', 'removed'].includes(o.status);
  const statusBox = {
    onboarding: notice('info', 'Complete each section, then submit. We check applications within 2 working days.'),
    pending_review: notice('info', 'Thanks, your application is with our team. We check applications within 2 working days and will email you.'),
    needs_changes: notice('warning', 'Please fix this and submit again: ' + (o.status_reason || 'see the notes on your documents.')),
    rejected: notice('warning', 'Your application was not approved. ' + (o.status_reason || '') + ' Contact us if you think this is a mistake.'),
    suspended: notice('warning', 'Your account is suspended. ' + (o.status_reason || '') + ' You can appeal within 7 days by contacting us.'),
  }[o.status];

  // Section 1: details
  const f = {
    legal_name: field({ name: 'legal_name', label: 'Registered name', value: o.legal_name || '', hint: 'As written on your registration' }),
    registration_number: field({ name: 'registration_number', label: 'Registration number', value: o.registration_number || '' }),
    ntn: field({ name: 'ntn', label: 'NTN', value: o.ntn || '', required: o.type === 'vendor', hint: o.type === 'vendor' ? 'Every business needs an NTN' : 'If you have one' }),
    phone: field({ name: 'phone', label: 'Contact mobile', type: 'tel', required: true, value: phoneDisplay(o.phone), inputmode: 'tel' }),
    email: field({ name: 'email', label: 'Contact email', type: 'email', value: o.email || state.user.email }),
    address: field({ name: 'address', label: o.type === 'vendor' ? 'Pickup address' : 'Address', required: true, value: o.address || '', full: true,
      placeholder: 'Shop 12, Street 3, F-7 Markaz', hint: o.type === 'ngo' ? 'Used only to work out distances. Businesses never see it.' : 'NGOs see this only after they pay.' }),
    sector: field({ name: 'sector', label: 'Area', type: 'select', required: true, value: o.sector, options: SECTORS }),
  };
  if (o.type === 'vendor') {
    f.business_kind = field({ name: 'business_kind', label: 'Type of business', type: 'select', value: o.business_kind, options: ['Bakery', 'Restaurant', 'Grocer or supermarket', 'Cafe'] });
    f.pickup_instructions = field({ name: 'pickup_instructions', label: 'Pickup instructions', type: 'textarea', value: o.pickup_instructions || '', full: true, placeholder: 'Ask for the manager at the back counter' });
  } else {
    f.business_kind = field({ name: 'business_kind', label: 'Type of organisation', type: 'select', value: o.business_kind, options: ['NGO', 'Shelter', 'Community kitchen', 'Food bank', 'Orphanage', 'Other'] });
    f.people_served_per_day = field({ name: 'people_served_per_day', label: 'People you serve each day', type: 'number', min: 1, value: o.people_served_per_day || '' });
  }
  const pin = h('p.field__hint', o.lat ? `Map pin saved (${o.lat.toFixed(4)}, ${o.lng.toFixed(4)}).` : 'No map pin yet. Add one so distances are accurate.');
  let coords = o.lat ? { lat: o.lat, lng: o.lng } : null;
  const pinBtn = h('button.btn.btn--secondary.btn--sm', { type: 'button', onclick: () => {
    if (!navigator.geolocation) return toast('Your browser can\'t share a location.', 'error');
    navigator.geolocation.getCurrentPosition((p) => {
      const { latitude: lat, longitude: lng } = p.coords;
      if (lat < 33.4 || lat > 33.9 || lng < 72.7 || lng > 73.4) return toast('That location is outside Islamabad. Stand at your address and try again.', 'error');
      coords = { lat, lng }; pin.textContent = `Map pin set (${lat.toFixed(4)}, ${lng.toFixed(4)}). Save to keep it.`;
    }, () => toast('Location permission was refused.', 'error'), { enableHighAccuracy: true, timeout: 15000 });
  } }, 'Use my current location');
  const saveDetails = h('button.btn.btn--primary', { type: 'submit' }, 'Save details');
  const detailsForm = h('form.app-form', { novalidate: true },
    h('div.form__grid', Object.values(f).map((x) => x.wrap), h('div.field.field--full', h('span.field__label', 'Map pin'), pin, pinBtn)),
    owner && !locked ? saveDetails : null);
  detailsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const tel = normalisePhone(f.phone.value());
    if (!tel) return f.phone.error('Enter a Pakistani mobile number, like 0300 1234567.');
    if (!f.address.value()) return f.address.error('Enter the address.');
    if (!f.sector.value()) return f.sector.error('Choose the area.');
    if (o.type === 'vendor' && !f.ntn.value()) return f.ntn.error('Enter your NTN.');
    const fields = {};
    for (const [k, x] of Object.entries(f)) fields[k] = k === 'phone' ? tel : String(x.value() ?? '');
    if (coords) { fields.lat = String(coords.lat); fields.lng = String(coords.lng); }
    busy(saveDetails, async () => { await rpc('update_organisation', { p_org: o.id, p_fields: fields }); toast('Details saved.'); app.refresh(); });
  });
  if (locked || !owner) detailsForm.querySelectorAll('input, select, textarea, button').forEach((x) => { x.disabled = true; });

  // Section 2: documents
  const docList = h('ul.app-doclist');
  for (const [kind, label, hint] of DOCS[o.type]) {
    const mine = docs.filter((d) => d.kind === kind);
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,application/pdf', hidden: true });
    const btn = h('button.btn.btn--secondary.btn--sm', { type: 'button', disabled: locked, onclick: () => input.click() }, mine.length ? 'Replace' : 'Upload');
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return toast('Files must be 10 MB or smaller.', 'error');
      busy(btn, async () => {
        const path = await uploadFile('documents', o.id, file, kind + '-');
        await rpc('add_document', { p_org: o.id, p_kind: kind, p_path: path, p_expires_on: null });
        toast(label + ' uploaded.');
        app.refresh();
      });
    });
    const latest = mine[mine.length - 1];
    docList.append(h('li.app-doc',
      h('div', h('p.app-doc__name', label, REQUIRED[o.type].includes(kind) ? null : h('span.field__optional', ' (if it applies)')), hint ? h('p.app-doc__hint', hint) : null,
        latest?.status === 'rejected' && latest.reason ? h('p.field__error', latest.reason) : null),
      h('div.app-doc__end', latest ? h('span.badge', { class: latest.status === 'approved' ? 'badge--good' : latest.status === 'rejected' ? 'badge--bad' : 'badge--wait' },
        latest.status === 'uploaded' ? 'Uploaded' : latest.status === 'approved' ? 'Checked' : 'Needs a new file') : null, btn, input)));
  }

  // Section 3 (businesses): where NGOs pay
  let paySection = null;
  if (o.type === 'vendor') {
    const p = {
      raast_id: field({ name: 'raast_id', label: 'Raast ID', value: o.raast_id || '', hint: 'Usually your mobile number registered with your bank' }),
      bank_account_title: field({ name: 'bank_account_title', label: 'Account title', value: o.bank_account_title || '' }),
      bank_iban: field({ name: 'bank_iban', label: 'IBAN', value: o.bank_iban || '', placeholder: 'PK36 SCBL 0000 0011 2345 6702', full: true }),
    };
    const savePay = h('button.btn.btn--primary', { type: 'submit' }, 'Save payment details');
    paySection = h('form.app-form', { novalidate: true }, h('div.form__grid', Object.values(p).map((x) => x.wrap)), owner && !locked ? savePay : null);
    paySection.addEventListener('submit', (e) => {
      e.preventDefault();
      const iban = p.bank_iban.value().replace(/\s/g, '').toUpperCase();
      if (iban && !/^PK\d{2}[A-Z]{4}\d{16}$/.test(iban)) return p.bank_iban.error('A Pakistani IBAN has 24 characters and starts with PK.');
      if (!iban && !p.raast_id.value()) return p.raast_id.error('Add a Raast ID or an IBAN so NGOs can pay you.');
      busy(savePay, async () => {
        await rpc('update_organisation', { p_org: o.id, p_fields: { raast_id: p.raast_id.value(), bank_account_title: p.bank_account_title.value(), bank_iban: iban } });
        toast('Payment details saved.'); app.refresh();
      });
    });
    if (locked || !owner) paySection.querySelectorAll('input, button').forEach((x) => { x.disabled = true; });
  }

  // Submit
  const missing = REQUIRED[o.type].filter((k) => !docs.some((d) => d.kind === k && d.status !== 'rejected'));
  const ready = o.phone && o.address && o.sector && (o.type === 'ngo' || o.ntn) && missing.length === 0 && (o.type === 'ngo' || o.raast_id || o.bank_iban);
  const submitBtn = h('button.btn.btn--accent', { type: 'button', disabled: !ready || locked || !owner, onclick: () => busy(submitBtn, async () => {
    await rpc('submit_for_review', { p_org: o.id });
    toast('Application submitted.');
    window.dispatchEvent(new Event('rr:state'));
  }) }, o.status === 'needs_changes' ? 'Submit again' : 'Submit for review');
  const todo = [];
  if (!(o.phone && o.address && o.sector)) todo.push('your details');
  if (missing.length) todo.push(`${missing.length} required document${missing.length > 1 ? 's' : ''}`);
  if (o.type === 'vendor' && !(o.raast_id || o.bank_iban)) todo.push('your payment details');

  return h('section.app-narrow',
    pageHead(o.name, o.type === 'vendor' ? 'Business application' : 'Organisation application', badge(o.status)),
    statusBox,
    h('section.app-section', h('h2.app-h2', '1. Details'), detailsForm),
    h('section.app-section', h('h2.app-h2', '2. Documents'), h('p.app-muted', 'JPG, PNG or PDF, up to 10 MB each. Only you and our review team can see them.'), docList),
    paySection ? h('section.app-section', h('h2.app-h2', '3. Where NGOs pay you'), h('p.app-muted', 'NGOs pay you directly by Raast or bank transfer. You confirm when the money arrives.'), paySection) : null,
    locked ? null : h('section.app-section.app-submit', todo.length ? h('p.app-muted', 'Still needed: ' + todo.join(', ') + '.') : h('p.app-muted', 'Everything is in. Submit when you\'re ready.'), submitBtn),
    owner ? null : notice('info', 'Only the account owner can change these details.'));
}
