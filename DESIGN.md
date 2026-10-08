---
name: Pönnicup
description: Pönnicup is a Finnish Champions League game using midnight blue, white and silver.
colors:
  ink: "oklch(0.2602 0.0477 259.93)"
  midnight: "oklch(0.2005 0.0557 261.22)"
  action: "oklch(0.4049 0.1326 259.76)"
  canvas: "oklch(0.9723 0.0074 260.73)"
  panel: "oklch(1.0000 0.0000 0.00)"
  panel-strong: "oklch(0.9473 0.0108 256.70)"
  line: "oklch(0.8673 0.0217 259.19)"
  line-soft: "oklch(0.9260 0.0138 258.35)"
  control-line: "oklch(0.6523 0.0404 258.37)"
  muted: "oklch(0.4930 0.0428 259.72)"
  muted-icon: "oklch(0.5487 0.0417 259.75)"
  silver: "oklch(0.8892 0.0198 260.17)"
  silver-light: "oklch(0.9442 0.0137 258.35)"
  on-dark-secondary: "oklch(0.8479 0.0253 257.65)"
  on-dark-muted: "oklch(0.7939 0.0354 257.86)"
  focus: "oklch(0.5678 0.1665 260.85)"
  info: "oklch(0.3731 0.1051 258.32)"
  info-surface: "oklch(0.9564 0.0178 261.34)"
  info-line: "oklch(0.8403 0.0456 258.76)"
  red: "oklch(0.4797 0.1556 20.96)"
  error-surface: "oklch(0.9607 0.0154 7.49)"
  error-line: "oklch(0.7926 0.0602 10.64)"
  error-strong: "oklch(0.4151 0.1300 19.82)"
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
  form-result-mark:
    fontSize: "8px"
  compact-status:
    fontSize: "9px"
  metadata:
    fontSize: "10px"
  supporting-label:
    fontSize: "11px"
  control-label:
    fontSize: "12px"
  button-label:
    fontSize: "14px"
  mobile-section-title:
    fontSize: "17px"
  fixture-day-title:
    fontSize: "18px"
  panel-title:
    fontSize: "19px"
  admin-section-title:
    fontSize: "20px"
  wallet-value:
    fontSize: "22px"
  mobile-statistic:
    fontSize: "23px"
  compact-brand:
    fontSize: "24px"
  input-value:
    fontSize: "25px"
  narrow-round-title:
    fontSize: "26px"
  mobile-brand:
    fontSize: "27px"
  mobile-display:
    fontSize: "29px"
  mobile-login-title:
    fontSize: "31px"
  brand:
    fontSize: "32px"
  login-title:
    fontSize: "33px"
rounded:
  legend: "2px"
  badge: "4px"
  segmented-control: "5px"
  table: "10px"
  status: "3px"
  odds: "6px"
  field: "7px"
  button: "8px"
  board: "12px"
  auth: "14px"
  dialog: "15px"
  mobile-dialog: "17px"
spacing:
  compact: "8px"
  control: "12px"
  card: "16px"
  section: "24px"
  desktop-gutter: "36px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.panel}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.action}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-silver:
    backgroundColor: "{colors.silver}"
    textColor: "{colors.midnight}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  navigation:
    backgroundColor: "{colors.midnight}"
    textColor: "{colors.on-dark-secondary}"
    rounded: "{rounded.board}"
  filter:
    backgroundColor: "{colors.panel-strong}"
    textColor: "{colors.muted}"
    rounded: "{rounded.button}"
  odds:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.action}"
    rounded: "{rounded.odds}"
    padding: "9px 11px"
  fixture-card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.board}"
---

# Design System: Pönnicup

## Overview

**Identity: Pönnicup · Champions League**

The app title is Pönnicup and the competition is exclusively the Champions League. The official UEFA Champions League logo appears beside the title. Midnight blue chrome frames white fixtures and forms, with restrained silver emphasis. Copy uses plain, factual Finnish without promotional slogans. Compact gameplay, system typography and the established interaction structure remain intact.

The shared implementation is in `src/styles.css`, with the brand lockup in `src/App.tsx` and page metadata in `index.html`. This document records the identity and its explicit saved and pending selections. The earlier palette review and `champions-*.jpg` screenshots in `.impeccable/review/` predate the Pönnicup title, official logo and slogan removal; they are historical evidence, not a review of this correction. Their fixtures, prices, balances and results are synthetic QA data and do not establish production game data or deployment state.

**Key Characteristics:**

