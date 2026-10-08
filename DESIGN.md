---
name: Ponnicup
description: The familiar green, paper and gold football clubhouse, extended across the Champions League season.
colors:
  ink: "#152a22"
  field: "#14583e"
  field-deep: "#0a372a"
  paper: "#f4f4ec"
  panel: "#fffefa"
  panel-strong: "#eaf0e8"
  line: "#d4dcd2"
  muted: "#59685e"
  gold: "#edc04f"
  red: "#a33125"
  odds-label: "#526b49"
  ranking-loss: "#607153"
  pending-copy: "#715818"
typography:
  display:
    fontFamily: '"Avenir Next", "Gill Sans", "Trebuchet MS", "Segoe UI", sans-serif'
    fontSize: "34px"
    fontWeight: 800
    lineHeight: 1.16
    letterSpacing: "-0.035em"
  headline:
    fontSize: "21px"
    fontWeight: 750
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontSize: "16px"
    fontWeight: 750
    lineHeight: 1.35
  body:
    fontFamily: '"Avenir Next", "Gill Sans", "Trebuchet MS", "Segoe UI", sans-serif'
    fontSize: "15px"
    lineHeight: 1.5
  label:
    fontSize: "13px"
    fontWeight: 650
rounded:
  status: "3px"
  odds: "6px"
  field: "7px"
  button: "8px"
  board: "12px"
  dialog: "15px"
spacing:
  compact: "8px"
  control: "12px"
  card: "16px"
  section: "24px"
  desktop-gutter: "36px"
components:
  button-primary:
    textColor: "{colors.panel}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.field}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-gold:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.field-deep}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  navigation:
    backgroundColor: "{colors.field-deep}"
    rounded: "{rounded.board}"
  filter:
    textColor: "{colors.muted}"
  odds:
    textColor: "{colors.field}"
    rounded: "{rounded.odds}"
    padding: "9px 11px"
  fixture-card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.board}"
---

# Design System: Ponnicup

## Overview

**Creative North Star: "The Ponnicup clubhouse"**

The Champions League edition continues Ponnicup's established green, paper and gold sports identity. Existing trophy artwork is reused from the World Cup edition. Dark pitch-green chrome surrounds warm paper content; compact fixtures and restrained pitch-inspired diagonals keep the football character familiar.

The shared implementation is in `src/styles.css`. This document records the built interface, including its explicit saved and pending selections. The review captures in `.impeccable/review/` show the desktop round, mobile round and 320px user view; their fixture content is review data, not a product default.

**Key Characteristics:**

- Evergreen chrome and warm paper playing surfaces.
- Gold for bonuses, rank and the reviewed betting action.
- Compact, readable fixtures with text-backed status and selection states.
- Familiar Finnish game vocabulary and reused trophy artwork.

## Colors

### Primary

Field green carries actionable text and selected odds. Deep field green anchors the header, navigation, wallet and floating slip. Paper text stays readable on these dark surfaces.

### Secondary

Gold marks bonuses, ranking emphasis and the review action. Red is reserved for missing picks, errors, loss outcomes and destructive actions. The missing-pick badge adds a small angle to its pale red background.

### Neutral

Paper is the page background; panel is the brighter fixture, form and dialog surface. Panel strong supports hover and secondary emphasis. Ink and muted green-gray establish text hierarchy, with pale green borders separating dense information.

The odds-label token is the unselected `1`, `X` and `2` text color. Ranking-loss is the subdued loss count beside the win count in the desktop leaderboard. Pending-copy identifies an unsubmitted selection and its explanatory note. Their exact implemented values are in the frontmatter; do not lighten them for decorative subtlety.

## Typography

Use the incumbent Avenir Next / Gill Sans / Trebuchet MS / Segoe UI sans-serif stack. No external font is needed. Numerals are tabular throughout.

Page headings use the display role and become 29px on screens at or below 600px. Section and card titles use weight rather than a second typeface. The base body size becomes 14px on mobile; mobile form fields use 16px. Fixture names increase from 13px to 14px, and odds from 14px to 16px, on mobile. Compact metadata remains secondary but retains text equivalents for every state.

## Layout

The desktop shell has a sticky 78px header and a centered 1360px container, with 36px outer gutters, a 184px navigation column and a 40px content gap. Fixture groups use two columns with a 15px gap. At 1600px and above, the shell expands to 1420px; at 1150px and below, its columns and gutters tighten.

