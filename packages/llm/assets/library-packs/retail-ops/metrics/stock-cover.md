---
type: Metric definition
title: Stock cover
description: Days of inventory remaining at the current run rate.
tags: [inventory, operations]
---

# Definition

Stock cover (days) = units on hand ÷ average daily units sold over the
trailing 28 days.

- Compute per SKU, then aggregate by category as a weighted average.
- Exclude discontinued SKUs from category aggregates.
- New SKUs with under 14 days of history use category-average velocity.

# Thresholds

- Under 14 days: reorder review.
- Under 7 days: urgent — flag to operations.
- Over 120 days: overstock review for markdown or bundling.