- Midnight blue chrome, white content surfaces and a cool near-white canvas.
- Restrained silver for the review action, active navigation and emphasis on dark surfaces.
- Compact fixtures with text-backed status and selection states.
- A single-line Pönnicup title beside the official UEFA Champions League logo.
- Plain, factual Finnish game vocabulary and preserved mobile control targets.

## Colors

### Primary

Midnight anchors the header, navigation, login background, wallet and floating slip. Action blue carries primary buttons, links, selected odds and active player choices. White text remains legible on both dark colors. Focus blue outlines controls on light surfaces; silver outlines focus within the header, navigation and floating slip.

### Secondary

Silver marks the review action and selected emphasis within dark surfaces. Silver light gives the current navigation destination its pale fill on desktop and mobile. Supporting text on midnight uses the dedicated on-dark-secondary and on-dark-muted roles; do not substitute the darker muted text intended for white surfaces.

### Neutral

Canvas is the cool near-white page background; panel is pure white for fixtures, fields and dialogs. Panel strong supports hover, filters and secondary emphasis. Ink and muted blue-gray establish text hierarchy. Line and line soft separate dense information; the stronger control line defines actionable fields and odds. Muted icon is reserved for subdued iconography.

The unselected `1`, `X` and `2` labels, pending-pick note and subdued ranking count use the shared muted token. Info, info surface and info line provide text-backed informational and submitted states. Red, error surface, error line and error strong communicate missing picks, errors, losses and destructive actions. State text and symbols remain present alongside color. Exact CSS-native OKLCH values are in the frontmatter.

## Typography

Use the preserved Avenir Next / Gill Sans / Trebuchet MS / Segoe UI system sans-serif stack. No external font is needed. Numerals are tabular throughout. The frontmatter includes the full implemented size inventory: compact result marks and metadata, controls, component titles, numeric inputs, responsive headings and brand variants. These component-specific roles document the current interface; they are not interchangeable steps for body text.

Page headings use the display role and become 29px on screens at or below 600px; the round heading becomes 26px at or below 360px. Section and card titles use weight rather than a second typeface. The base body size becomes 14px on mobile; mobile form fields use 16px. Fixture names increase from 13px to 14px, and odds from 14px to 16px, on mobile. Compact metadata remains secondary but retains text equivalents for every state.

The Pönnicup title stays on one line. The full login lockup uses 32px type, an 80×82px logo container and an 11px season label; the compact header uses 24px type and a 54×56px logo container without a subtitle. At or below 600px, the compact title becomes 22px with a 44×46px logo container and the full login title becomes 27px. The logo uses `object-fit: contain` to preserve its original proportions.

## Layout

The desktop shell has a sticky 78px header and a centered 1360px container, with 36px outer gutters, a 184px navigation column and a 40px content gap. Fixture groups use two columns with a 15px gap. At 1600px and above, the shell expands to 1420px with a 200px navigation column and 48px gap. At 1150px and below, gutters and gap become 25px and the navigation column becomes 160px.

At 900px and below, navigation moves to a fixed bottom bar and the header becomes 70px tall. At 600px and below, content has 16px gutters, fixtures become one column with a 14px gap, and the four-part wallet becomes a two-by-two summary. At 360px and below, content gutters become 12px. The layout supports a minimum viewport width of 320px. Date headings and the round selector can wrap.

At the mobile breakpoint, text actions, round filters, optional-market choices and the slip action have a minimum height of 44px; close and clear controls retain a 44px minimum width and height. Main 1X2 choices and regular form controls are 46px tall or taller. Bottom navigation entries are at least 54px tall. Preserve these targets when changing density.

The floating selection summary sits above bottom navigation with safe-area spacing. Mobile dialogs attach to the bottom; desktop dialogs are centered with a maximum width of 480px. The login panel has a maximum width of 460px. Tables scroll within their labeled region. Player rankings simplify to name and total on mobile, with the separate win/loss column hidden.

## Elevation & Depth

Most content uses flat white surfaces, restrained cool borders and pale blue-gray fills. The header has a light shadow, while the floating slip, login panel and modal have stronger midnight-tinted shadows. The modal backdrop uses a translucent midnight scrim. Keep fixture cards flat and primary actions solid blue. A small shadow distinguishes the selected filter segment.

Button color transitions last 150ms with ease-out. The floating slip uses a brief 180ms reveal. Respect the implementation's reduced-motion override; no decorative data entrance is required. Full shadow and motion values are recorded in `.impeccable/design.json`.

