# Local Ops V0

Current local-ops behavior:

- Builds macOS Keychain command previews for secret lookup and storage.
- Defines a strict safeguard policy with live trading disabled by default.
- Surfaces safeguard summary lines into the runtime snapshot for operator review.

Current limitation:

- Keychain commands are prepared locally but not executed automatically.
- Safeguards are modeled in code but not yet editable from the desktop settings surface.
