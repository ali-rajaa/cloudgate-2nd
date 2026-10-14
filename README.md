# Rizq Rasan

Rizq Rasan (رزق رسان) connects Islamabad's food businesses that have good surplus food with verified NGOs that feed people.

This repository holds two things:

- **The public website** (Jekyll, deployed to GitHub Pages): marketing pages, 16 policies, and "register your interest" forms.
- **The platform** at `/app/`: accounts for businesses, NGOs and admins, listing and claiming food, payments, pickups and payouts. The screens are static files on the same site; the data, rules and timers live in [Supabase](https://supabase.com) (`supabase/`). Until a Supabase project is connected, `/app/` says accounts open at launch.

## What's in it

- **13 main pages.** The marketing pages are Home, How it works, For businesses, For NGOs, Pricing, Impact, The problem, About, Food safety, Partners, FAQ and Contact. There is also Join, which picks the right sign-up form.
- **Policies.** There is a hub at `/legal/` and 16 policy pages in `_policies/`, including Terms, Privacy, the Vendor and NGO agreements, Payments and refunds, and Food safety. All of them are marked as drafts until a Pakistani lawyer has reviewed them.
- **Error and SEO files.** There is a 404 page, plus `sitemap.xml` and `robots.txt`.

| Folder / file | What it holds |
| --- | --- |
| `_config.yml` | Site name, contact details, company details, and switches such as `impact.published` and `nust_credit` |
| `_data/` | Navigation, footer columns, FAQ, step lists, sourced statistics and the five UN goals (SDGs) |
| `_includes/` | Reusable parts: header, footer, forms, calculator, example listing card, FAQ list and icons |
| `_layouts/` | `default`, `page` (marketing pages) and `policy` (legal pages with an "On this page" list) |
| `_policies/` | One Markdown file per policy |
| `assets/css/main.scss` | The design system: colour tokens with dark mode, type scale, components, and the reduced-motion and contrast settings |
| `assets/js/site.js` | All behaviour, with no libraries (see below) |

## Run it locally

You need Ruby 3.1 or newer.

```sh
bundle install
bundle exec jekyll serve
```

Then open http://localhost:4000.

## Publish on GitHub Pages

1. In the repository, go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**. Don't choose "Deploy from a branch": GitHub's built-in Jekyll is older and can't compile this stylesheet.
2. Every push to `main` builds the site, checks every internal link (`scripts/check-links.py`) and deploys it through `.github/workflows/pages.yml`. To redeploy without a change, open the **Actions** tab, choose **Build and deploy site**, and click **Run workflow**.

   If Pages is switched off, the run still builds and checks the site and stays green, but skips the deploy. It shows a warning, "Site built but not deployed", with these same steps. Turn Pages on as in step 1, then run the workflow again.
3. **Custom domain** (for example `rizqrasan.pk`):
   - add the domain under Settings → Pages;
   - set `url: "https://rizqrasan.pk"` in `_config.yml`;
   - leave `baseurl` empty.

   Without a custom domain the site lives at `https://ali-rajaa.github.io/cloudgate-2nd/`. The workflow sets the base path for you.

## Before launch: placeholders to fill in

Everything below lives in `_config.yml` unless noted. The site already hides or softens anything that is still empty.

- [ ] `contact.email`: confirm the domain and mailbox (currently `hello@rizqrasan.pk`).
- [ ] `contact.whatsapp`: add the number. It stays hidden while empty.
- [ ] `company.*`:
  - SECP registration number, NTN, registered office and grievance officer, once the company is incorporated;
  - replace `company.status` at the same time.
- [ ] `forms.endpoint`: GitHub Pages can't receive form posts.
  - Create a form at a service such as Formspree or Getform and paste its URL here.
  - Until then, each form opens the visitor's email app with their details filled in.
- [ ] `social.*`: add profiles when they exist. Each one appears in the footer once set.
- [ ] `impact.published`: switch to `true`, and fill in the numbers, only once real data has been published after the pilot.
- [ ] `nust_credit`: switch to `true` only after NUST gives written permission.
- [ ] **Statistics** (`_data/stats.yml`):
  - re-check every figure on its source page before launch;
  - figures marked `home: true` are shown on Home.
- [ ] **Policies** (`_policies/`):
  - have a Pakistani lawyer review every policy;
  - then update `version` and `effective` in each file's front matter;
  - the draft notice comes from `_layouts/policy.html`, so remove it there.
- [ ] **Partners**: replace the placeholder slots on Home and `/partners/` with partners who have agreed in writing.
- [ ] **Photos**: the example listing uses a drawn placeholder. Swap in real Islamabad photos when you have them.
- [ ] **Name check**: check the "Rizq Rasan" name with a lawyer before printing anything.
- [ ] **Urdu**: the six main pages should be translated by a person before an Urdu version is added. Keep `urdu_enabled: false` until then.

Once the platform is connected (below), set `app_url: "/app/"` and a **Log in** link appears in the header and menu.

## The platform: connect Supabase

Everything the platform does is in `supabase/`:

| Path | What it is |
| --- | --- |
| `migrations/` | Tables, the rules for every action (claim, pay, pickup code, refunds, payouts), access rules for each role, file storage, and the timers that run every minute |
| `functions/payfast-checkout`, `functions/payfast-ipn` | PayFast payments: start a checkout, and receive PayFast's signed payment notification |
| `functions/send-notifications` | Emails new notifications through Resend |
| `tests/` | End-to-end tests run against a real Supabase (`flow.test.mjs` has 68 checks, `payfast.test.mjs` 9) |

### One-time setup (about 20 minutes)

1. **Create the project** at supabase.com: region **Singapore**, a strong database password (keep it safe).
2. **Connect the website.** In Supabase, open **Project Settings > API**. Copy the **Project URL** and the **anon public** key into `_config.yml`:
   ```yaml
   platform:
     supabase_url: "https://YOUR-REF.supabase.co"
     supabase_anon_key: "eyJ..."
   app_url: "/app/"
   ```
   Both are safe to publish: the database's access rules decide what each person can see.
3. **Let GitHub deploy the backend.** In this repository: **Settings > Secrets and variables > Actions > New repository secret**, add:
   - `SUPABASE_PROJECT_REF`: the part before `.supabase.co` in the Project URL
   - `SUPABASE_DB_PASSWORD`: the database password from step 1
   - `SUPABASE_ACCESS_TOKEN`: create one at supabase.com > Account > Access Tokens

   Then open **Actions > Backend > Run workflow**. It runs the tests, then creates every table, rule and function in your project.
4. **Sign-in settings.** In Supabase, open **Authentication > URL Configuration**. Set **Site URL** to `https://rizq.fixmypcperth.com/app/` and add the same address under **Redirect URLs**.
5. **Email that actually arrives.** Supabase's built-in email only sends a few messages an hour. Create a free [Resend](https://resend.com) account, verify a sending domain, then:
   - in Supabase, **Authentication > SMTP Settings**: host `smtp.resend.com`, port `465`, user `resend`, password = your Resend API key;
   - in **Edge Functions > Secrets**, add `RESEND_API_KEY`, `EMAIL_FROM` (for example `Rizq Rasan <alerts@mail.yourdomain.pk>`) and `APP_URL` (`https://rizq.fixmypcperth.com/app/`);
   - in the **SQL Editor**, run once so the scheduler can call the email function:
     ```sql
     select vault.create_secret('https://YOUR-REF.supabase.co', 'project_url');
     select vault.create_secret('YOUR-SERVICE-ROLE-KEY', 'service_role_key');
     ```
6. **Make yourself an admin.** Sign up at `/app/` with your own email, then in the SQL Editor:
   ```sql
   insert into public.platform_admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
   Add a second admin the same way: payout batches and refunds over Rs 10,000 need a different admin to approve them.

### Payments

The platform starts in **direct mode** (the pilot): the NGO pays the business by Raast or bank transfer, and the business confirms in the app. No money passes through Rizq Rasan, and no commission is charged.

When PayFast approves the merchant account:

1. In **Edge Functions > Secrets**, add `PAYFAST_MERCHANT_ID`, `PAYFAST_SECURED_KEY`, `PAYFAST_MERCHANT_NAME`, and `PAYFAST_BASE_URL` (`https://ipguat.apps.net.pk` for PayFast's test server, `https://ipg1.apps.net.pk` for live).
2. Give PayFast this notification address: `https://YOUR-REF.supabase.co/functions/v1/payfast-ipn`.
3. Check the field names and the validation hash in `supabase/functions/_shared/payfast.ts` against the integration guide PayFast sends you, and make a test payment on their test server.
4. In the app, **Admin > Settings**, switch **payment mode** to `payfast`.

### Run the backend locally

With Docker running:

```sh
npx supabase start            # local database, sign-in, storage and functions
cd supabase/tests && npm ci
eval "$(npx supabase status -o env | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|API_URL)=')"
SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY node flow.test.mjs
```

To run the app against it, create `_config.local.yml` (not committed) with the local URL and anon key under `platform:`, then `bundle exec jekyll serve --config _config.yml,_config.local.yml`.

### Sign-in screens: behaviour and tests

The log in, sign up, forgot password and reset screens live in `assets/app/auth.js`. The checks they use are in `assets/app/validate.js`, plain functions with no page access.

- **Checking as you type.** A box is checked when you leave it. Once it shows a problem, it's checked again as you type, so errors appear late and clear early. Submitting checks everything and moves to the first problem.
- **Help in the boxes.** A "Did you mean name@gmail.com?" suggestion appears for slips in well-known addresses. A new password gets a strength meter, and the check refuses common passwords and your own name or email. There's a confirm box revealed by the same Show button, and a Caps Lock warning.
- **While waiting.** The button shows a spinner and ignores more presses. After 6 seconds a note says the connection seems slow; after 30 seconds the screen stops waiting and says so. Offline, too many attempts, wrong password and expired links each get a plain message.
- **Two kinds of account.** Sign up starts with "Food business" or "NGO or charity". The name label, the agreement and a short note change to match.

Every deploy runs two sets of tests before publishing (`.github/workflows/pages.yml`):

- `scripts/tests/validate.test.mjs`: unit tests for the checks.
- `scripts/tests/auth-ui.test.mjs`: Chromium tests against the built site with Supabase faked. They cover wrong password, slow network, offline, rate limits, unconfirmed email and resend, sign up, reset, keyboard order and layout from 320px to 1920px.

To run them yourself:

```sh
bundle exec jekyll build
cd scripts/tests && npm install && npx playwright install chromium
SITE_DIR=../../_site node --test
```

Check these by hand before launch, because a test browser can't do them:

- password-manager autofill on Chrome, Safari and Firefox (no yellow or blue box, values kept);
- a real sign up with email confirmation and the resend button;
- a password reset from the email link;
- VoiceOver on an iPhone and TalkBack on Android.

## How it's built

The look and feel follows Apple's interface guidelines, translated for the web:

- **Instant feedback.** Buttons react on press, not on release.
- **Interruptible motion.** The menu sheet, accordions and segmented control move on springs set by damping ratio and response. They can be caught or reversed mid-motion without jumping.
- **Direct manipulation.** On phones, the menu sheet follows your finger 1:1 when you drag it up, resists past its edge, and uses the speed of your release to decide whether to close.
- **Materials.**
  - The header and menu are translucent, with a fade at the scroll edge instead of a hard line.
  - The menu sheet drops from the top, next to the menu button, and leaves the same way.
- **Typography.** Fraunces for headings, with tracking and line height tuned per size. The system font is used for body text.
- **Accessibility.**
  - It respects reduced motion (movement becomes a fade or an instant change), reduced transparency, higher contrast, forced colours and dark mode.
  - Tap targets are 48 px and focus states are visible.
  - Forms have inline errors and an error summary.
- **Works without JavaScript.** Everything still reads and every link works; only the motion is lost.

## Editing content

- **FAQ:** edit `_data/faq.yml`. Mark exactly six questions with `home: true` for the Home page.
- **Footer links:** edit `_data/footer.yml`.
- **New policy:** add a Markdown file to `_policies/` with `title`, `order`, `description`, `version`, `effective` and a short `summary` list. It appears on `/legal/` automatically.
- **Writing rules:**
  - money as "Rs 1,200";
  - times as "10:30 pm";
  - sentence-case headings;
  - no dashes as punctuation;
  - the same verbs everywhere: List, Claim, Pay, Collect, Confirm, Report.
