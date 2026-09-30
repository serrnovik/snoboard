---
id: snoboard-002
title: Edit from the board (basket, push or PR)
status: in-progress
priority: p0
depends_on: [snoboard-001]
updated: 2026-10-01
labels: [demo]
---

# Edit from the board (basket, push or PR)

## Summary

Change status by drag and drop, edit titles, fields and text in the browser. Edits wait in a local basket and are committed as one push to the default branch or as a pull request.

## Goals

- Basket kept in localStorage, with pending badges
- Drag and drop between columns
- Push to main by default, pull request as an option; the choice is remembered
