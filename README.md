# Blackjw's Blog

Personal portfolio site for blackjw1212, built with Jekyll and the Minimal Mistakes theme.

## Focus

- Public portfolio articles
- Interface and dashboard projects
- Hardware-related project records
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
- Keep public pages focused on project outcomes instead of private implementation details.
- Every push runs a GitHub Actions site check that builds Jekyll and verifies internal links.
