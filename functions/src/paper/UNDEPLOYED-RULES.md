# Canonical paper v1 — isolated undeployed rules

NOT applied to `firestore.rules` or `storage.rules`.
NOT deployed. Paper bytes are served only through `getTicketPaper` /
`staffGetTicketPaper` / `staffMaterializeTicketPaper` after server-side
authorization.

## Firestore fragment (do not merge until authorized)

```
match /paper_artifacts/{artifactId} {
  allow read, write: if false;
  match /revisions/{revisionId} {
    allow read, write: if false;
  }
}
match /paper_source_events/{eventId} {
  allow read, write: if false;
}
match /paper_invoice_index/{invoiceDocId} {
  allow read, write: if false;
}
```

## Storage fragment (do not merge until authorized)

```
match /paper/{companyId}/{artifactId}/{revisionId}/{fileName} {
  allow read, write: if false;
}
match /paper/{companyId}/{artifactId}/{revisionId}/assets/{hash} {
  allow read, write: if false;
}
```