## Shapes

Qualification legend markers, small badges, segmented controls and table containers use the smaller shape roles recorded in the frontmatter. Use gently rounded controls and boards: 6px odds, 7px fields and desktop navigation items, 8px buttons, and 12px fixture cards and wallet surfaces. The login panel uses 14px corners. Desktop dialogs use 15px corners; mobile dialogs have 17px upper corners and square lower corners. Status labels use small 3px corners and remain level. Preserve the geometry and proportions of the official UEFA logo.

## Components

- **Brand and assets:** The app masthead reads `Pönnicup`, beside the official UEFA Champions League logo. The full login lockup includes only the factual season label `2026–27`; the header has no brand subtitle. `public/champions-league.svg` is the unchanged 441×419 SVG from [UEFA’s official asset](https://img.uefa.com/imgml/uefacom/ucl/2024/logos/logo_dark.svg). It replaces the earlier code-authored star. `public/apple-touch-icon.png` at 180×180, `public/champions-league-192.png` at 192×192 and `public/champions-league-512.png` at 512×512 are derived from that SVG with Sharp: preserve the white logo using `fit: 'contain'`, center it on midnight blue, and reserve 16% padding at each edge. Regenerate raster variants from the official SVG source. Do not redraw or distort the logo. The former trophy asset remains removed.
- **Buttons and fields:** Confident and compact. Primary actions use solid action blue, secondary actions use white and a control-line border, and review uses silver. Regular buttons and fields have a 46px minimum height. Primary hover becomes midnight; secondary hover uses panel strong; silver hover becomes white. Keyboard focus uses a 3px outline with a 3px offset, in focus blue on light surfaces and silver on dark chrome. Labels, constraints and disabled states remain visible; touch and keyboard access share the same controls.
- **Navigation and filters:** Desktop and bottom navigation select a silver-light destination inside midnight chrome, with midnight text and icons. Round filters use a pale blue-gray group with a raised white selected segment and a count badge. Preserve pressed, selected and current semantics. The competition navigation label is `Kilpailu`; the awards tab is `Palkinnot`.
- **Fixture board:** Kickoff/status, club identity, three 1X2 prices, own bet, submission count and optional-market disclosure appear in that order. Team crests are decorative beside names and fall back to a neutral shield. Selected odds use action blue, white prices, pale secondary labels and a checkmark; selected hover becomes midnight.
- **Saved and pending picks:** An unsubmitted pick shows `Odottaa jättämistä` in the status and `Valittu: … · odottaa jättämistä` below the odds. When editing a saved pick, retain the `Jätetty:` row and its existing stake, then show a separate `Uusi valinta:` row. The note reads `Jätetty veto pysyy voimassa, kunnes jätät muutoksen.` The selected button represents the pending choice; it must not imply that the server has saved it. Only a confirmed saved state uses `Jätetty` and its status checkmark.
- **Locked and unavailable markets:** Locked markets disable changes and expose the group's submitted bets. Unknown odds show `Kertoimet tulossa` and cannot be selected. Status colors always have text counterparts.
- **Reviewed slip:** The midnight floating summary and silver review action lead to a protected-focus white dialog with an explicit close control, Escape support, focus restoration and scroll containment. The dialog shows selections, stakes, funding and the final action together.
- **Tables and operational surfaces:** Use semantic standings tables, list-based player rankings, clear empty states and expandable admin tools. Network failures expose retry; retained data has an explicit stale notice and betting remains disabled until refresh succeeds. Provider identifiers stay in operational views where they help a decision.

## Do's and Don'ts

- Do use Pönnicup as the title, the official UEFA Champions League logo, and the midnight blue, white and silver palette.
- Do keep saved bets and pending changes visibly separate until the server confirms submission.
- Do preserve the compact layout, system font stack, mobile control targets and visible keyboard focus.
- Do use Finnish labels such as `Kierros`, `Pörssi`, `Kilpailu`, `Maalipörssi`, `Palkinnot`, `Oma pelikassa`, `Oma panos avoinna`, `Päiväbonus`, `Puuttuu`, `Jätetty`, `Lukittu` and `Palautettu`.
- Do write plain, factual Finnish labels and instructions; omit decorative taglines and promotional slogans.
- Don't introduce casino gloss, generic SaaS cards or decorative analytics.
- Don't convey selection, failure, lock or settlement through color alone.
- Don't fill missing data with invented fixtures, prices, results or balances.
