# Migrations

`00000000000000_init` is a baseline: it was generated from the schema as it
stood when migrations were adopted, and marked applied rather than run, because
the database it was taken from already had that shape. A fresh database runs it
normally and ends up in the same place.

## Working with the schema

```
npm run db:migrate     # edit schema.prisma, then this — creates a migration
npm run db:deploy      # apply pending migrations (bootstrap, CI, deploys)
npm run db:status      # what is applied and what is pending
```

`npm run db:push` is still there and still useful for throwaway experiments, but
it does not record what it did. Anything that needs to reach another environment
has to be a migration — including data repair. The unique constraint on
`DeviceSession(applicantId, fingerprint)` needed 29 duplicate rows removed before
it could be added; that kind of step belongs in a migration file rather than in
someone's shell history.
