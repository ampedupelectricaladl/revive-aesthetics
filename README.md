# Revive Aesthetics — Website

Boutique Adelaide skin studio. Static single-page site (plain HTML/CSS/JS, no build step).

- **Business:** Revive Aesthetics (Adelaide, SA)
- **Services:** Chemical peels · Microneedling · Skin consultations
- **Phone:** 0404 967 051
- **Email:** smatulin@yahoo.com
- **Palette:** aubergine `#2B0F1A` + cream `#F2E7CE` + gold `#c2a878` (from logo)

## Deploy
Served via **GitHub Pages** from the repo root (`index.html`). Push to `main` → live in ~1 min.

## To finish / add as content arrives
1. **Logo:** drop `logo-cream.png` (cream-on-dark) and `logo-plum.png` (dark-on-cream) into `assets/`,
   then swap the `<span class="monogram">RA</span>…` block in the nav for the `<img>` (comment is in `index.html`).
2. **Photos:** add `assets/about.jpg` (studio/portrait) and treatment images; swap the "coming soon" placeholders.
3. **Socials:** update the Instagram/Facebook `href="#"` links in the contact section.
4. **Contact form:** uses [FormSubmit](https://formsubmit.co) — the FIRST enquiry sends a one-time
   confirmation email to smatulin@yahoo.com; click the activation link once and the form is live forever.
5. **Custom domain:** when registered, add a `CNAME` file + point DNS (see Pages settings).
