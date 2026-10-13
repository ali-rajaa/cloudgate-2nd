# Rizq Rasan website

The public website for Rizq Rasan (رزق رسان), which connects Islamabad's food businesses that have good surplus food with verified NGOs that feed people.

This is a **static website only**. There is no app yet. Businesses and NGOs register their interest through forms, and accounts open at launch (22 March 2027). The site is built with [Jekyll](https://jekyllrb.com/) and deploys to GitHub Pages.

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

When the app is built later, set `app_url` and a **Log in** link appears in the header and menu.

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
