---
title: Legal Information
order: 16
description: The company behind Rizq Rasan, its registration status, registered office and tax number, its grievance officer, and how to contact us.
version: "0.1 (draft)"
effective: on publication
summary:
  - Rizq Rasan is being set up as a private limited company based in Islamabad.
  - Its SECP registration number, NTN and registered office appear on this page as soon as they are issued.
  - We take no payments until the company is incorporated and our payment gateway has approved it.
  - Complaints go to our grievance officer. They are acknowledged within 1 working day and resolved within 5 working days.
---
This page gives the legal details of the company that runs Rizq Rasan and how to reach it. We keep it up to date, so it is the place to check our details before you sign anything with us.

## 1. Company details

| Detail | Value |
| --- | --- |
| Company | {{ site.company.legal_name }} |
| Company type | Private limited company |
| Status | {{ site.company.status }} |
| SECP registration number | {{ site.company.secp_number | default: "Given here once the company is incorporated" }} |
| NTN | {{ site.company.ntn | default: "Given here once issued" }} |
| Registered office | {{ site.company.registered_office | default: "Given here once the company is incorporated" }} |
| Grievance officer | {{ site.company.grievance_officer | default: "Named here before launch" }} |
| Email | [{{ site.contact.email }}](mailto:{{ site.contact.email }}) |
| City | {{ site.contact.city }} |
| Office hours | {{ site.contact.hours }} |

In our policies, "we", "us" and "Rizq Rasan" mean {{ site.company.legal_name }}.

## 2. Where we are today

Current status: {{ site.company.status }}.{% if site.company.secp_number == "" %} We will add our SECP registration number, NTN and registered office to this page as soon as they are issued.{% endif %}

- **Contracts.** Agreements with vendors, NGOs and partners are signed only by the company, never by a team member personally.
- **Payments.** We take no payments until the company is incorporated and our payment gateway has approved its account. During the pilot planned for January 2027, NGOs pay vendors directly, we charge no commission, and Rizq Rasan is not involved in the payment.
- **Launch.** Public launch in Islamabad is planned for 22 March 2027. Until then, this website explains how the platform will work, and our forms only send your details to us.

## 3. Grievance officer and complaints

{% if site.company.grievance_officer != "" %}Our grievance officer is {{ site.company.grievance_officer }}. Send complaints to {{ site.contact.email }}.{% else %}We will name our grievance officer here before launch. Until then, send complaints to {{ site.contact.email }}.{% endif %}

- General complaints are acknowledged within 1 working day and resolved within 5 working days.
- Order disputes are acknowledged within 4 working hours and decided within 48 hours, or within 24 hours for food safety.
- If a dispute with us is not settled, either side can propose mediation under the Alternative Dispute Resolution Act 2017 before going to court. Pakistani law applies, and the courts at Islamabad decide disputes.

The full process is in our [Complaints and Disputes]({{ '/legal/complaints/' | relative_url }}) policy.

## 4. How to contact us

- **Email:** {{ site.contact.email }}. We reply {{ site.contact.reply_time }}, {{ site.contact.hours }}.{% if site.contact.whatsapp != "" %}
- **WhatsApp:** {{ site.contact.whatsapp }}.{% endif %}
- **Online:** our [contact page]({{ '/contact/' | relative_url }}) has a form for general questions, and our [partners page]({{ '/partners/' | relative_url }}) one for partnership requests.
- **Legal notices:** send them to {{ site.contact.email }}.{% if site.company.registered_office != "" %} You can also post them to our registered office at {{ site.company.registered_office }}.{% endif %}

## 5. Our name and brand

- The Rizq Rasan name, our Urdu name <span class="urdu" lang="ur" dir="rtl">{{ site.urdu_name }}</span> and our basket logo belong to {{ site.company.legal_name }}. Nobody may use them, or suggest that we endorse them, without our written permission.
- Rizq Rasan is an independent company. It is not part of any other charity or organisation with a similar name.
- We name partners on this website only once they have agreed in writing.
- We will never ask for your card, bank or wallet login details, or for cash at a pickup. If someone uses our name to ask for money or documents in a way that seems wrong, tell us at {{ site.contact.email }}.

## 6. Policies and versions

All our policies are listed on the [policies page]({{ '/legal/' | relative_url }}), each with its version number and effective date.

- Every policy stays a draft until a Pakistani lawyer has reviewed it before launch.
- The English text is binding. Any Urdu summary is there to help you understand it.
- From launch, we keep every version of every policy, and record which version each person accepted, in which language, when, and from which IP address.
- We email organisations about material changes at least 14 days before they take effect.