At 900px and below, navigation moves to a fixed bottom bar and the header becomes 70px tall. At 600px and below, content has 16px gutters, fixtures become one column, and the four-part wallet becomes a two-by-two summary. The layout supports a minimum viewport width of 320px. Date headings and the round selector can wrap.

At the mobile breakpoint, text actions, round filters, optional-market choices and the slip action have a minimum height of 44px; close and clear controls retain a 44px minimum width and height. Main 1X2 choices and regular form controls are 46px tall or taller. Bottom navigation entries are at least 54px tall. Preserve these targets when changing density.

The floating selection summary sits above bottom navigation with safe-area spacing. Mobile dialogs attach to the bottom; desktop dialogs are centered with a maximum width of 480px. Tables scroll within their labeled region. Player rankings simplify to name and total on mobile, with the separate win/loss column hidden.

## Elevation & Depth

Most content uses flat paper surfaces, restrained borders and pale green fills. The header has a light shadow, while the floating slip and modal have stronger shadows that distinguish their position above the page. Keep fixture cards flat. The primary button's shallow green gradient is part of the incumbent system.

Button color transitions last 150ms with ease-out. The floating slip uses a brief 180ms reveal. Respect the implementation's reduced-motion override; no decorative data entrance is required. Full shadow and motion values are recorded in `.impeccable/design.json`.

## Shapes

Use gently rounded controls and boards: 6px odds, 7px fields and navigation items, 8px buttons, and 12px fixture cards and wallet surfaces. Desktop dialogs use 15px corners; mobile dialogs have 17px upper corners and square lower corners. Status labels use small 3px corners. The missing-pick label alone tilts by −3 degrees.

## Components

- **Buttons and fields:** Confident and compact. Primary actions use a dark green gradient, secondary actions use paper and a border, and review uses gold. Regular buttons and fields have a 46px minimum height. Keyboard focus uses a 3px ochre outline with a 3px offset. Labels, constraints, hover and disabled states remain visible; touch and keyboard access share the same controls.
- **Navigation and filters:** Desktop navigation selects a warm paper row inside green chrome. Bottom navigation selects with gold icon/text and a subtle pale fill. Round filters use a pale green group with a raised paper selected segment and a count badge. Preserve pressed, selected and current semantics.
- **Fixture board:** Kickoff/status, club identity, three 1X2 prices, own bet, submission count and optional-market disclosure appear in that order. Team crests are decorative beside names and fall back to a neutral shield. Selected odds use field green, pale text and a checkmark.
- **Saved and pending picks:** An unsubmitted pick shows `Odottaa jättämistä` in the status and `Valittu: … · odottaa jättämistä` below the odds. When editing a saved pick, retain the `Jätetty:` row and its existing stake, then show a separate `Uusi valinta:` row. The note reads `Jätetty veto pysyy voimassa, kunnes jätät muutoksen.` The selected button represents the pending choice; it must not imply that the server has saved it. Only a confirmed saved state uses `Jätetty` and its status checkmark.
- **Locked and unavailable markets:** Locked markets disable changes and expose the group's submitted bets. Unknown odds show `Kertoimet tulossa` and cannot be selected. Status colors always have text counterparts.
- **Reviewed slip:** The floating summary leads to a protected-focus dialog with an explicit close control, Escape support, focus restoration and scroll containment. The dialog shows selections, stakes, funding and the final action together.
- **Tables and operational surfaces:** Use semantic standings tables, list-based player rankings, clear empty states and expandable admin tools. Network failures expose retry; retained data has an explicit stale notice and betting remains disabled until refresh succeeds. Provider identifiers stay in operational views where they help a decision.

## Do's and Don'ts

- Do preserve the evergreen, paper and gold identity and existing trophy artwork.
- Do keep saved bets and pending changes visibly separate until the server confirms submission.
- Do preserve mobile control targets and visible keyboard focus.
- Do use Finnish labels such as `Kierros`, `Pörssi`, `Maalipörssi`, `Kunnia`, `Oma pelikassa`, `Oma panos avoinna`, `Päiväbonus`, `Puuttuu`, `Jätetty`, `Lukittu` and `Palautettu`.
- Don't introduce casino gloss, generic SaaS cards or decorative analytics.
- Don't convey selection, failure, lock or settlement through color alone.
- Don't fill missing data with invented fixtures, prices, results or balances.
