# Web change notices and scoped reads

The web app uses one authenticated server-sent events connection for invalidation. Notices contain entity identifiers and a monotonically increasing revision. The browser reads the affected projections through TanStack Query; notices contain no entity payloads.

The server compares fingerprints of authorized read projections once per second. These projections combine persisted engine state with in-memory worker, polling, and configuration state. They reuse the operator's revision cache. A shared journal per effective permission set coalesces changes and retains the latest 256 notices. The server retains at most 16 permission journals. Reconnects use `Last-Event-ID`; a missing, expired, or future cursor receives a reset notice. A reset invalidates active reads. A heartbeat every 15 seconds keeps idle connections open. Journals belong to the server's route layer and end with it.

Navigation and attention reads omit board payloads. Navigation retains compact task identities for headings and notifications. Project reads supply boards. Settled lanes load cards in pages of 50; task run history loads in pages of 25. Both lists virtualize long histories. Command search loads its searchable projection when opened. Route loaders prefetch screen data, and intent preloading fetches task and run links on hover or focus.

Successful JSON reads have private ETags. Authorization precedes conditional response handling, and validators vary by browser credentials and read representation. Browsers revalidate cached reads without transferring an unchanged body. The stream disables caching and proxy buffering.

Connected screens have no interval polling. During disconnection, one app-wide timer invalidates active reads every 60 seconds. The refresh indicator reports disconnection. Board mutations add optimistic move state in `onMutate`, remove it on failure, and retain accepted moves until a changed project projection confirms GitHub state.
