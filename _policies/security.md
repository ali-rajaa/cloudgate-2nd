---
title: Security and Responsible Disclosure
order: 14
description: How Rizq Rasan protects this website and the planned platform, and how to report a security flaw to us safely and in good faith.
version: "0.1 (draft)"
effective: from launch (22 March 2027)
summary:
  - This website has no log in, no payments and no cookies, so it holds very little to protect.
  - From launch, the platform will enforce access rules inside the database, require an authenticator app for our admins and log every document view.
  - Found a flaw? Email us with "Security" in the subject line, and we aim to acknowledge it within 1 working day.
  - If you research in good faith and follow this policy, we will not take legal action against you.
  - If a breach affects your data, we will tell you within 72 hours of confirming it.
---
This policy explains how we protect Rizq Rasan and the information organisations trust us with, and how to tell us about a security weakness. It covers this website today and the platform that verified businesses and NGOs will use from launch.

## 1. This website today

This website is a set of plain pages hosted on GitHub Pages. It has no log in, no accounts, no payments and no database of visitors, and it sets no cookies. The forms send your details to us by email or, once we connect a form service, through that provider. Nothing you type into them is stored on this website.

## 2. How the platform will protect your data

The platform is being built so that a mistake on one screen cannot expose another organisation's data or move money. These protections are planned for launch.

### Access to data

- **Rules inside the database.** Every table has access rules enforced by the database itself (row-level security), written and tested by hand for every role. Your browser can read only what your organisation may see, and can never change a claim, payment or approval by writing to a table directly.
- **Money and timers on our servers.** Payment logic, payment deadlines and timers never run in your browser, so nobody can fake a payment or skip a timer.
- **Addresses.** An NGO's address is used only to work out distance and is never shown to vendors. An NGO sees a vendor's exact address and phone number only after its payment is confirmed.
- **Encrypted connections.** Every connection to the platform is encrypted.

### Documents and personal details

- Verification documents are kept in private storage. Our admins open them only through links that expire after 5 minutes, and every view is logged.
- CNIC numbers are encrypted, shown masked (61101-XXXXXXX-1) and visible only to our admins. Payout bank account numbers are encrypted too.
- Pickup codes are encrypted, and collector pass links are stored only in a scrambled (hashed) form. Five wrong codes within 10 minutes lock code entry for 10 minutes.
- Photos are shrunk on the phone before upload, which also removes location data.

### Payments

- NGOs pay on PayFast's own page or in their bank's app. We never receive or store card numbers, or bank or wallet login details.
- Only a signed message from the gateway, checked again with the gateway, can mark an order as paid. Each message is recorded once, so a repeat cannot pay twice, and the amount always comes from our records, never from the browser.
- Every money movement is a ledger entry that is never edited, only reversed. Every payout batch, and every refund above Rs 10,000, needs a second admin's approval.
- If a vendor changes its payout bank account, payouts pause for 48 hours and the owner is told by email.

### Our team and our systems

- Our admins sign in with a password and a code from an authenticator app. Admin accounts are reviewed every month.
- Every admin action and every money movement is written to an audit log that nobody can edit or delete.
- Sign-up, sign-in and password reset include a bot check. We email you about a new sign-in, or when your password changes.
- Payment and email keys stay on our servers and are changed whenever a team member leaves.
- The live platform changes only through reviewed, tested releases with a manual approval step. Real data is never copied into test systems.
- Backups are taken daily and kept for 7 days, plus an encrypted copy every night kept off-site. We practise restoring them every quarter.
- The document links will be security tested before launch.

## 3. Keeping your account safe

- Everyone who acts for your organisation should use their own login, and keep it private.
- Send collector passes and pickup codes only to your own collectors.
- We will never ask for your password, or for your card, bank or wallet login details, by email, phone or WhatsApp. Treat any message that does as fake, and report it to us.
- Tell us at once if you think someone else has used your account.

## 4. If there is a data breach

If a breach puts your personal data at risk, we will tell you within 72 hours of confirming it, the standard the draft Personal Data Protection Bill (May 2023) sets. We will say what happened, what information was involved, what we are doing about it and what you can do to protect yourself. Our [Privacy Policy]({{ '/legal/privacy/' | relative_url }}) explains this commitment.

## 5. How to report a security flaw

Until we set up a dedicated security address, email {{ site.contact.email }} and start the subject line with "Security". Please include:

- what the problem is, and the page address or screen where you found it;
- the steps to reproduce it;
- what someone could do by exploiting it;
- any screenshots or test code that show it;
- how we can contact you.

Please describe any personal data you came across instead of copying it into your report.

What happens next:

- We aim to acknowledge your report {{ site.contact.reply_time }}.
- We look into it, tell you whether we can reproduce it, and keep you updated until it is fixed.
- If you want to publish your findings, we will agree a date with you once the problem is fixed.

We don't pay rewards for reports at this stage. There is no bug bounty programme.

## 6. Safe harbour for good-faith research

If you look for and report a flaw in good faith and follow this policy, we will treat your research as authorised. We will not take legal action against you, or ask the authorities to act against you, because of it. If someone else takes action against you over research that followed this policy, we will make it known that we authorised it.

Good faith means that you:

- test only this website or, from launch, accounts that you own or that we have given you for testing;
- don't access, change, delete or keep other people's data beyond the minimum needed to show the flaw, and stop and tell us at once if you reach personal data;
- don't disrupt the service, or interfere with real listings, orders, payments, payouts or pickups;
- don't ask for money or anything else in return for the details;
- keep the flaw between you and us until it is fixed or we have agreed a date with you;
- otherwise act within Pakistani law.

This wording will be reviewed by a Pakistani lawyer before launch. It covers only Rizq Rasan's own systems, and cannot authorise testing of anyone else's.

## 7. What's out of scope

Please don't try any of the following. They are not covered by section 6:

- social engineering or phishing of our team, vendors, NGOs, their staff or collectors;
- denial-of-service attacks, load tests or anything that floods the service, including sending spam through the forms;
- physical attempts to get into our offices or a vendor's premises;
- testing third-party services we use, such as PayFast, Google, GitHub, Cloudflare, our database and email providers, or WhatsApp. Report flaws in those to the company concerned. If you think we have set one of them up wrongly, tell us.

We also don't treat reports from automated scanners as security flaws unless they come with a working example of real harm.

## 8. Changes to this policy

When we set up a dedicated security address, we will publish it here. When we change this policy, we show the new version number and effective date at the top, and we tell account holders about material changes by email at least 14 days before they take effect.
