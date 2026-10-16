---
title: Privacy Policy
order: 2
description: What personal data this website and the Rizq Rasan platform collect, why, who sees it, where it is stored, how long we keep it and your rights.
version: "0.1 (draft)"
effective: from launch (22 March 2027)
summary:
  - This website sets no cookies and runs no analytics, unless you choose the automatic Urdu translation. Its forms only send your details to us so we can reply.
  - We collect what we need to verify organisations, run orders and pay vendors. We never see card, bank or wallet login details.
  - Other users see only what a pickup needs. CNICs, documents and bank details are seen only by our team, and vendors never see an NGO's address.
  - Platform data is stored outside Pakistan. Verification and payment records are kept for the life of the account plus 6 years.
  - You can ask to see, correct or delete your data, and we will tell you within 72 hours of confirming a breach that affects you.
---
This policy explains how Rizq Rasan handles personal data: what we collect, why, who sees it, where it is kept, for how long, and what you can ask us to do. Section 2 covers this website's public pages. The rest covers the platform at /app/ and applies to you from the day you create an account. Listing and claiming food start at launch on 22 March 2027. Please read this policy with our [Terms of Service]({{ '/legal/terms/' | relative_url }}) and [Cookie Policy]({{ '/legal/cookies/' | relative_url }}).

## 1. Who we are

{% include company-line.html %} We decide why and how your personal data is used, so we are responsible for it as the data controller.

| Detail | Value |
| --- | --- |
| Company | {{ site.company.legal_name }} |
| SECP registration number | {{ site.company.secp_number | default: "Given here once the company is incorporated" }} |
| Registered office | {{ site.company.registered_office | default: "Given here once the company is incorporated" }} |
| Privacy contact | {{ site.contact.email }} |
| Grievance officer | {{ site.company.grievance_officer | default: "Named here before launch" }} |

"Personal data" means information about an identifiable person, such as a name, phone number, CNIC number or IP address. The platform mostly holds data about organisations, but this policy also covers the people who act for them: owners, staff, signatories, collectors and payers.

## 2. This website today

The public pages of this website are information pages. Accounts and logging in are on the platform at /app/, which the rest of this policy covers.

- **No cookies and no tracking.** It sets no cookies and uses no analytics, advertising or tracking tools. Our [Cookie Policy]({{ '/legal/cookies/' | relative_url }}) explains what the platform saves in your browser to keep you logged in.
- **Fonts.** Our typefaces load from Google Fonts. To send them, Google receives your IP address and basic details about your browser.
- **Urdu translation.** If you press the "اردو" button, Google Translate translates the page. Google receives your IP address, browser details and the page text, and sets a `googtrans` cookie to remember your choice until you switch back to English. Nothing loads unless you press the button. The translation is automatic, and the English text is the official version.
- **Hosting.** GitHub hosts this website. Like any web host, it receives your IP address when your browser asks for a page. We do not receive those records.

### The forms

The partner form and the contact form ask for:

| Form | What it asks for |
| --- | --- |
| Partner | Organisation, your name and email, how you would like to work with us, and if you choose, your mobile number |
| Contact | Your name and email, the topic and your message, and if you choose, your mobile number |

{% if site.forms.endpoint != "" %}When you send a form, your details go through our form service provider, which passes them on to us.{% else %}When you send a form, your own email app opens with a message to us that already holds your details. Nothing reaches us until you send that email, and it travels through your email provider and ours.{% endif %} If you email us directly, we receive your email address and what you write.

We use these details only to reply to you and deal with your request, such as a partnership or a place in the pilot. Ticking the box on a form means you agree to us contacting you about your request. Sending a form does not create an account. We don't sell these details, and we won't send you marketing unless you ask for it.

## 3. What the platform collects

We collect account, organisation, verification and signatory details from the day you create an account, and the rest once listing and claiming start. We ask only for what we need to verify organisations, run orders, move money and keep food safe.

