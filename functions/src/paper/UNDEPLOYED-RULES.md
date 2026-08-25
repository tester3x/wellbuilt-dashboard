# Canonical paper v1 — isolated undeployed rules

NOT applied to `firestore.rules` or `storage.rules`.
NOT deployed. Prefer governed callables (`staffGetTicketPaper`, `staffMaterializeTicketPaper`)
over any client read of paper bytes.

## Firestore fragment (do not merge until authorized)

```
match /paper_artifacts/{artifactId} {
  allow read, write: if false;
  match /revisions/{revisionId} {
    allow read, write: if false;
  }
}
```

## Storage fragment (do not merge until authorized)

```
match /paper/{companyId}/{artifactId}/{revisionId}/document.html {
  allow read, write: if false;
}
match /paper/{companyId}/{artifactId}/{revisionId}/{fileName} {
  allow read, write: if false;
}
```

Admin SDK callables bypass these denials. Clients receive HTML only through
`staffGetTicketPaper` after server-side company authorization.
