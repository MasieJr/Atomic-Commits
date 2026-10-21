# Atomic Commits

Open Payments hackathon prototype for offline-capable delegated payments.

The current demo is a static proof of concept showing a buyer-generated, short-lived payment authorization that a merchant can verify and settle over Open Payments.

## Demo

This repository is intended to be published with GitHub Pages from the `main` branch, repository root.

## Current direction

- one payer ↔ Atomic Commits setup relationship, rather than pairing with every shop
- portable payer alias + offline-generated verification code
- short-lived authorization, up to 30 minutes
- single-use redemption / replay rejection
- merchant supplies the eventual Open Payments recipient at redemption
- paper is only one possible transport; QR, SMS and human-readable codes are also possible

Hackathon work in progress.
