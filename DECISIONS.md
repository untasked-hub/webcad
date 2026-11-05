# Project decisions

## Blueprint and rationale
- Blueprint: `static`
- Rationale: Preserve existing MIT-licensed Express/Node CAD app, rather than replacing its implementation; static is a catalog placeholder, not the actual architecture.

## Runtimes and versions
- (record exact versions after install)

## Data, storage and deploy
- Data: PostgreSQL existing app implementation; independent database.
- Deploy: Node 20 container on hosted app

## UI kit, icons and tokens
- UI kit: none
- Icon family: none
- Tokens: follow the starter design tokens; adapt identity to the product.

## Capabilities and licenses
- Express
- PostgreSQL
- 2D canvas

## Contracts and exceptions
- Existing fork preserved rather than replacing with starter.
- Existing Node Express stack rather than static blueprint.

## Validation and known limitations
- Validation: Preview, health and live front check
- Limitations: Existing drawings are not copied.
- Guides in use:
- untasked-deploy-contract

## Next delivery
Hosted WebCAD
