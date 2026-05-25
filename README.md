# Blackjw's Blog

Personal technical blog and portfolio site for blackjw1212, built with Jekyll and the Minimal Mistakes theme.

## Focus

- HomeLab and Proxmox VE notes
- HomeKit/HomeSpan experiments
- Hackintosh and system customization documentation
- Taiwan tech/life observations
- Public resume and selected works

## Local development

```bash
bundle install
bundle exec jekyll serve
```

The site is published at <https://blackjw1212.github.io/>.

## Maintenance notes

- Keep navigation links backed by real pages.
- Do not commit local OS artifacts such as `.DS_Store`.
- Keep repo descriptions, profile links, and pinned projects aligned with the current portfolio focus.
- Every push runs a GitHub Actions site check that builds Jekyll and verifies internal links.