| Type | What it includes |
| --- | --- |
| Account | Name, email, mobile number, password (stored only in scrambled form), language, role and last sign-in. If we add sign-in with Google and you use it, Google will share your name and email with us |
| Organisation | Legal and trading name, type, registration route and number, NTN and Active Taxpayer List status, contact person, opening hours and usual surplus times. For NGOs, also the number of people served each day and the trust tier |
| Verification documents | Registration documents, NTN, licences, authority letter or board resolution, bank certificate, address proof and any halal certificate, with expiry dates and the result of our checks. Our [Verification Policy]({{ '/legal/verification/' | relative_url }}) lists them |
| Signatories | The name and CNIC number of each person who signs for an organisation, a copy of their CNIC, and the result of our sanctions screening |
| Location | The vendor's pickup address and map pin, the NGO's kitchen or shelter location, and, only if you allow it, your phone's location for a "near me" search |
| Listings and photos | Food details, quantity, price, times, allergens and halal status, and 1 to 3 photos per listing |
| Orders | Who claimed, the collector, the payment deadline, the pickup code (stored encrypted), the quantity handed over, confirmations, reliability events and strikes |
| Collectors and payers | Each collector's name and mobile number, and the name, contact details and payment method of the up to 3 people allowed to pay for an NGO |
| Payments and payouts | PayFast references, amount, method, status and refunds. For vendors, the payout bank account (IBAN) and account title, commission, tax withheld and payout statements |
| Messages and reports | Problem reports, disputes, appeals and help requests, with the text and photos you add |
| Policy acceptances | Which version of each policy a person accepted and when. From launch, also in which language and from which IP address |
| Device and log data | IP address, browser and device type, sign-in events, error reports, a record of each message we send and whether it arrived, and an audit log of changes. Product analytics only if you agree |

**What we never collect.** You pay on PayFast's own page or in your bank's app, so we never receive card numbers, bank or wallet logins, PINs or one-time codes. We do not collect personal details of the people an NGO serves. Food photos are shrunk on your phone before upload, which also removes location data from them. Your phone's live location is used for the search and is not stored.

**CNICs.** We collect CNIC numbers and copies only for authorised signatories. The number is shown masked (61101-XXXXXXX-1), stored encrypted, and visible only to our admin team, never to other users. Misusing someone's identity information is an offence under section 16 of the Prevention of Electronic Crimes Act 2016 (PECA), and we treat CNICs as our most sensitive data. If we decide to check CNICs with NADRA's verification service, we will ask for the person's consent first and say so in this policy.

**People you tell us about.** When you add a signatory, staff member, collector or payer, make sure they know you are sharing their details with us and why, and point them to this policy.

## 4. Why we use it

Pakistan has no general data protection law in force. The Personal Data Protection Bill, published as a final draft in May 2023, had still not passed Parliament in October 2026. We follow the draft's standard anyway, so each use of personal data rests on one of these reasons:

- **Contract:** we need it to provide the service your organisation signed up for.
- **Legal duty:** the law requires it, for example keeping tax records.
- **Legitimate interest:** it keeps the platform fair, safe and working, without overriding your rights.
- **Consent:** you said yes, and you can withdraw it at any time.

| What we do | Reason |
| --- | --- |
| Reply to website forms and invite organisations to the pilot | Consent |
| Open and run accounts, and let people sign in | Contract |
| Verify organisations and signatories, screen them against sanctions and proscribed-organisation lists, and re-check them every 12 months | Contract, legal duty and legitimate interest. Consent for CNICs |
| Show listings to approved NGOs, work out distances, and run claims, payment deadlines and pickup codes | Contract |
| Take payments, make refunds, pay vendors, issue invoices and keep tax records | Contract and legal duty |
| Send account, order, payment and safety messages by email, WhatsApp and inside the platform | Contract |
| Send "food near you" alerts and other optional emails | Consent. You can switch them off at any time |
| Work out reliability scores and strikes, and handle disputes, complaints and appeals | Contract and legitimate interest |
| Handle food-safety incidents and recalls, and work with the Islamabad Food Authority | Legitimate interest and legal duty |
| Keep accounts secure, prevent fraud, fix errors and keep an audit log | Legitimate interest |
| Keep evidence of who accepted which policy, valid under the Electronic Transactions Ordinance 2002 | Legitimate interest |
| Understand how the platform is used, so we can improve it | Consent, through the cookie settings |
| Publish impact totals such as kilograms of food rescued | Legitimate interest. We publish totals only, never personal data |

