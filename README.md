# HN Lens

A static GitHub Pages app that turns a Hacker News item URL into a calmer reader view.

Paste a URL like:

```text
https://news.ycombinator.com/item?id=48537641
```

The page fetches the story and comments from the public Hacker News Firebase API, sanitizes comment HTML, and renders the discussion with light and dark modes.

## Deploy

This repo does not need a build step. Enable GitHub Pages for the branch and serve from the repository root.
