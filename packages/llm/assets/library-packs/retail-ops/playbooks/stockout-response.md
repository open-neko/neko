---
type: Playbook
title: Stockout response
description: What to do when a selling SKU hits zero on hand.
tags: [inventory, operations]
---

# When this applies

A SKU with sales in the last 28 days reaches zero units on hand, or
[stock cover](../metrics/stock-cover.md) falls under 7 days.

# Steps

1. Confirm the count is real — check for unreceived purchase orders and
   pending returns before acting.
2. Check open purchase orders; if one covers the gap within 7 days, note
   the ETA and stop here.
3. Otherwise raise a reorder sized to restore 30 days of
   [stock cover](../metrics/stock-cover.md), and flag the supplier's
   current lead time.
4. If the SKU is promoted anywhere (ads, homepage, email), tell
   marketing the same day so spend is paused.

# Escalation

Repeated stockouts on the same SKU within a quarter go to the
operations lead as a supplier or forecasting problem, not a reorder
problem.