**Automatic decisions.** Some outcomes follow automatically from rules everyone agrees to: a strike after a no-show or a cancellation after payment, a 24-hour pause after 3 unpaid claims in 7 days, the reliability score, and tighter limits when a score falls under 60. Every strike comes with a written reason and can be appealed, and a person reviews every appeal. Our [Reliability and No-show Policy]({{ '/legal/reliability/' | relative_url }}) explains how this works.

## 5. Who sees your data

### Other users

Each side sees only what a pickup needs. Live listings never appear on this public website.

| Data | Vendors see | NGOs see |
| --- | --- | --- |
| A listing's details, photos, area and distance, and the vendor's reliability badge | Their own | Approved NGOs, for listings within their browse area |
| The vendor's name, exact address and phone number | Their own | Only after the NGO's payment is confirmed |
| The NGO's name and reliability badge | For orders on their listings | Their own |
| The NGO's address | Never | Their own |
| The collector's name | At handover | Their own collectors |
| The pickup code | Never. They can only check a code typed in | Their own orders, and on the collector pass |
| CNICs, documents and bank details | Never anyone else's | Never anyone else's |

A collector's pass shows the pickup code, the vendor's address and the pickup time. Each person allowed to pay for an NGO gets a pay link for that order. In the pilot's direct payment mode, the NGO that claimed also sees the vendor's own Raast details so it can pay the vendor. When we decide a dispute, both sides receive the decision and the reasons for it.

### Our team

Only Rizq Rasan admins see account and verification data, and only what their work needs. We review who has admin access every month.

### Service providers

We share with each outside service only what it needs. These are the providers we plan to use. We will confirm the list before launch and keep it up to date.

| Service | Provider | What it receives |
| --- | --- | --- |
| Database, sign-in and file storage | Supabase | All platform data, stored in its Singapore region (to be confirmed before launch) |
| Hosting and bot check | Cloudflare | Your IP address and browser details when you use the platform |
| Payments | PayFast, licensed by the State Bank of Pakistan | What you enter on its payment page, the amount, and the vendor details it needs to process payments for that vendor |
| Vendor payouts | Our bank | The vendor's account title, IBAN and the amount |
| Email | Resend | Your email address and the message |
| WhatsApp messages | Meta's WhatsApp Business Platform | Your mobile number and the message |
| Maps and address search | Google Maps | The addresses and map positions searched or shown |
| Sign in with Google | Google | Only if you choose to use it |
| Error reports | Sentry | Technical details of an error, which can include an IP address |
| Product analytics | PostHog | How the platform is used, only if you agree, with anything typed into forms hidden |

Until Meta approves our WhatsApp business account, our team sends the urgent WhatsApp messages by hand from a WhatsApp Business number. The platform sends no text messages at launch. If we add sign-in codes by text message later, we will name the provider here first.

### Authorities

We share personal data with authorities only when the law requires it, or when someone may come to harm: for example, tax statements and records for the Federal Board of Revenue, details of a food incident for the Islamabad Food Authority, and information that a court or investigators under PECA lawfully request. We share only what the request covers.

### We never sell your data

We don't sell personal data, and we don't share it for advertising. If another company takes over Rizq Rasan, your data would pass to it under this policy, and we would tell you first.

## 6. Data stored outside Pakistan

This website is hosted by GitHub and its font comes from Google, both outside Pakistan. The platform's database is planned for Supabase's Singapore region, and most of our other providers also process data outside Pakistan.

We found no law in force that stops a private company from storing data abroad. A Pakistani lawyer will confirm this before launch. To protect data held abroad, we:

- choose providers that encrypt stored data and agree to data protection terms;
- keep our data in a form we can move, so we are not tied to one provider or country;
- will move data to servers in Pakistan if the Personal Data Protection Bill becomes law and requires this for "critical" personal data.

## 7. How long we keep it

We keep data only as long as we need it or the law requires. The main periods are:

