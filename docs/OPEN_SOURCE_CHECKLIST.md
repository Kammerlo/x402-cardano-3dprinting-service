# Open-source release checklist

This checklist concerns publishing the **repository**. It does not certify the hosted shop or payment/printer operations for production.

## Blocker: upstream code rights

`apps/web/src/cip30.ts` and `apps/web/src/payFlow.ts` explicitly state that they adapt code from `cardano-foundation/x402-cardano-demo`. At the time of this review, the upstream demo's repository metadata reports **no license** and no root LICENSE file. A public GitHub repository or source attribution alone does not grant permission to redistribute adapted code under this repository's MIT license. Before changing repository visibility, obtain explicit compatible permission from the upstream copyright holder, or replace the adapted implementation with independently written code and review it for remaining copied expression. Record the permission and any required notices in the repository. The `@x402/cardano` SDK is an npm dependency and a separate matter.

## Owner checks before publication

- Confirm the MIT license holder text and that the OpenSCAD/STL model and all other artwork, fonts, code and dependencies may be distributed as represented. Keep any third-party license notices required by their authors.
- Recheck **all refs**, branches, tags, PRs, Actions artifacts and the full reachable history for credentials and private data. This review scanned all 32 main-branch commit trees at the time of writing; it cannot certify inaccessible refs or provider-side secrets. Rotate any actual credential ever committed, even if later deleted.
- Enable GitHub private vulnerability reporting and update [the security policy](../SECURITY.md) with a reliable private contact. Enable secret scanning and push protection where available, and require passing CI/review on the default branch.
- Set repository description/topics, check issue and PR permissions, and review the public GitHub profile and author metadata for details you do not want to publish.
- For a **live shop**, validate preprod/mainnet, shipping/refunds, privacy and data retention, backups/restores, edge rate limits, monitoring, gateway journal recovery and printer supervision using [deployment](DEPLOYMENT.md) and [operations](OPERATIONS.md). Repository visibility does not make a live service production ready.

The checked-in `.env.example` files contain placeholders; runtime Worker and gateway values belong in provider secrets and an ignored local `.env.gateway`. Public `VITE_*` build values are bundled into browser JavaScript, so use a dedicated restricted Blockfrost project.