| Data | How long we keep it |
| --- | --- |
| Verification documents and payment records | The life of the account plus 6 years. Section 174 of the Income Tax Ordinance 2001 requires tax records to be kept |
| Logs | 12 months |
| Your phone's live location | Not stored |
| Backups | Daily backups are kept for 7 days. Deleted data can stay in a backup until that backup is replaced |

The full schedule, and how to ask for deletion, are in our [Data Retention]({{ '/legal/data-retention/' | relative_url }}) policy. If you ask us to delete data the law makes us keep, we restrict it instead: we lock it away, use it only for that legal purpose, and delete it when the period ends.

## 8. How we protect it

- Every connection is encrypted. From launch, documents, CNIC numbers and bank account numbers will also be encrypted when stored, and CNICs and bank numbers will be shown masked.
- Documents sit in private storage and open only through 5-minute links. From launch, every view will be logged.
- Access rules inside the database cover every table, so one organisation cannot see another's data even if a screen has a fault.
- From launch, admins will sign in with an authenticator app. Payout batches and refunds above Rs 10,000 need a second admin, and an audit log that nobody can edit or delete records every admin action and money movement.
- We keep daily backups and a nightly encrypted copy elsewhere, test restoring them every quarter, and never copy real data into test systems.

Food photos are stored so they load quickly, which means anyone with a photo's exact link could open it. That is one more reason photos must show only food. No system is perfectly secure. Our [Security and Responsible Disclosure]({{ '/legal/security/' | relative_url }}) policy explains how to report a weakness.

## 9. If there is a data breach

If a breach puts your personal data at risk, we will tell you within 72 hours of confirming it: what happened, which data was affected, what we are doing and what you can do. Once Pakistan has a data protection regulator, we will tell it within the same time. We know of no law that requires this of us today, subject to legal review, but we commit to it because the draft Personal Data Protection Bill sets this standard.

## 10. Your rights

You can ask us to:

- **show you** the personal data we hold about you, and give you a copy;
- **correct** anything wrong or out of date. A change to verified details may need a new document;
- **delete** your data. We delete what we can and restrict what the law makes us keep (section 7);
- **stop using it** where you gave consent, such as for location, optional emails or analytics;
- **stop a use based on legitimate interest**, including any marketing, unless we need it to keep the platform safe or to meet the law, in which case we explain why;
- **hear a complaint** through our grievance officer (section 13).

To use a right, email {{ site.contact.email }} with "Privacy request" in the subject line, from the address on your account if you have one. You can also correct your name and mobile number in My account. From launch, you will also be able to delete your personal account there. We may ask you to confirm who you are first. We reply within 30 days, and if we can't do all you asked, we explain why. Requests about an organisation's data must come from its owner or a signatory.

## 11. Children

Rizq Rasan is for organisations, and everyone who uses the platform must be 18 or over. We don't knowingly collect personal data about children. If we learn that a child has sent us their details through this website, we will delete them. The people NGOs serve may include children, which is one reason we never collect details of beneficiaries and photos must not show them.

## 12. Changes to this policy

We will email account holders about material changes at least 14 days before they take effect, and show the new version number and effective date at the top of this page. If the law or a safety risk requires a change sooner, we will tell you as soon as we can. If you only use this website, please check this page from time to time.

## 13. Contact and grievance officer

{% if site.company.grievance_officer != "" %}Our grievance officer is {{ site.company.grievance_officer }}, who handles privacy requests and complaints.{% else %}We will name our grievance officer here before launch. Until then, our founders handle privacy requests and complaints.{% endif %} Email {{ site.contact.email }}. We reply {{ site.contact.reply_time }}, {{ site.contact.hours }}.{% if site.contact.whatsapp != "" %} You can also message us on WhatsApp at {{ site.contact.whatsapp }}.{% endif %} You can also write to us through our [contact page]({{ '/contact/' | relative_url }}).

Complaints are acknowledged within 1 working day and resolved within 5 working days, as our [Complaints and Disputes]({{ '/legal/complaints/' | relative_url }}) policy explains. Requests to use your rights are answered within 30 days. If the Personal Data Protection Bill becomes law and creates a regulator, you will also be able to complain to it, and we will add its details here.
